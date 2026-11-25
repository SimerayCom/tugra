import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Subject, type Observable } from "rxjs";
import { z } from "zod";
import { Prisma, Role, ServerStatus } from "@prisma/client";
import { DEFAULT_CLEANUP_DATA } from "../server-ops/cleanup-defaults";
import { AGENT_CAPABILITIES } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, type AuditFilters } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
// Type-only import (erased at build) + a string DI token resolved lazily via
// ModuleRef, so there is no static edge servers.service → applications.service.
// A value import WOULD create a require cycle: applications.service imports
// AgentWsServer, which imports ServersService.
import type { ApplicationsService } from "../applications/applications.service";
import { AGENT_ENDPOINTS_SERVICE, APPLICATIONS_SERVICE, PROXY_SERVICE } from "../applications/applications.tokens";
import type { AgentEndpointsService } from "../applications/agent-endpoints.service";
import type { TunnelService } from "../tunnel/tunnel.service";
import { TUNNEL_SERVICE } from "../tunnel/tunnel.tokens";
import type { ProvisioningService } from "../cloud/provisioning.service";
import { PROVISIONING_SERVICE } from "../cloud/cloud.tokens";
import type { MonitorsService } from "../monitors/monitors.service";
import { MONITORS_SERVICE } from "../monitors/monitors.tokens";
import {
  generateEnrollToken,
  generateSeal,
  verifyEd25519,
} from "./agent-auth";
import { normalizeTags } from "../common/tags";
import { hubBaseUrl, agentWsUrl } from "../common/hub-url";
import { isIP } from "node:net";
import { isIpv6, isPublicIp, reconcileObservedIp, reconcileReportedIp, type HostIpState } from "../common/observed-ip";
import { filterByQuery } from "../common/query-filter";
import { dnsCredsIssue, trimDnsCreds } from "../common/dns-creds";
import { dnsProviderEnvCreds } from "../deploy/panel-router";
import type { ProxyService } from "../applications/proxy.service";
import type { NetworkSettingsInput } from "./dto/servers.schemas";
import { MAX_BULK_SERVERS } from "./dto/servers.schemas";
import { cleanCloudHint } from "../costs/cost-size";

const ENROLL_TTL_MS = 60 * 60 * 1000; // 1 hour
// The capabilities a NEW server is granted by default — everything except `terminal`
// (interactive shell), which is opt-in (least privilege). Legacy servers were backfilled
// to the full set by the migration, so an empty grant now safely means "deny all" (fail-safe).
export const DEFAULT_CAPABILITIES = ["deploy", "database", "backup", "cleanup", "bulk", "schedule", "patch", "logs"];
// "swarm" (Docker Swarm formation) is opt-in like "terminal": granted explicitly per server, NEVER in
// DEFAULT_CAPABILITIES and never backfilled — joining a swarm changes a box's trust topology (it accepts
// raft/gossip that can affect other nodes), a bigger step than deploying one app on it.
// "files" (read/list/download an app volume via the sandboxed fsd helper) is likewise opt-in and
// default-OFF: it exposes application data, so an operator must grant it explicitly per server.
// "files_write" (upload/create/edit/rename/chmod/delete on app volumes, plus container-FS writes) is a further
// opt-in on top of "files": NEVER in DEFAULT_CAPABILITIES and never backfilled — it runs a read-write helper.
// The full grantable set is the shared AGENT_CAPABILITIES source of truth (same list the grant-API schema
// validates against — they can't drift). DEFAULT_CAPABILITIES above is the least-privilege subset.
const ALL_CAPABILITIES: readonly string[] = AGENT_CAPABILITIES;

/** The opt-in capabilities the bulk grant/revoke endpoint may touch — everything else stays a per-server decision. */
export const BULK_GRANTABLE: readonly string[] = ["terminal", "files", "files_write", "swarm"];

