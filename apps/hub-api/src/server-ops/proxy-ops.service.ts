import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
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
    private readonly proxyConfig: ProxyConfigService,
  ) {}

  async status(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireRead(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildProxyStatusScript(), "deploy", PROXY_TIMEOUT_MS);
    return { status: parseStatus(r.output) };
  }

  async start(userId: string, serverId: string): Promise<{ status: ProxyStatus }> {
    await this.requireWrite(userId, serverId);
    // Single source of truth (ProxyConfigService) — SAME resolver as ProxyService.ensureProxy, so `start`
    // and a domained deploy produce an identical proxy (email, bind mode, DNS-01 creds, and — on the local
    // server — the panel router). `start` recreates the container, so the bind mode is (re)applied here too.
    const cfg = await this.proxyConfig.resolveFor(serverId);
    const r = await this.agentWs.sendCommand(
      serverId,
      buildProxySetupScript({
        acmeEmail: cfg.acmeEmail,
        bind: cfg.bind,
        dnsProvider: cfg.dnsProvider,
        dnsCreds: cfg.dnsCreds,
        panel: cfg.panel,
      }),
      "deploy",
      PROXY_TIMEOUT_MS,
    );
    // The script removes the old container before `docker run`; a non-zero exit means the proxy is now
    // gone/broken. Fail loudly (and skip the success audit + status probe) rather than reporting success.
    if (r.exitCode !== 0) {
      throw new BadRequestException(`reverse-proxy (Traefik) start failed: ${r.output.trim().slice(-500)}`);
    }
    await this.audit.log({ actor: userId, action: "server.proxy.start", target: serverId });
    return this.statusAfter(serverId);
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
