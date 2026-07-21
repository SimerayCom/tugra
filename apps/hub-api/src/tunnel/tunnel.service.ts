import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CloudflareApiClient, type IngressRule } from "./cloudflare-api.client";
import { buildTunnelSetupScript, buildTunnelStopScript } from "../deploy/tunnel-script";
import { PROXY_NAME } from "../deploy/deploy-script";
// Lazy string-token lookup (ModuleRef) avoids a static tunnel→applications cycle.
import type { ApplicationsService } from "../applications/applications.service";
import { APPLICATIONS_SERVICE } from "../applications/applications.tokens";
import type { SetupTunnelInput, TunnelView } from "./dto/tunnel.schemas";

const AGENT_TIMEOUT_MS = 30_000;
// cloudflared forwards ALL tunnel ingress to the Traefik container by name on the shared
// network. This origin is a HUB-SIDE CONSTANT — never derived from request input (SSRF guard).
const PROXY_ORIGIN = `http://${PROXY_NAME}:80`;

type TunnelRow = NonNullable<Awaited<ReturnType<PrismaService["serverTunnel"]["findUnique"]>>>;

/**
 * Cloudflare Tunnel provisioning for a server (zero-IP expose). Creates a remotely-managed
 * CF tunnel, runs `cloudflared` on the agent (forwarding to Traefik), and points a wildcard
 * CNAME at it. Per-app exposure is controlled by `syncIngress` (the ingress rule list is
 * rebuilt from every app with `tunnelExposed`). Secrets are encrypted at rest and never returned.
 */
@Injectable()
export class TunnelService {
  private readonly logger = new Logger(TunnelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
    private readonly cf: CloudflareApiClient,
    private readonly moduleRef: ModuleRef,
  ) {}