export type BulkCapabilityResult =
  | { id: string; ok: true; capabilities: string[]; granted: string[]; revoked: string[] }
  | { id: string; ok: false; error: "not_found" | "forbidden" | "files_write_requires_files" | "failed" };

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
  ipSource: z.string(), // where publicIp came from: manual | reported (network interface) | metadata (cloud) | observed
  ipv6Source: z.string(), // same, for publicIpv6 (the two families are reconciled separately)
  reportedIps: z.array(z.string()), // every address the host reports (interfaces + cloud metadata), IPv4 and IPv6: the "all IPs" list
  nameAuto: z.boolean(), // the name was left blank at Add server and is replaced by the host's real hostname once the agent connects
  wildcardDomain: z.string().nullable(),
  magicSuffix: z.string().nullable(),
  certMode: z.string(),
  dnsProvider: z.string().nullable(),
  customCertResolver: z.string().nullable(),
  dnsCredentialId: z.string().nullable(), // team DnsCredential whose token was copied into the DNS-01 creds (null = typed by hand / none)
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
  cleanupCron: z.string().nullable(),
  cleanupThresholdPct: z.number().nullable(),
  cleanupVolumes: z.boolean(),
  description: z.string().nullable(),
  timezone: z.string().nullable(),
  lastCleanupAt: z.date().nullable(),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
  seal: z.string().nullable(),
  tags: z.array(z.string()),
  capabilities: z.array(z.string()), // granted agent capabilities the hub may act on; [] = none (fail-safe)
  isLocal: z.boolean(), // the box the hub itself runs on (auto-provisioned at first-owner reg on a turnkey install)
  proxyBind: z.string(), // how the reverse proxy publishes :80/:443 — "public" | "loopback" | "none"
  trafficAnalytics: z.boolean(), // Traffic Analytics: the proxy writes a JSON access log (default on for new servers; per-server toggle)
  provider: z.string().nullable(), // cloud provider that created this VM (null = manually enrolled)
  providerServerId: z.string().nullable(), // provider-side id (present once created; enables destroy-VM)
  providerManualLink: z.boolean(), // true = an operator linked an existing VM (out-of-band only; never destroyed by Tugra)
  exposedServices: z.number().int().min(0).nullable(), // public data-store / admin-UI / Docker API ports in the last server scan (null = never scanned or scanned before the check existed)
  canWrite: z.boolean(),
  canOps: z.boolean(), // servers:ops — may run host operations (e.g. re-run GPU detection); gates those UI actions
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
  /** The HOST's hostname (agent >= beta.25 reads it from the Docker daemon; the agent's own is its container id). */
  hostname?: string;
  /** Public addresses the cloud provider's link-local metadata service reports (agent probes 169.254.169.254, never the internet). */
  metadataIps?: string[];
  cloudProvider?: string;
}

/** Placeholder name of a server added without one; replaced by the host's real hostname when its agent connects. */
export const UNNAMED_SERVER = "New server";

/** RFC 1123 hostname (labels of letters/digits/hyphens, dot-separated, <= 253 chars). */
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** A plain `ws://` hub on a host that leaves the machine / docker network (not localhost, not a single-label compose name)
 *  must be opted into explicitly — the agent refuses it otherwise. */
export function plainWsNeedsOptIn(hubUrl: string): boolean {
  try {
    const u = new URL(hubUrl);
    if (u.protocol !== "ws:") return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost") return false;
    if (h.includes(":")) return h !== "::1"; // IPv6 literal: loopback only
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return !h.startsWith("127."); // IPv4 literal: loopback only
    return h.includes("."); // a single-label name is a compose service on the docker network
  } catch {
    return false;
  }
}

/** How often changed `lastSeenAt` values are written (one statement for all servers). The panel's "Last seen"
 *  therefore lags by up to this interval on raw DB reads; REST server views overlay the in-memory value. Liveness
 *  never depended on it: online/offline is decided by the agent socket (ws ping/pong), and the web's "stale" dot
 *  allows 90 s. */
export const LAST_SEEN_FLUSH_MS = 30_000;
/** A server confirmed ONLINE by this process is not re-checked by healOnline for this long. Only this process
 *  writes the status (and markOffline clears the confirmation), so the re-check is defence in depth. */
export const HEAL_RECHECK_MS = 5 * 60_000;

