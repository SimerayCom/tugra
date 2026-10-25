import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import {
  buildProxyLogsScript,
  buildProxyRestartScript,
  buildProxySetupScript,
  buildProxyStatusScript,
  buildProxyStopScript,
} from "../deploy/deploy-script";

const PROXY_TIMEOUT_MS = 60_000;

export type ProxyStatus = "running" | "stopped" | "absent";

function parseStatus(raw: string): ProxyStatus {
  const s = raw.trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "" || s === "absent" || s.includes("no such")) return "absent";
  return "stopped"; // exited | created | paused | restarting | dead
}

/** Manage the Traefik reverse-proxy on a server (Coolify "Proxy" parity). */
@Injectable()
export class ProxyOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly settings: InstanceSettingsService,
  ) {}

  async status(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireRead(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildProxyStatusScript(), "deploy", PROXY_TIMEOUT_MS);
    return { status: parseStatus(r.output) };
  }

  async start(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    const email = await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"));
    const dns = await this.dnsConfig(serverId);
    // The bind mode is applied here — `start` recreates the proxy container, so changing it
    // and re-starting the proxy publishes :80/:443 differently (public / loopback / tunnel-only).
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { proxyBind: true } }).catch(() => null);
    const r = await this.agentWs.sendCommand(serverId, buildProxySetupScript({ acmeEmail: email, bind: s?.proxyBind, ...dns }), "deploy", PROXY_TIMEOUT_MS);
    // The script removes the old container before `docker run`; a non-zero exit means the proxy is now
    // gone/broken. Fail loudly (and skip the success audit + status probe) rather than reporting success.
    if (r.exitCode !== 0) {
      throw new BadRequestException(`reverse-proxy (Traefik) start failed: ${r.output.trim().slice(-500)}`);
    }
    await this.audit.log({ actor: userId, action: "server.proxy.start", target: serverId });
    return this.statusAfter(serverId);
  }

  /** The server's DNS-01 provider + decrypted creds, when certMode is "le-dns". */
  private async dnsConfig(
    serverId: string,
  ): Promise<{ dnsProvider?: string | null; dnsCreds?: Record<string, string> | null }> {
    const s = await this.prisma.server
      .findUnique({ where: { id: serverId }, select: { certMode: true, dnsProvider: true, dnsCredsEnc: true } })
      .catch(() => null);
    if (!s || s.certMode !== "le-dns" || !s.dnsProvider || !s.dnsCredsEnc) return {};
    try {
      return { dnsProvider: s.dnsProvider, dnsCreds: JSON.parse(this.crypto.decrypt(s.dnsCredsEnc)) };
    } catch {
      return {};
    }
  }

  async stop(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    await this.agentWs.sendCommand(serverId, buildProxyStopScript(), "deploy", PROXY_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.proxy.stop", target: serverId });
    return this.statusAfter(serverId);
  }

  async restart(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    await this.agentWs.sendCommand(serverId, buildProxyRestartScript(), "deploy", PROXY_TIMEOUT_MS);
    await this.audit.log({ actor: userId, action: "server.proxy.restart", target: serverId });
    return this.statusAfter(serverId);
  }

  async logs(userId: string, serverId: string, tail = 200): Promise<{ output: string }> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildProxyLogsScript(tail), "deploy", PROXY_TIMEOUT_MS);
    return { output: r.output.slice(0, 65536) };
  }

  private async statusAfter(serverId: string): Promise<{ status: ProxyStatus }> {
    const r = await this.agentWs.sendCommand(serverId, buildProxyStatusScript(), "deploy", PROXY_TIMEOUT_MS);
    return { status: parseStatus(r.output) };
  }

  private async requireRead(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    if (!(await this.access.teamRole(userId, server.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
  }

  private async requireWrite(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }
}
