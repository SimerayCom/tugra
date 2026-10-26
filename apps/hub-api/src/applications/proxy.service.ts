import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { buildProxySetupScript } from "../deploy/deploy-script";

/** Ensures the Traefik reverse-proxy is running on a server (idempotent). */
@Injectable()
export class ProxyService {
  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly prisma: PrismaService,
    private readonly proxyConfig: ProxyConfigService,
  ) {}

  async ensureProxy(serverId: string): Promise<void> {
    // Coexistence guard: a swarm manager runs the swarm-mode Traefik on :80/:443. Standing up the classic
    // per-server proxy here would collide (a later `docker run -p 80:80` fails loudly, or worse silently
    // half-works). Refuse — this server is dedicated to swarm ingress.
    const swarmManaged = await this.prisma.cluster.count({
      where: { swarmManagerId: serverId, swarmStatus: { in: ["ACTIVE", "DEGRADED", "FORMING", "DISSOLVING"] } },
    });
    if (swarmManaged > 0) {
      throw new BadRequestException(
        "this server is a swarm manager (it runs the cluster's swarm ingress on :80/:443) — domain-routed single-server apps can't be deployed directly here",
      );
    }
    // Single source of truth (ProxyConfigService): email, bind mode, DNS-01 creds AND — for the local server
    // — the panel router. This runs on EVERY domained deploy and recreates the proxy (docker rm -f + run), so
    // resolving through one place is what keeps it from drifting from ProxyOpsService.start and from silently
    // re-publishing :80/:443 or dropping the panel.
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
      60_000,
    );
    // The setup script does `docker rm -f tugra-proxy` BEFORE `docker run`, so a failed re-run (port
    // taken, docker error) leaves NO proxy and every routed app on this server down. Never let that pass
    // as a successful deploy — surface it so the caller fails loudly.
    if (r.exitCode !== 0) {
      throw new BadRequestException(`reverse-proxy (Traefik) setup failed on this server: ${r.output.trim().slice(-500)}`);
    }
  }
}