@Injectable()
export class ServersService implements OnModuleInit, OnModuleDestroy {
  // serverId -> newest heartbeat/auth time (ms) not yet written to Server.lastSeenAt.
  private readonly lastSeen = new Map<string, number>();
  private readonly lastSeenDirty = new Set<string>();
  private lastSeenTimer?: ReturnType<typeof setInterval>;
  private lastSeenClosed = false;
  // serverId -> when this process last saw/wrote status ONLINE for it (see HEAL_RECHECK_MS).
  private readonly confirmedOnline = new Map<string, number>();

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
    name: string | undefined,
    teamId: string,
    publicUrl?: string,
    provisioning?: { provider: string; cloudCredentialId: string },
  ): Promise<{ server: ServerView; enrollToken: string; installCommand: string }> {
    await this.access.requirePermission(userId, teamId, "servers:manage");
    return this.insertServer(userId, name?.trim() || null, teamId, publicUrl, provisioning);
  }

  /** Insert ONE PENDING server (its own enroll token + install command) and audit it. Assumes the caller
   *  already checked servers:manage on the team — so createServer (single) and createServersBulk (many)
   *  share one create path and the bulk endpoint can check the permission just once. */
  private async insertServer(
    userId: string,
    name: string | null, // null = left blank: a placeholder until the agent reports the host's real hostname
    teamId: string,
    publicUrl?: string,
    provisioning?: { provider: string; cloudCredentialId: string },
  ): Promise<{ server: ServerView; enrollToken: string; installCommand: string }> {
    const enrollToken = generateEnrollToken();
    const created = await this.prisma.server.create({
      data: {
        name: name ?? UNNAMED_SERVER,
        nameAuto: name === null,
        teamId,
        enrollToken,
        enrollTokenExpiresAt: new Date(Date.now() + ENROLL_TTL_MS),
        status: ServerStatus.PENDING,
        capabilities: DEFAULT_CAPABILITIES, // least privilege: no terminal by default
        // Disk hygiene on by default (Coolify parity): daily scoped prune + a run whenever disk reaches 80%.
        // Rollback-safe (never named volumes unless opted in); the operator can retune or turn it off. The
        // scheduler registers it within 5 minutes (CleanupSchedulerService sweep). Same defaults on every
        // create path: provisionLocalServer, the bulk create, and the "never configured" backfill migration.
        ...DEFAULT_CLEANUP_DATA,
        // Set only for cloud-provisioned servers, so a later delete can destroy the VM.
        ...(provisioning ? { provider: provisioning.provider, cloudCredentialId: provisioning.cloudCredentialId } : {}),
      },
    });
    await this.audit.log({
      actor: userId,
      action: "server.create",
      target: created.id,
    });
    // Auto-provision a default disk-usage monitor so every server is watched out of the box (Coolify/Dokploy
    // parity). Best-effort + lazy token: a monitor hiccup never blocks creating the server, and there is no
    // static module edge servers → monitors.
    await this.moduleRef
      .get<MonitorsService>(MONITORS_SERVICE, { strict: false })
      .createForServer({ id: created.id, name: created.name, teamId: created.teamId })
      .catch(() => undefined);

    return {
      server: this.toView(created, true, true),
      enrollToken,
      installCommand: await this.buildInstallCommand(enrollToken, publicUrl),
    };
  }

  /**
   * Fleet onboarding fan-out: add MANY servers to one team in a single call — each still gets its own enroll
   * token + install command to paste on that box. servers:manage is checked ONCE up front (fail fast before
   * any row is written); names are trimmed, blanks dropped and duplicates collapsed while preserving order.
   */
  async createServersBulk(
    userId: string,
    names: string[],
    teamId: string,
    publicUrl?: string,
  ): Promise<{ servers: Array<{ server: ServerView; enrollToken: string; installCommand: string }> }> {
    await this.access.requirePermission(userId, teamId, "servers:manage");
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const raw of names) {
      const n = raw.trim();
      if (n && !seen.has(n)) {
        seen.add(n);
        clean.push(n);
      }
    }
    if (clean.length === 0) throw new BadRequestException("no valid server names");
    if (clean.length > MAX_BULK_SERVERS) throw new BadRequestException(`at most ${MAX_BULK_SERVERS} servers per request`);
    // Sequential (not a transaction): mirrors single-create's non-transactional insert+audit, and a partial
    // batch is recoverable — the operator sees what landed and can retry the rest. N is capped above.
    const servers = [];
    for (const n of clean) servers.push(await this.insertServer(userId, n, teamId, publicUrl));
    return { servers };
  }

  /** The one-line agent install command. A `curl | sh` bootstrap that fetches the agent installer from
   *  this hub and runs it with the hub address + enroll token embedded (the installer pulls the version-matched
   *  agent image and runs it as a Docker container). The hub enforces every capability grant afresh before
   *  signing a command, so the agent needs no local allowlist snapshot (the hub is the sole gate).
   *
   *  The address is chosen so nothing is readable on the wire where it can be avoided:
   *   - IP mode (http://<ip>/ install, the proxy serves :443 with the hub's persisted self-signed certificate): the
   *     installer itself is fetched over that certificate (curl pins its public key) and the agent gets
   *     `wss://<ip>/agent` + `--hub-pin sha256:<fingerprint>` — it will talk to nothing but that certificate;
   *   - a domain (https): `wss://<domain>/agent`, publicly trusted certificate, nothing to pin;
   *   - anything else (a plain http hub, e.g. the raw :3000 port) yields `ws://…`, which the agent only accepts with an
   *     explicit `--hub-insecure` — so the command says so out loud, and the UI warns when it sees it. */
  private async buildInstallCommand(token: string, publicUrl?: string): Promise<string> {
    let t: Awaited<ReturnType<AgentEndpointsService["installTransport"]>> = null;
    try {
      t = (await this.agentEndpoints()?.installTransport(publicUrl)) ?? null;
    } catch {
      t = null; // never block adding a server on the transport lookup: the plain derivation below still works
    }
    if (t) {
      return `curl -fsSLk --pinnedpubkey 'sha256//${t.spkiPin}' ${t.origin}/install/agent.sh | sh -s -- --hub ${t.hubUrl} --hub-pin ${t.pin} --token ${token}`;
    }
    const hub = agentWsUrl(publicUrl);
    return `curl -fsSL ${hubBaseUrl(publicUrl)}/install/agent.sh | sh -s -- --hub ${hub}${plainWsNeedsOptIn(hub) ? " --hub-insecure" : ""} --token ${token}`;
  }

  private agentEndpoints(): AgentEndpointsService | undefined {
    try {
      return this.moduleRef.get<AgentEndpointsService>(AGENT_ENDPOINTS_SERVICE, { strict: false });
    } catch {
      return undefined; // not wired (unit tests / a trimmed module graph): the plain derivation below still works
    }
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
      installCommand: valid ? await this.buildInstallCommand(server.enrollToken!, publicUrl) : null,
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
    return { installCommand: await this.buildInstallCommand(enrollToken, publicUrl), expiresAt };
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
    filter?: { teamId?: string; status?: ServerStatus; q?: string },
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
      // The view never reads these two potentially large JSON documents (stored scan report, GPU inventory); loading
      // them for every server on every 5 s list poll was pure waste (parsed + discarded per request).
      omit: { scanReport: true, gpuInventory: true },
    });

    const views = servers
      .filter((s) => permsByTeam.has(s.teamId))
      .map((s) => this.toView(s, permsByTeam.get(s.teamId)?.has("servers:manage") ?? false, permsByTeam.get(s.teamId)?.has("servers:ops") ?? false));
    // `?q`: in-memory substring filter over non-secret fields of the already-authorized views.
    return filterByQuery(views, filter?.q, (s) => [s.name, s.hostname, s.publicIp, s.wildcardDomain]);
  }

  async getForUser(userId: string, id: string): Promise<ServerView> {
    const server = await this.prisma.server.findUnique({
      where: { id },
      include: { cluster: { select: { name: true } } },
      omit: { scanReport: true, gpuInventory: true }, // not part of the view (see listForUser)
    });
    if (!server) throw new NotFoundException("server not found");
    const perms = await this.access.membershipPermissions(userId, server.teamId);
    if (!perms) throw new ForbiddenException("not a member of this team");
    return this.toView(server, perms.has("servers:manage"), perms.has("servers:ops"));
  }

  /** This server's audit history (every actor). Reuses getForUser's membership check as the view gate. */
  async listAudit(userId: string, id: string, filters?: AuditFilters) {
    await this.getForUser(userId, id);
    return this.audit.listForTarget(id, filters);
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
    // App moves: refuse while the server is the source/target of a live move, or while it still holds a move's data —
    // a COMPLETED move's stopped source copy (until its archive is purged) or a rolled-back/failed move's target
    // leftovers. Deleting it would orphan that data (and strand the move's cleanup).
    const holdsMove = await this.prisma.appMove.findFirst({
      where: {
        OR: [
          { phase: { notIn: APP_MOVE_TERMINAL }, OR: [{ sourceServerId: id }, { targetServerId: id }] },
          { phase: "COMPLETED", sourceServerId: id, sourcePurgedAt: null, archiveUntil: { not: null } },
          { phase: { in: ["ROLLED_BACK", "FAILED"] }, targetServerId: id, targetPurgedAt: null },
        ],
      },
      select: { id: true },
    });
    if (holdsMove) {
      throw new ConflictException({ statusCode: 409, message: "this server is part of an app move, or still holds a moved app's archived data — finish the move or purge the archive first", code: "server_in_active_move" });
    }
    // Release any Cloudflare Tunnel resources BEFORE the cascade drops the row, so a deleted
    // server never leaks a live CF tunnel + wildcard CNAME. Best-effort; lazy token avoids a cycle.
    await this.moduleRef
      .get<TunnelService>(TUNNEL_SERVICE, { strict: false })
      .releaseResources(id)
      .catch(() => undefined);
    // Destroy the cloud VM too when asked — only for provider-created servers (never one an operator linked by
    // hand for out-of-band access: Tugra did not create it), and best-effort so a provider failure never blocks
    // removing the row (lazy token avoids a static module cycle).
    if (opts?.destroyVm && !server.providerManualLink && server.provider && server.providerServerId && server.cloudCredentialId) {
      await this.moduleRef
        .get<ProvisioningService>(PROVISIONING_SERVICE, { strict: false })
        .destroyVm(server.provider, server.cloudCredentialId, server.providerServerId)
        .catch(() => undefined);
    }
    // Remove the server's monitors (the auto disk monitor + any user-created METRIC monitors scoped to it):
    // Monitor.serverId has no FK cascade, so without this they would dangle with a live scheduler timer.
    // Best-effort + lazy token (mirrors the tunnel/VM cleanup above).
    await this.moduleRef
      .get<MonitorsService>(MONITORS_SERVICE, { strict: false })
      .removeForServer(id)
      .catch(() => undefined);
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

  async rename(userId: string, id: string, name: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    await this.prisma.server.update({ where: { id }, data: { name: name.trim(), nameAuto: false } });
    await this.audit.log({ actor: userId, action: "server.rename", target: id });
  }

  /** Update operator metadata (free-text description + IANA timezone). The timezone is consumed by the
   *  cleanup cron scheduler (read at hub boot and on the next cleanup-config save), so a tz change takes
   *  effect on the next cleanup-config save or hub restart rather than instantly — kept decoupled on
   *  purpose so this module does not depend on the server-ops cleanup scheduler. */
  async setServerDetails(userId: string, id: string, patch: { description?: string | null; timezone?: string | null }): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const data: Prisma.ServerUncheckedUpdateInput = {};
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    if (patch.timezone !== undefined) data.timezone = patch.timezone || null;
    await this.prisma.server.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "server.details.update", target: id });
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

  // Callback set by AgentWsServer at boot (same cycle-avoiding shape as the capability pusher): runs after a server
  // moved to another team so live sessions authorized against the OLD team (host terminals, log streams) are cut.
  // The agent socket itself is keyed by the server id and the seal/identity never change, so it stays connected.
  private teamChangeListener?: (serverId: string) => void;

  setTeamChangeListener(fn: (serverId: string) => void): void {
    this.teamChangeListener = fn;
  }

  private readonly teamChanges = new Subject<string>();

  /** Emits the server id whenever a server moves team; live HTTP streams (SSE) end themselves on their own server's id. */
  teamChanged$(): Observable<string> {
    return this.teamChanges.asObservable();
  }

  /** Announce that a server now belongs to another team (called by the team-transfer service after the write). */
  emitTeamChanged(serverId: string): void {
    this.teamChangeListener?.(serverId);
    this.teamChanges.next(serverId);
  }

  /** Set the granted capabilities (least-privilege toggle). Deduped + restricted to the known
   *  capability set and stored verbatim — an empty set means deny-all (fail-safe), NOT "all",
   *  so unchecking everything can never invert into granting everything. */
  async setCapabilities(userId: string, id: string, capabilities: string[]): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const next = [...new Set(capabilities)].filter((c) => ALL_CAPABILITIES.includes(c));
    // "files_write" (upload/edit/rename/chmod/delete on app volumes) only makes sense on top of "files" (browse/read):
    // refuse the incoherent set rather than silently granting write without read. Dropping "files" therefore means
    // the caller drops "files_write" in the same request (the web card does this when files is unchecked).
    if (next.includes("files_write") && !next.includes("files")) {
      throw new BadRequestException("files_write requires files");
    }
    await this.prisma.server.update({ where: { id }, data: { capabilities: next } });
    // Live-push the new set to the connected agent (fail-closed allowlist updates immediately).
    this.capabilityPusher?.(id, next);
    await this.audit.log({ actor: userId, action: "server.capabilities.update", target: id });
  }

  /**
   * Grant and/or revoke opt-in capabilities on many servers in one call. Per server it applies the same rules as
   * {@link setCapabilities} (team permission `servers:manage` on THAT server's team, files_write needs files,
   * live push to the agent) and writes one audit entry per server naming exactly what changed. A server the caller
   * cannot manage, or whose result would be incoherent, fails on its own row without blocking the others.
   * Revoking `files` also drops `files_write` (write without read is not a grantable state).
   */
  async setCapabilitiesBulk(
    userId: string,
    input: { serverIds: string[]; grant: string[]; revoke: string[] },
  ): Promise<BulkCapabilityResult[]> {
    const grant = [...new Set(input.grant)].filter((c) => BULK_GRANTABLE.includes(c));
    const revoke = [...new Set(input.revoke)].filter((c) => BULK_GRANTABLE.includes(c) && !grant.includes(c));
    const ids = [...new Set(input.serverIds)];
    const results: BulkCapabilityResult[] = [];
    for (const id of ids) {
      try {
        const server = await this.prisma.server.findUnique({ where: { id }, select: { id: true, teamId: true, capabilities: true } });
        if (!server) throw new NotFoundException("server not found");
        await this.access.requirePermission(userId, server.teamId, "servers:manage");
        const next = new Set(server.capabilities);
        for (const c of revoke) next.delete(c);
        if (revoke.includes("files")) next.delete("files_write");
        for (const c of grant) next.add(c);
        if (next.has("files_write") && !next.has("files")) {
          results.push({ id, ok: false, error: "files_write_requires_files" });
          continue;
        }
        const nextList = [...next];
        const granted = grant.filter((c) => !server.capabilities.includes(c));
        const revoked = server.capabilities.filter((c) => !next.has(c));
        if (granted.length > 0 || revoked.length > 0) {
          await this.prisma.server.update({ where: { id }, data: { capabilities: nextList } });
          this.capabilityPusher?.(id, nextList);
        }
        await this.audit.log({ actor: userId, action: "server.capabilities.bulk", target: id, meta: { granted, revoked } });
        results.push({ id, ok: true, capabilities: nextList, granted, revoked });
      } catch (e) {
        if (e instanceof NotFoundException) results.push({ id, ok: false, error: "not_found" });
        else if (e instanceof ForbiddenException) results.push({ id, ok: false, error: "forbidden" });
        else {
          results.push({ id, ok: false, error: "failed" });
        }
      }
    }
    return results;
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
    // Each family has its own source flag: pinning an address flips THAT family to "manual" so observations and
    // reports never clobber it; clearing it resumes automatic detection for that family only.
    if (v4 !== undefined) data.ipSource = v4 ? "manual" : "observed";
    if (v6 !== undefined) data.ipv6Source = v6 ? "manual" : "observed";

    // Wildcard-cert policy + DNS-01 provider. dnsCreds are encrypted at rest and
    // never round-tripped (the plaintext never reaches the DB or a response).
    if (cfg.certMode !== undefined) data.certMode = cfg.certMode;
    if (cfg.dnsProvider !== undefined) data.dnsProvider = cfg.dnsProvider;
    if (cfg.customCertResolver !== undefined) data.customCertResolver = cfg.customCertResolver;
    if (cfg.dnsCreds !== undefined) {
      // Same rule as the DTO (MCP / internal callers skip the pipe): a single-line value per credential, trimmed.
      const creds = cfg.dnsCreds ? trimDnsCreds(cfg.dnsCreds) : null;
      const issue = creds ? dnsCredsIssue(creds) : null;
      if (issue) throw new BadRequestException(issue);
      data.dnsCredsEnc = creds && Object.keys(creds).length > 0 ? this.crypto.encrypt(JSON.stringify(creds)) : null;
      data.dnsCredential = { disconnect: true }; // typed creds replace the copied token: coverage is no longer knowable
    }
    // Proxy bind mode — persisted here; applied when the proxy is (re)started.
    if (cfg.proxyBind !== undefined) data.proxyBind = cfg.proxyBind;

    // Reuse a team DNS credential as the DNS-01 resolver token (cutover pre-issue). The token is decrypted here,
    // re-encrypted into dnsCredsEnc and NEVER returned/audited; the credential id is remembered for coverage checks.
    let fromCredential = false;
    if (cfg.dnsFromCredentialId && cfg.dnsCreds) throw new BadRequestException("dnsFromCredentialId and dnsCreds are mutually exclusive");
    if (cfg.dnsFromCredentialId) {
      const cred = await this.prisma.dnsCredential.findUnique({ where: { id: cfg.dnsFromCredentialId } });
      if (!cred || cred.teamId !== server.teamId) throw new BadRequestException("that DNS credential does not belong to this server's team");
      if (cred.provider !== "cloudflare") throw new BadRequestException("only a cloudflare DNS credential can be used for DNS-01");
      let token: string;
      try {
        token = this.crypto.decrypt(cred.apiTokenEnc);
      } catch {
        throw new BadRequestException("the DNS credential's token could not be read - re-save the credential");
      }
      data.dnsProvider = "cloudflare";
      data.certMode = "le-dns";
      data.dnsCredsEnc = this.crypto.encrypt(JSON.stringify(dnsProviderEnvCreds("cloudflare", token)));
      data.dnsCredential = { connect: { id: cred.id } };
      fromCredential = true;
    } else if (cfg.dnsFromCredentialId === null) {
      data.dnsCredential = { disconnect: true }; // forget the link only; typed creds stay
    }

    await this.prisma.server.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "server.network.update", target: id, ...(fromCredential ? { meta: { dnsFromCredential: true } } : {}) });
    // Apply the new resolver to the running proxy (no `force`: the config-hash gate recreates only when the hash
    // changed). Best-effort - the settings are saved either way and the next deploy reconciles the proxy.
    if (fromCredential) {
      await this.moduleRef.get<ProxyService>(PROXY_SERVICE, { strict: false }).ensureProxy(id).catch(() => undefined);
    }
    // The IP/wildcard drives magic domains — refresh them so live apps follow.
    // Lazy lookup by string token avoids a module/require cycle (see import note).
    await this.moduleRef
      .get<ApplicationsService>(APPLICATIONS_SERVICE, { strict: false })
      .regenerateMagicForServer(id)
      .catch(() => undefined);
  }

  // ---- agent transport (called by the WS server) --------------------------

  /**
   * Update fields for a freshly observed source IP (see reconcileObservedIp: ranks below the host's own interface and
   * the cloud metadata, never overrides a manual pin, never records loopback / a Cloudflare edge / the local
   * server's docker bridge).
   */
  private ipFields(
    observed: string | null | undefined,
    current: HostIpState,
    isLocal = false,
  ): Prisma.ServerUpdateInput {
    return reconcileObservedIp(current, observed, isLocal) ?? {};
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
        ...this.ipFields(input.observedIp, server, server.isLocal),
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
  ): Promise<"ok" | "unknown" | "bad_signature"> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
    });
    // "unknown" = the server row is gone or was never enrolled → a fresh enroll is the right recovery,
    // so the gateway tells the agent to re-enroll. "bad_signature" = the server IS known but the agent's
    // key does not verify → a generic rejection; the agent must KEEP its identity (re-enroll cannot help
    // an already-enrolled server, and clearing it on a transient mismatch would brick the agent).
    if (!server?.agentPublicKey) return "unknown";
    if (!verifyEd25519(server.agentPublicKey, nonce, signature)) return "bad_signature";
    // Refresh online status + the observed IP in one write (reconnect may bring a new address — a dynamic
    // IP is tracked on every auth). Also refresh agentVersion when the agent reports one (only on enroll
    // before this): a self-updated agent reconnects via auth, so this is how the new version becomes
    // visible. Store verbatim; never blank an existing value from an older agent that omits it.
    const extra = this.ipFields(observedIp, server, server.isLocal);
    if (agentVersion) extra.agentVersion = agentVersion;
    await this.markOnline(serverId, extra);
    return "ok";
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
    this.noteSeen(serverId, s.lastSeenAt?.getTime() ?? Date.now(), false);
    this.confirmedOnline.set(serverId, Date.now());
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
    // Forget the ONLINE confirmation BEFORE and AFTER the write: a markOnline racing this write may set it
    // again, and a late OFFLINE landing after that ONLINE must not be shielded from the next heartbeat's heal.
    this.confirmedOnline.delete(serverId);
    // The newest heartbeat time rides this same update so the "last seen" in the offline notification (and the
    // panel) is exact even though heartbeats are only flushed every LAST_SEEN_FLUSH_MS.
    const seen = this.lastSeen.get(serverId);
    this.lastSeen.delete(serverId);
    this.lastSeenDirty.delete(serverId);
    const s = await this.prisma.server
      .update({
        where: { id: serverId },
        data: { status: ServerStatus.OFFLINE, ...(seen ? { lastSeenAt: new Date(seen) } : {}) },
      })
      .catch(() => undefined)
      .finally(() => this.confirmedOnline.delete(serverId));
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

  /**
   * Record a heartbeat. In memory only: the value is written by the periodic flush (LAST_SEEN_FLUSH_MS), one
   * statement for every server that changed, instead of one UPDATE per heartbeat per server.
   */
  async touch(serverId: string): Promise<void> {
    this.noteSeen(serverId, Date.now(), true);
  }

  private noteSeen(serverId: string, at: number, dirty: boolean): void {
    if (this.lastSeenClosed) return;
    const prev = this.lastSeen.get(serverId);
    if (prev !== undefined && prev >= at) return;
    this.lastSeen.set(serverId, at);
    if (dirty) this.lastSeenDirty.add(serverId);
  }

  /** `lastSeenAt` for a REST view: the in-memory heartbeat time when it is newer than the stored one. */
  private seenOverlay(serverId: string, stored: Date | null): Date | null {
    const mem = this.lastSeen.get(serverId);
    return mem !== undefined && (!stored || mem > stored.getTime()) ? new Date(mem) : stored;
  }

  onModuleInit(): void {
    this.lastSeenTimer = setInterval(() => void this.flushLastSeen(), LAST_SEEN_FLUSH_MS);
    this.lastSeenTimer.unref?.();
    // Nest destroys the Prisma module before this one: flush through its pre-disconnect hook instead.
    this.prisma.registerBeforeDisconnect?.(async () => {
      await this.shutdownLastSeen();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdownLastSeen();
  }

  private async shutdownLastSeen(): Promise<void> {
    if (this.lastSeenTimer) clearInterval(this.lastSeenTimer);
    this.lastSeenTimer = undefined;
    if (this.lastSeenClosed) return;
    await this.flushLastSeen();
    this.lastSeenClosed = true;
  }

  /** Write every changed heartbeat time in ONE statement. Never moves a value backwards. Never throws. */
  async flushLastSeen(): Promise<void> {
    if (this.lastSeenDirty.size === 0) return;
    const ids = [...this.lastSeenDirty];
    this.lastSeenDirty.clear();
    const at: string[] = [];
    const sent: string[] = [];
    for (const id of ids) {
      const t = this.lastSeen.get(id);
      if (t === undefined) continue; // went offline meanwhile: markOffline wrote its value
      sent.push(id);
      at.push(new Date(t).toISOString());
    }
    if (sent.length === 0) return;
    try {
      await this.prisma.$executeRaw`
        UPDATE "Server" AS s SET "lastSeenAt" = v.ts
        FROM (SELECT unnest(${sent}::text[]) AS id, unnest(${at}::timestamp[]) AS ts) AS v
        WHERE s.id = v.id AND (s."lastSeenAt" IS NULL OR s."lastSeenAt" < v.ts)`;
    } catch {
      for (const id of sent) if (this.lastSeen.has(id)) this.lastSeenDirty.add(id); // retry next interval
    }
  }

  /**
   * Reconcile a stale status: a live agent heartbeat says the server is connected, so if the row is NOT
   * ONLINE (a reconnect-race or a hub-restart left it OFFLINE/PENDING-ish), flip it back. Conditional, so it
   * is a no-op write in steady state, and it does NOT fire a server_online notification — this is repairing
   * truth, not a real recovery edge (markOnline owns the notified OFFLINE→ONLINE transition).
   *
   * Steady state costs NO statement: once this process has confirmed ONLINE (markOnline / a successful heal) the
   * check is skipped for HEAL_RECHECK_MS, and markOffline clears the confirmation, so every race the heal exists
   * for (an OFFLINE landing after an ONLINE) still self-heals on the next heartbeat. `force` (the enroll/auth
   * path, which exists to catch exactly that race) always runs the conditional write.
   */
  async healOnline(serverId: string, opts: { force?: boolean } = {}): Promise<void> {
    const at = this.confirmedOnline.get(serverId);
    if (!opts.force && at !== undefined && Date.now() - at < HEAL_RECHECK_MS) return;
    try {
      await this.prisma.server.updateMany({
        where: { id: serverId, status: { not: ServerStatus.ONLINE } },
        data: { status: ServerStatus.ONLINE },
      });
      this.confirmedOnline.set(serverId, Date.now());
    } catch {
      /* best-effort; the next heartbeat retries */
    }
  }

  /** Store/refresh the host hardware+OS inventory (sent on every (re)connect). */
  async saveHostInfo(serverId: string, info: HostInfoInput): Promise<void> {
    // The agent's payload is not schema-validated on the socket: keep only well-formed address literals, bounded.
    const clean = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && isIP(x) !== 0).slice(0, 64) : [];
    const ifaceIps = clean(info.reportedIps);
    const metadataIps = clean(info.metadataIps);
    const cloudHint = cleanCloudHint(info.cloudProvider);
    // Reconcile the reported interface IPs and the cloud-metadata answer against what is stored, per family:
    // never overriding a manual pin. Best-effort like the update below: a read blip must never throw and tear
    // down the agent connection (host_info arrives on every reconnect).
    const server = await this.prisma.server
      .findUnique({
        where: { id: serverId },
        select: { publicIp: true, publicIpv6: true, ipSource: true, ipv6Source: true, isLocal: true, nameAuto: true },
      })
      .catch(() => null);
    const reconcile = server ? reconcileReportedIp(server, ifaceIps, server.isLocal, metadataIps) : null;
    // "All IPs": every address the host reports, interfaces first, the cloud's answer included (deduped).
    const allIps = [...new Set([...ifaceIps, ...metadataIps])];
    // A server added without a name takes the host's real hostname the first time the agent reports one.
    const realHostname = info.hostname && HOSTNAME_RE.test(info.hostname) ? info.hostname : null;
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
          reportedIps: allIps,
          // The provider the host says it runs on (a hint for price estimates); an old agent reports none: keep what we had.
          ...(cloudHint ? { cloudHint } : {}),
          ...(realHostname ? { hostname: realHostname } : {}),
          ...(realHostname && server?.nameAuto ? { name: realHostname, nameAuto: false } : {}),
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
      ipv6Source?: string;
      reportedIps?: string[];
      nameAuto?: boolean;
      wildcardDomain?: string | null;
      magicSuffix?: string | null;
      certMode?: string;
      dnsProvider?: string | null;
      customCertResolver?: string | null;
      dnsCredentialId?: string | null;
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
      cleanupCron?: string | null;
      cleanupThresholdPct?: number | null;
      cleanupVolumes?: boolean;
      description?: string | null;
      timezone?: string | null;
      lastCleanupAt?: Date | null;
      lastSeenAt: Date | null;
      createdAt: Date;
      seal: string | null;
      tags?: string[];
      capabilities?: string[];
      isLocal?: boolean;
      proxyBind?: string;
      trafficAnalytics?: boolean;
      provider?: string | null;
      providerServerId?: string | null;
      providerManualLink?: boolean;
      scanReport?: unknown;
      scanExposedCount?: number | null;
    },
    canWrite: boolean,
    canOps: boolean,
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
      ipv6Source: s.ipv6Source ?? s.ipSource ?? "observed",
      // Private LAN / VPC / tailnet addresses are for people who can manage the server, not every read-only member.
      reportedIps: canWrite ? (s.reportedIps ?? []) : [],
      nameAuto: s.nameAuto ?? false,
      wildcardDomain: s.wildcardDomain ?? null,
      magicSuffix: s.magicSuffix ?? null,
      certMode: s.certMode ?? "http",
      dnsProvider: s.dnsProvider ?? null,
      customCertResolver: s.customCertResolver ?? null,
      dnsCredentialId: s.dnsCredentialId ?? null,
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
      cleanupCron: s.cleanupCron ?? null,
      cleanupThresholdPct: s.cleanupThresholdPct ?? null,
      cleanupVolumes: s.cleanupVolumes ?? false,
      description: s.description ?? null,
      timezone: s.timezone ?? null,
      lastCleanupAt: s.lastCleanupAt ?? null,
      lastSeenAt: this.seenOverlay(s.id, s.lastSeenAt),
      createdAt: s.createdAt,
      seal: s.seal,
      tags: s.tags ?? [],
      capabilities: s.capabilities ?? [],
      isLocal: s.isLocal ?? false,
      proxyBind: s.proxyBind ?? "public",
      trafficAnalytics: s.trafficAnalytics ?? false,
      provider: s.provider ?? null,
      providerServerId: s.providerServerId ?? null,
      providerManualLink: s.providerManualLink ?? false,
      // scanReport is omitted from list/detail reads (memory); the count is stored beside it at scan time. A row loaded
      // with the report (older callers) still works through the JSON.
      exposedServices: s.scanExposedCount ?? exposedCountOf(s.scanReport),
      canWrite,
      canOps,
    };
  }
}

/** The exposed-service count of a stored scan report without re-validating the whole report (the list calls this per server). */
function exposedCountOf(report: unknown): number | null {
  if (!report || typeof report !== "object") return null;
  const r = report as { host?: { status?: unknown }; exposed?: unknown };
  if (r.host?.status !== "ok" || !Array.isArray(r.exposed)) return null;
  return r.exposed.length;
}