  async status(userId: string, serverId: string): Promise<TunnelView> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, include: { tunnel: true } });
    if (!server) throw new NotFoundException("server not found");
    if (!(await this.access.teamRole(userId, server.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return this.view(server.wildcardDomain, server.tunnel);
  }

  async setup(userId: string, serverId: string, input: SetupTunnelInput): Promise<TunnelView> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, include: { tunnel: true } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");

    // A reconfigure that switches Cloudflare zone/account can't safely reuse the existing tunnelId/zoneId
    // (they were provisioned under the old zone/account) — require an explicit disconnect first.
    if (server.tunnel && (server.tunnel.zoneName !== input.zoneName || server.tunnel.cfAccountId !== input.cfAccountId)) {
      throw new BadRequestException("disconnect the current tunnel before changing its Cloudflare zone or account");
    }

    // Verify BEFORE persisting anything — never store an unverified token.
    const token = input.apiToken;
    const { valid } = await this.cf.verifyToken(token);
    if (!valid) throw new BadRequestException("cloudflare api token is invalid");

    const wildcardDomain = input.wildcardDomain?.trim() || input.zoneName;
    if (wildcardDomain !== input.zoneName && !wildcardDomain.endsWith(`.${input.zoneName}`)) {
      throw new BadRequestException("wildcardDomain must be the zone or a subdomain of it");
    }

    const existing = server.tunnel;
    const tunnelName = existing?.tunnelName ?? `tugra-${serverId}`;
    // Reuse a cached zone id on resume; only call CF when we don't have one.
    const zoneId = existing?.zoneId || (await this.cf.findZoneId(token, input.zoneName));

    let row = await this.prisma.serverTunnel.upsert({
      where: { serverId },
      create: {
        serverId,
        provider: "cloudflare",
        cfAccountId: input.cfAccountId,
        zoneName: input.zoneName,
        zoneId,
        cfApiTokenEnc: this.crypto.encrypt(token),
        tunnelName,
        status: "connecting",
      },
      update: {
        cfAccountId: input.cfAccountId,
        zoneName: input.zoneName,
        zoneId,
        cfApiTokenEnc: this.crypto.encrypt(token),
        status: "connecting",
        lastError: null,
      },
    });

    // Create the CF tunnel once (idempotent — skip when a tunnelId is already stored).
    if (!row.tunnelId) {
      const created = await this.cf.createTunnel(token, input.cfAccountId, tunnelName);
      row = await this.prisma.serverTunnel.update({
        where: { serverId },
        data: { tunnelId: created.tunnelId, cfTunnelTokenEnc: this.crypto.encrypt(created.token) },
      });
    }

    // Point the server's magic-domain root at the tunnel wildcard FIRST, regenerating live apps — so the
    // ingress we push below reflects the NEW magic domains, not the pre-change ones (else exposed apps
    // whose domain just changed would be routed by their stale hostname).
    if (server.wildcardDomain !== wildcardDomain) {
      await this.prisma.server.update({ where: { id: serverId }, data: { wildcardDomain } });
      await this.moduleRef
        .get<ApplicationsService>(APPLICATIONS_SERVICE, { strict: false })
        .regenerateMagicForServer(serverId)
        .catch(() => undefined);
    }

    // Ingress rebuilt from DB truth (now-current app domains; server-provisioning starts empty → catch-all only).
    await this.cf.putIngressConfig(token, input.cfAccountId, row.tunnelId!, await this.ingressRules(serverId));

    // Wildcard CNAME → <tunnelId>.cfargotunnel.com.
    const cname = await this.cf.upsertCname(token, zoneId, {
      name: `*.${wildcardDomain}`,
      tunnelId: row.tunnelId!,
      existingRecordId: row.dnsRecordId,
    });
    if (cname.recordId !== row.dnsRecordId) {
      row = await this.prisma.serverTunnel.update({ where: { serverId }, data: { dnsRecordId: cname.recordId } });
    }

    // Start cloudflared on the agent. A failure here does NOT throw — CF-side state is durable and a
    // later setup() resumes from here; we only record status + a (token-free) error message.
    const connectorToken = this.crypto.decrypt(row.cfTunnelTokenEnc!);
    try {
      const r = await this.agentWs.sendCommand(
        serverId,
        buildTunnelSetupScript({ token: connectorToken }),
        "deploy",
        AGENT_TIMEOUT_MS,
      );
      row = await this.prisma.serverTunnel.update({
        where: { serverId },
        data:
          r.exitCode === 0
            ? { status: "connected", lastError: null }
            : { status: "error", lastError: `connector exited with code ${r.exitCode}` },
      });
    } catch (e) {
      row = await this.prisma.serverTunnel.update({
        where: { serverId },
        data: { status: "error", lastError: errMsg(e) },
      });
    }

    await this.audit.log({
      actor: userId,
      action: "server.tunnel.setup",
      target: serverId,
      meta: { zoneName: input.zoneName, wildcardDomain, tunnelId: row.tunnelId }, // never the token
    });
    return this.view(wildcardDomain, row);
  }

  async teardown(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const clean = await this.releaseResources(serverId);
    if (!clean) {
      // Cloudflare cleanup failed — KEEP the row (its ids are the only way to find/retry the orphan)
      // and don't report a clean teardown. A retry (idempotent, 404-tolerant) completes it once fixed.
      await this.prisma.serverTunnel.updateMany({
        where: { serverId },
        data: { status: "error", lastError: "cloudflare cleanup failed — check the API token and retry disconnect" },
      });
      throw new ServiceUnavailableException(
        "cloudflare cleanup failed — the tunnel was not fully removed; fix the API token and retry disconnect",
      );
    }
    // Clear per-app opt-ins so a future tunnel on this server doesn't silently re-expose old apps.
    await this.prisma.application.updateMany({ where: { serverId, tunnelExposed: true }, data: { tunnelExposed: false } });
    await this.prisma.serverTunnel.deleteMany({ where: { serverId } });
    await this.audit.log({ actor: userId, action: "server.tunnel.teardown", target: serverId });
  }

  /**
   * Best-effort external cleanup (agent connector → CF DNS → CF tunnel) for a server, in that order
   * (a live connector blocks CF tunnel deletion). No RBAC / no DB-row delete. Returns true ONLY when
   * every CF-side deletion succeeded, so teardown() can decide whether it's safe to drop the row.
   * On any CF failure it logs the resource ids (never the token) so an orphan is recoverable — used by
   * teardown() AND by ServersService.deleteForUser (where the row cascades away regardless).
   */
  async releaseResources(serverId: string): Promise<boolean> {
    const row = await this.prisma.serverTunnel.findUnique({ where: { serverId } });
    if (!row) return true;
    await this.agentWs
      .sendCommand(serverId, buildTunnelStopScript(), "deploy", AGENT_TIMEOUT_MS)
      .catch(() => undefined);
    let token: string;
    try {
      token = this.crypto.decrypt(row.cfApiTokenEnc);
    } catch {
      this.logger.warn(
        `tunnel ${serverId}: undecryptable CF token — cloudflare tunnel ${row.tunnelId} / dns ${row.dnsRecordId} (zone ${row.zoneId}) may be orphaned`,
      );
      return false; // unreadable token → can't reach CF
    }
    let ok = true;
    if (row.dnsRecordId) {
      try {
        await this.cf.deleteDnsRecord(token, row.zoneId, row.dnsRecordId);
      } catch (e) {
        ok = false;
        this.logger.warn(`tunnel ${serverId}: CF DNS record ${row.dnsRecordId} (zone ${row.zoneId}) delete failed: ${errMsg(e)}`);
      }
    }
    if (row.tunnelId) {
      try {
        await this.cf.deleteTunnel(token, row.cfAccountId, row.tunnelId);
      } catch (e) {
        ok = false;
        this.logger.warn(`tunnel ${serverId}: CF tunnel ${row.tunnelId} (account ${row.cfAccountId}) delete failed: ${errMsg(e)}`);
      }
    }
    return ok;
  }

  /**
   * Per-app opt-in: route (or stop routing) this app's hostname through its server's tunnel.
   * Requires `apps:config`. Turning it ON requires a live tunnel on the app's server and a
   * hostname on the app. Rebuilds the server's ingress from DB truth afterwards.
   */
  async setAppExposed(userId: string, appId: string, exposed: boolean): Promise<{ tunnelExposed: boolean }> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, "apps:config");
    if (exposed) {
      const tunnel = await this.prisma.serverTunnel.findUnique({ where: { serverId: app.serverId } });
      if (!tunnel?.tunnelId) throw new BadRequestException("the app's server has no Cloudflare Tunnel configured");
      if (!app.domain) throw new BadRequestException("expose the app at a domain before routing it through the tunnel");
    }
    await this.prisma.application.update({ where: { id: appId }, data: { tunnelExposed: exposed } });
    await this.syncIngress(app.serverId);
    await this.audit.log({ actor: userId, action: "app.tunnel.update", target: appId, meta: { exposed } });
    return { tunnelExposed: exposed };
  }

  /**
   * Push a server's ingress rules to Cloudflare, rebuilt from DB truth (every app with
   * `tunnelExposed` + a hostname). Called on setup and on every per-app toggle — a full-list PUT
   * so a concurrent toggle never leaves a partial config. No-op when the server has no live tunnel.
   */
  async syncIngress(serverId: string): Promise<void> {
    const row = await this.prisma.serverTunnel.findUnique({ where: { serverId } });
    if (!row?.tunnelId) return;
    let token: string;
    try {
      token = this.crypto.decrypt(row.cfApiTokenEnc);
    } catch {
      return;
    }
    await this.cf.putIngressConfig(token, row.cfAccountId, row.tunnelId, await this.ingressRules(serverId));
  }

  private async ingressRules(serverId: string): Promise<IngressRule[]> {
    const apps = await this.prisma.application.findMany({
      where: { serverId, tunnelExposed: true, domain: { not: null } },
      select: { domain: true },
    });
    const hosts = [...new Set(apps.map((a) => a.domain).filter((d): d is string => !!d))];
    return hosts.map((hostname) => ({ hostname, service: PROXY_ORIGIN }));
  }

  private view(wildcardDomain: string | null, row: TunnelRow | null): TunnelView {
    if (!row) {
      return {
        configured: false,
        provider: null,
        zoneName: null,
        wildcardDomain: null,
        tunnelId: null,
        status: null,
        lastError: null,
        createdAt: null,
        updatedAt: null,
      };
    }
    // Explicit field pick — cfApiTokenEnc / cfTunnelTokenEnc must never leave the server.
    return {
      configured: true,
      provider: row.provider,
      zoneName: row.zoneName,
      wildcardDomain,
      tunnelId: row.tunnelId,
      status: row.status,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Agent/CF errors never contain the token or command string (CloudflareApiError is token-free); cap defensively. */
function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 300);
}
