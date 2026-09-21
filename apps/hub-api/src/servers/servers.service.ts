import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { z } from "zod";
import { Prisma, Role, ServerStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
// Type-only import (erased at build) + a string DI token resolved lazily via
// ModuleRef, so there is no static edge servers.service → applications.service.
// A value import WOULD create a require cycle: applications.service imports
// AgentWsServer, which imports ServersService.
import type { ApplicationsService } from "../applications/applications.service";
import { APPLICATIONS_SERVICE } from "../applications/applications.tokens";
import type { TunnelService } from "../tunnel/tunnel.service";
import { TUNNEL_SERVICE } from "../tunnel/tunnel.tokens";
import type { ProvisioningService } from "../cloud/provisioning.service";
import { PROVISIONING_SERVICE } from "../cloud/cloud.tokens";
import {
  generateEnrollToken,
  generateSeal,
  verifyEd25519,
} from "./agent-auth";
import { normalizeTags } from "../common/tags";
import { isIpv6, isLoopbackIp, isPublicIp, reconcileReportedIp } from "../common/observed-ip";
import type { NetworkSettingsInput } from "./dto/servers.schemas";

const ENROLL_TTL_MS = 60 * 60 * 1000; // 1 hour
// The capabilities a NEW server is granted by default — everything except `terminal`
// (interactive shell), which is opt-in (least privilege). Legacy servers were backfilled
// to the full set by the migration, so an empty grant now safely means "deny all" (fail-safe).
const DEFAULT_CAPABILITIES = ["deploy", "database", "backup", "cleanup", "bulk", "schedule", "patch", "logs"];
// "swarm" (Docker Swarm formation) is opt-in like "terminal": granted explicitly per server, NEVER in
// DEFAULT_CAPABILITIES and never backfilled — joining a swarm changes a box's trust topology (it accepts
// raft/gossip that can affect other nodes), a bigger step than deploying one app on it.
const ALL_CAPABILITIES = ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs", "swarm"];

export const ServerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.nativeEnum(ServerStatus),
  teamId: z.string(),
  clusterId: z.string().nullable(), // the cluster this server belongs to (null = standalone)
  clusterName: z.string().nullable(), // resolved for the detail view; null in list views
  hostname: z.string().nullable(),
  publicIp: z.string().nullable(),
  publicIpv6: z.string().nullable(),
  ipSource: z.string(),
  wildcardDomain: z.string().nullable(),
  magicSuffix: z.string().nullable(),
  certMode: z.string(),
  dnsProvider: z.string().nullable(),
  customCertResolver: z.string().nullable(),
  hasDnsCreds: z.boolean(), // whether DNS-01 creds are configured — the creds are NEVER returned
  os: z.string().nullable(),
  osVersion: z.string().nullable(),
  arch: z.string().nullable(),
  kernel: z.string().nullable(),
  agentVersion: z.string().nullable(), // the running agent's reported version (refreshed on reconnect)
  cpuCores: z.number().nullable(),
  memTotalBytes: z.string().nullable(), // BigInt serialized
  uptimeSeconds: z.number().nullable(), // derived from bootTime
  cleanupEnabled: z.boolean(),
  cleanupIntervalHours: z.number().nullable(),
  cleanupVolumes: z.boolean(),
  lastCleanupAt: z.date().nullable(),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
  seal: z.string().nullable(),
  tags: z.array(z.string()),
  capabilities: z.array(z.string()), // granted agent capabilities the hub may act on; [] = none (fail-safe)
  provider: z.string().nullable(), // cloud provider that created this VM (null = manually enrolled)
  providerServerId: z.string().nullable(), // provider-side id (present once created; enables destroy-VM)
  canWrite: z.boolean(),
});
export type ServerView = z.infer<typeof ServerViewSchema>;

export interface HostInfoInput {
  os: string;
  osVersion: string;
  arch: string;
  kernel: string;
  cpuCores: number;
  memTotalBytes: number;
  bootTime: number; // unix seconds
  reportedIps?: string[];
}

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly moduleRef: ModuleRef,
    private readonly crypto: CryptoService,
    private readonly access: TeamAccessService,
  ) {}

  // ---- REST (operator-facing) ---------------------------------------------

  async createServer(
    userId: string,
    name: string,
    teamId: string,
    publicUrl?: string,
    provisioning?: { provider: string; cloudCredentialId: string },
  ): Promise<{ server: ServerView; enrollToken: string; installCommand: string }> {
    await this.access.requirePermission(userId, teamId, "servers:manage");

    const enrollToken = generateEnrollToken();
    const created = await this.prisma.server.create({
      data: {
        name,
        teamId,
        enrollToken,
        enrollTokenExpiresAt: new Date(Date.now() + ENROLL_TTL_MS),
        status: ServerStatus.PENDING,
        capabilities: DEFAULT_CAPABILITIES, // least privilege: no terminal by default
        // Set only for cloud-provisioned servers, so a later delete can destroy the VM.
        ...(provisioning ? { provider: provisioning.provider, cloudCredentialId: provisioning.cloudCredentialId } : {}),
      },
    });
    await this.audit.log({
      actor: userId,
      action: "server.create",
      target: created.id,
    });

    return {
      server: this.toView(created, true),
      enrollToken,
      installCommand: this.buildInstallCommand(enrollToken, publicUrl),
    };
  }

  /** The one-line agent install command. A `curl | sh` bootstrap that fetches the agent installer from
   *  this hub and runs it with the ws URL + enroll token embedded (the installer pulls the version-matched
   *  agent image and runs it as a Docker container). The hub enforces every capability grant afresh before
   *  signing a command, so the agent needs no local allowlist snapshot (the hub is the sole gate). */
  private buildInstallCommand(token: string, publicUrl?: string): string {
    return `curl -fsSL ${this.hubBaseUrl(publicUrl)}/install/agent.sh | sh -s -- --hub ${this.agentWsUrl(publicUrl)} --token ${token}`;
  }

  /**
   * The install command for an EXISTING server, so the PENDING enroll state can
   * live at a stable /servers/[id] URL (refresh-safe, recoverable). The embedded
   * enroll token is only revealed to a team writer while the server is PENDING
   * and the token has not expired — never via the normal getServer payload.
   */
  async getInstall(
    userId: string,
    id: string,
    publicUrl?: string,
  ): Promise<{ status: ServerStatus; installCommand: string | null; expiresAt: Date | null }> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const valid =
      server.status === ServerStatus.PENDING &&
      !!server.enrollToken &&
      !!server.enrollTokenExpiresAt &&
      server.enrollTokenExpiresAt.getTime() > Date.now();
    return {
      status: server.status,
      installCommand: valid ? this.buildInstallCommand(server.enrollToken!, publicUrl) : null,
      expiresAt: server.enrollTokenExpiresAt,
    };
  }

  /** Mint a fresh enroll token for a still-PENDING server (recover an expired/lost command). */
  async reissueEnroll(
    userId: string,
    id: string,
    publicUrl?: string,
  ): Promise<{ installCommand: string; expiresAt: Date }> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    if (server.status !== ServerStatus.PENDING) {
      throw new ConflictException("server already enrolled");
    }
    const enrollToken = generateEnrollToken();
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS);
    await this.prisma.server.update({
      where: { id },
      data: { enrollToken, enrollTokenExpiresAt: expiresAt },
    });
    await this.audit.log({ actor: userId, action: "server.enroll.reissue", target: id });
    return { installCommand: this.buildInstallCommand(enrollToken, publicUrl), expiresAt };
  }

  /**
   * The hub's public HTTP(S) base URL (no trailing slash). Prefers the configured HUB_PUBLIC_URL,
   * else the request's public host, else localhost. The curl bootstrap fetches the installer from here.
   */
  private hubBaseUrl(publicUrl?: string): string {
    const port = process.env.HUB_PORT ?? "3000";
    const base = process.env.HUB_PUBLIC_URL ?? publicUrl ?? `http://localhost:${port}`;
    return base.replace(/\/+$/, "");
  }

  /**
   * The ws(s) URL the agent should dial — the HTTP base mapped http→ws/https→wss, plus `/agent`.
   */
  private agentWsUrl(publicUrl?: string): string {
    return `${this.hubBaseUrl(publicUrl).replace(/^http/i, "ws")}/agent`;
  }

  /** The teams the user belongs to (for team pickers, command-center scoping). */
  async listTeamsForUser(
    userId: string,
  ): Promise<{ id: string; name: string; role: Role }[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { team: true },
    });
    return memberships.map((m) => ({
      id: m.team.id,
      name: m.team.name,
      role: m.role,
    }));
  }

  /** Cross-team: every server across ALL the user's team memberships. */
  async listForUser(
    userId: string,
    filter?: { teamId?: string; status?: ServerStatus },
  ): Promise<ServerView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const teamIds = [...permsByTeam.keys()];
    if (teamIds.length === 0) return [];

    const servers = await this.prisma.server.findMany({
      where: {
        teamId: filter?.teamId
          ? filter.teamId
          : { in: teamIds },
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return servers
      .filter((s) => permsByTeam.has(s.teamId))
      .map((s) => this.toView(s, permsByTeam.get(s.teamId)?.has("servers:manage") ?? false));
  }

  async getForUser(userId: string, id: string): Promise<ServerView> {
    const server = await this.prisma.server.findUnique({
      where: { id },
      include: { cluster: { select: { name: true } } },
    });
    if (!server) throw new NotFoundException("server not found");
    const perms = await this.access.membershipPermissions(userId, server.teamId);
    if (!perms) throw new ForbiddenException("not a member of this team");
    return this.toView(server, perms.has("servers:manage"));
  }

  async deleteForUser(userId: string, id: string, opts?: { destroyVm?: boolean }): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    // Refuse to delete a server that is still a node in a cluster's Docker Swarm — that would leave a live
    // swarm node running with no Tugra record (and dangle Cluster.swarmManagerId if it's the manager).
    // Dissolve the swarm (or leave the node) first.
    if (server.swarmRole) {
      throw new ConflictException("this server is part of a cluster's swarm; dissolve it (or leave the node) first");
    }
    // Release any Cloudflare Tunnel resources BEFORE the cascade drops the row, so a deleted
    // server never leaks a live CF tunnel + wildcard CNAME. Best-effort; lazy token avoids a cycle.
    await this.moduleRef
      .get<TunnelService>(TUNNEL_SERVICE, { strict: false })
      .releaseResources(id)
      .catch(() => undefined);
    // Destroy the cloud VM too when asked — only for provider-created servers, and best-effort so a
    // provider failure never blocks removing the row (lazy token avoids a static module cycle).
    if (opts?.destroyVm && server.provider && server.providerServerId && server.cloudCredentialId) {
      await this.moduleRef
        .get<ProvisioningService>(PROVISIONING_SERVICE, { strict: false })
        .destroyVm(server.provider, server.cloudCredentialId, server.providerServerId)
        .catch(() => undefined);
    }
    await this.prisma.server.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "server.delete", target: id, meta: { destroyVm: !!opts?.destroyVm } });
  }

  async setTags(userId: string, id: string, tags: string[]): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    await this.prisma.server.update({
      where: { id },
      data: { tags: normalizeTags(tags) },
    });
    await this.audit.log({ actor: userId, action: "server.tags.update", target: id });
  }

  /** The set of agent capabilities the hub is allowed to sign commands for on this server.
   *  The stored set is enforced verbatim; [] = none (fail-safe). Legacy servers were backfilled
   *  to the full set by the migration, so [] never silently means "all". */
  async grantedCapabilities(serverId: string): Promise<string[]> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { capabilities: true } });
    return server?.capabilities ?? [];
  }

  // Callback set by AgentWsServer at boot to push a capability change to a connected agent, so its
  // fail-closed allowlist updates live. Kept as a callback (not a direct injection) to avoid a
  // servers→agentWs require cycle — agentWs already depends on ServersService.
  private capabilityPusher?: (serverId: string, capabilities: string[]) => void;

  setCapabilityPusher(fn: (serverId: string, capabilities: string[]) => void): void {
    this.capabilityPusher = fn;
  }

  /** Set the granted capabilities (least-privilege toggle). Deduped + restricted to the known
   *  capability set and stored verbatim — an empty set means deny-all (fail-safe), NOT "all",
   *  so unchecking everything can never invert into granting everything. */
  async setCapabilities(userId: string, id: string, capabilities: string[]): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const next = [...new Set(capabilities)].filter((c) => ALL_CAPABILITIES.includes(c));
    await this.prisma.server.update({ where: { id }, data: { capabilities: next } });
    // Live-push the new set to the connected agent (fail-closed allowlist updates immediately).
    this.capabilityPusher?.(id, next);
    await this.audit.log({ actor: userId, action: "server.capabilities.update", target: id });
  }

  /**
   * Per-server network settings: pin a manual public IP (or clear it to resume
   * observing), and set the magic-domain wildcard root / suffix. A manual IP sets
   * ipSource="manual" so agent observations never clobber it; clearing it (null)
   * hands control back to observation. Any change regenerates the server's magic
   * domains so existing apps follow the new IP/wildcard.
   */
  async setNetwork(userId: string, id: string, cfg: NetworkSettingsInput): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");

    const data: Prisma.ServerUpdateInput = {};
    if (cfg.wildcardDomain !== undefined) data.wildcardDomain = cfg.wildcardDomain;
    if (cfg.magicSuffix !== undefined) data.magicSuffix = cfg.magicSuffix;

    // Normalize "" → null so an empty string never persists (it would shadow a
    // valid publicIpv6 via ?? in serverIp() and break the app URL).
    const v4 = cfg.publicIp === undefined ? undefined : cfg.publicIp || null;
    const v6 = cfg.publicIpv6 === undefined ? undefined : cfg.publicIpv6 || null;
    if (v4 !== undefined) {
      if (v4 && !isPublicIp(v4)) throw new BadRequestException("public IP must be a globally routable address");
      data.publicIp = v4;
    }
    if (v6 !== undefined) {
      if (v6 && !isPublicIp(v6)) throw new BadRequestException("public IPv6 must be a globally routable address");
      data.publicIpv6 = v6;
    }
    // ipSource is a single manual/observed flag guarding BOTH families (ipFields /
    // reconcileReportedIp bail out only when it is "manual"). Any non-null pin in
    // this call flips it to "manual" — including a v6-only pin — so observations
    // never clobber a curated address; clearing all touched IP fields resumes
    // observation. (Clearing only v4 while a v6 pin exists is a narrow API-only
    // edge that resumes observation for both — the web UI only pins v4.)
    if (v4 !== undefined || v6 !== undefined) {
      data.ipSource = v4 || v6 ? "manual" : "observed";
    }

    // Wildcard-cert policy + DNS-01 provider. dnsCreds are encrypted at rest and
    // never round-tripped (the plaintext never reaches the DB or a response).
    if (cfg.certMode !== undefined) data.certMode = cfg.certMode;
    if (cfg.dnsProvider !== undefined) data.dnsProvider = cfg.dnsProvider;
    if (cfg.customCertResolver !== undefined) data.customCertResolver = cfg.customCertResolver;
    if (cfg.dnsCreds !== undefined) {
      data.dnsCredsEnc =
        cfg.dnsCreds && Object.keys(cfg.dnsCreds).length > 0
          ? this.crypto.encrypt(JSON.stringify(cfg.dnsCreds))
          : null;
    }

    await this.prisma.server.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "server.network.update", target: id });
    // The IP/wildcard drives magic domains — refresh them so live apps follow.
    // Lazy lookup by string token avoids a module/require cycle (see import note).
    await this.moduleRef
      .get<ApplicationsService>(APPLICATIONS_SERVICE, { strict: false })
      .regenerateMagicForServer(id)
      .catch(() => undefined);
  }

  // ---- agent transport (called by the WS server) --------------------------

  /**
   * Update fields for a freshly observed source IP. No-op when there's no IP or
   * the operator has manually pinned the server's address (so an observation
   * never clobbers a manual override).
   */
  private ipFields(observed: string | null | undefined, currentIpSource: string): Prisma.ServerUpdateInput {
    if (!observed || currentIpSource === "manual") return {};
    if (isLoopbackIp(observed)) return {}; // a loopback egress is not a reachable address
    return isIpv6(observed)
      ? { publicIpv6: observed }
      : { publicIp: observed, ipSource: "observed" };
  }

  async enroll(input: {
    token: string;
    publicKey: string;
    agentVersion: string;
    hostname: string;
    observedIp?: string | null;
  }): Promise<{ serverId: string; seal: string }> {
    const server = await this.prisma.server.findUnique({
      where: { enrollToken: input.token },
    });
    if (
      !server ||
      server.status !== ServerStatus.PENDING ||
      !server.enrollTokenExpiresAt ||
      server.enrollTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException("invalid or expired enroll token");
    }

    const seal = generateSeal();
    await this.prisma.server.update({
      where: { id: server.id },
      data: {
        seal,
        agentPublicKey: input.publicKey,
        agentVersion: input.agentVersion,
        hostname: input.hostname,
        status: ServerStatus.ONLINE,
        lastSeenAt: new Date(),
        ...this.ipFields(input.observedIp, server.ipSource),
      },
    });
    await this.audit.log({
      actor: `server:${server.id}`,
      action: "agent.enroll",
      target: server.id,
    });
    return { serverId: server.id, seal };
  }

  async authenticate(
    serverId: string,
    nonce: string,
    signature: string,
    observedIp?: string | null,
    agentVersion?: string,
  ): Promise<boolean> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
    });
    if (!server?.agentPublicKey) return false;
    if (!verifyEd25519(server.agentPublicKey, nonce, signature)) return false;
    // Refresh online status + the observed IP in one write (reconnect may bring a new address — a dynamic
    // IP is tracked on every auth). Also refresh agentVersion when the agent reports one (only on enroll
    // before this): a self-updated agent reconnects via auth, so this is how the new version becomes
    // visible. Store verbatim; never blank an existing value from an older agent that omits it.
    const extra = this.ipFields(observedIp, server.ipSource);
    if (agentVersion) extra.agentVersion = agentVersion;
    await this.markOnline(serverId, extra);
    return true;
  }

  async markOnline(serverId: string, extra: Prisma.ServerUpdateInput = {}): Promise<void> {
    // Read the prior status so we can notify ONLY on a real OFFLINE→ONLINE recovery edge. markOnline
    // runs on every reconnect/auth (and the periodic touch path), so firing unconditionally would spam
    // one "server online" per authentication. enroll writes ONLINE via its own update (never markOnline),
    // so a first enrollment is not reported as a recovery. A concurrent double-auth racing the same edge
    // is a cosmetic best-effort dup, not correctness.
    const prev = await this.prisma.server.findUnique({ where: { id: serverId }, select: { status: true } });
    const s = await this.prisma.server.update({
      where: { id: serverId },
      data: { status: ServerStatus.ONLINE, lastSeenAt: new Date(), ...extra },
    });
    if (prev?.status === ServerStatus.OFFLINE) {
      this.notifications
        .fireForEvent(s.teamId, "server_online", {
          serverId: s.id,
          serverName: s.name,
          hostname: s.hostname ?? "",
          publicIp: s.publicIp ?? "",
        })
        .catch(() => {});
    }
  }

  async markOffline(serverId: string): Promise<void> {
    const s = await this.prisma.server
      .update({
        where: { id: serverId },
        data: { status: ServerStatus.OFFLINE },
      })
      .catch(() => undefined);
    if (s) {
      this.notifications
        .fireForEvent(s.teamId, "server_offline", {
          serverId: s.id,
          serverName: s.name,
          hostname: s.hostname ?? "",
          lastSeenAt: s.lastSeenAt?.toISOString() ?? "",
          publicIp: s.publicIp ?? "",
        })
        .catch(() => {});
    }
  }

  async touch(serverId: string): Promise<void> {
    await this.prisma.server
      .update({ where: { id: serverId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  /** Store/refresh the host hardware+OS inventory (sent on every (re)connect). */
  async saveHostInfo(serverId: string, info: HostInfoInput): Promise<void> {
    const reportedIps = info.reportedIps ?? [];
    // Reconcile the reported interface IPs against the observed egress: adopt one
    // when the observed IP is missing/loopback (never overriding a manual pin).
    // Best-effort like the update below: a read blip must never throw and tear
    // down the agent connection (host_info arrives on every reconnect).
    const server = await this.prisma.server
      .findUnique({ where: { id: serverId }, select: { publicIp: true, ipSource: true } })
      .catch(() => null);
    const reconcile = server ? reconcileReportedIp(server, reportedIps) : null;
    await this.prisma.server
      .update({
        where: { id: serverId },
        data: {
          os: info.os || null,
          osVersion: info.osVersion || null,
          arch: info.arch || null,
          kernel: info.kernel || null,
          cpuCores: info.cpuCores || null,
          memTotalBytes: info.memTotalBytes ? BigInt(Math.round(info.memTotalBytes)) : null,
          bootTime: info.bootTime ? new Date(info.bootTime * 1000) : null,
          reportedIps,
          ...(reconcile ?? {}),
        },
      })
      .catch(() => undefined);
  }

  // ---- helpers ------------------------------------------------------------

  private toView(
    s: {
      id: string;
      name: string;
      status: ServerStatus;
      teamId: string;
      clusterId?: string | null;
      cluster?: { name: string } | null;
      hostname: string | null;
      publicIp?: string | null;
      publicIpv6?: string | null;
      ipSource?: string;
      wildcardDomain?: string | null;
      magicSuffix?: string | null;
      certMode?: string;
      dnsProvider?: string | null;
      customCertResolver?: string | null;
      dnsCredsEnc?: string | null;
      os?: string | null;
      osVersion?: string | null;
      arch?: string | null;
      kernel?: string | null;
      agentVersion?: string | null;
      cpuCores?: number | null;
      memTotalBytes?: bigint | null;
      bootTime?: Date | null;
      cleanupEnabled?: boolean;
      cleanupIntervalHours?: number | null;
      cleanupVolumes?: boolean;
      lastCleanupAt?: Date | null;
      lastSeenAt: Date | null;
      createdAt: Date;
      seal: string | null;
      tags?: string[];
      capabilities?: string[];
      provider?: string | null;
      providerServerId?: string | null;
    },
    canWrite: boolean,
  ): ServerView {
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      teamId: s.teamId,
      clusterId: s.clusterId ?? null,
      clusterName: s.cluster?.name ?? null,
      hostname: s.hostname,
      publicIp: s.publicIp ?? null,
      publicIpv6: s.publicIpv6 ?? null,
      ipSource: s.ipSource ?? "observed",
      wildcardDomain: s.wildcardDomain ?? null,
      magicSuffix: s.magicSuffix ?? null,
      certMode: s.certMode ?? "http",
      dnsProvider: s.dnsProvider ?? null,
      customCertResolver: s.customCertResolver ?? null,
      hasDnsCreds: !!s.dnsCredsEnc,
      os: s.os ?? null,
      osVersion: s.osVersion ?? null,
      arch: s.arch ?? null,
      kernel: s.kernel ?? null,
      agentVersion: s.agentVersion ?? null,
      cpuCores: s.cpuCores ?? null,
      memTotalBytes: s.memTotalBytes != null ? s.memTotalBytes.toString() : null,
      uptimeSeconds: s.bootTime
        ? Math.max(0, Math.floor((Date.now() - s.bootTime.getTime()) / 1000))
        : null,
      cleanupEnabled: s.cleanupEnabled ?? false,
      cleanupIntervalHours: s.cleanupIntervalHours ?? null,
      cleanupVolumes: s.cleanupVolumes ?? false,
      lastCleanupAt: s.lastCleanupAt ?? null,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      seal: s.seal,
      tags: s.tags ?? [],
      capabilities: s.capabilities ?? [],
      provider: s.provider ?? null,
      providerServerId: s.providerServerId ?? null,
      canWrite,
    };
  }
}
