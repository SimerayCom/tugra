import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import {
  buildClassicProxyRunningScript,
  buildSwarmProxyEnsureScript,
  buildSwarmProxyStatusScript,
  buildSwarmProxyTeardownScript,
} from "../deploy/swarm-proxy-script";

/**
 * Ensures the swarm-mode Traefik that fronts a cluster's swarm services (Phase3-B). One service per cluster,
 * pinned to the manager, on the overlay network. Mirrors ProxyService.ensureProxy but for a `docker service`.
 * Called lazily before a domain-routed swarm deploy (not in formation — routing readiness is a separate
 * concern from swarm membership).
 */
@Injectable()
export class SwarmProxyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly config: ConfigService,
  ) {}

  /** Resolve the cluster's ONLINE manager (id + swarm node id), or throw. */
  private async manager(clusterId: string): Promise<{ id: string; swarmNodeId: string | null }> {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id: clusterId },
      select: { swarmStatus: true, swarmManagerId: true },
    });
    if (!cluster) throw new BadRequestException("cluster not found");
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
      throw new BadRequestException(`cluster swarm is ${cluster.swarmStatus} — form it before routing traffic`);
    }
    if (!cluster.swarmManagerId) throw new BadRequestException("cluster has no swarm manager");
    const mgr = await this.prisma.server.findUnique({
      where: { id: cluster.swarmManagerId },
      select: { id: true, status: true, swarmNodeId: true },
    });
    if (!mgr || mgr.status !== "ONLINE") throw new ServiceUnavailableException("swarm manager is offline");
    return { id: mgr.id, swarmNodeId: mgr.swarmNodeId };
  }

  /** Idempotently ensure the overlay + swarm-Traefik are up on the manager, refusing if a classic proxy
   *  would collide on :80/:443. Verifies the proxy task actually reached 1/1 (a task on a non-manager node
   *  would silently discover zero services). */
  async ensure(clusterId: string): Promise<void> {
    const mgr = await this.manager(clusterId);

    // Coexistence guard: the classic per-server Traefik and the swarm proxy both bind :80/:443 on the
    // manager. If either a classic domain app is assigned to the manager, or a classic tugra-proxy is
    // actually running there, refuse — otherwise the swarm proxy task silently crash-loops on the port.
    const classicDomainApps = await this.prisma.application.count({
      where: { serverId: mgr.id, clusterId: null, domain: { not: null } },
    });
    if (classicDomainApps > 0) {
      throw new BadRequestException(
        "the swarm manager also hosts classic domain-routed apps on :80/:443 — dedicate it to the swarm (move those apps) before routing swarm traffic",
      );
    }
    const live = await this.agentWs
      .sendCommand(mgr.id, buildClassicProxyRunningScript(), "swarm")
      .catch(() => ({ exitCode: 1, output: "" }));
    if (live.exitCode === 0 && live.output.trim()) {
      throw new BadRequestException("a classic Traefik (tugra-proxy) is running on the swarm manager — remove it before routing swarm traffic");
    }

    const email = this.config.get<string>("ACME_EMAIL") ?? null;
    await this.agentWs.sendCommand(
      mgr.id,
      buildSwarmProxyEnsureScript({ managerNodeId: mgr.swarmNodeId, acmeEmail: email }),
      "swarm",
      60_000,
    );

    // Verify the proxy actually converged to 1/1 (constraint could leave it Pending if the node label /
    // manager pin didn't take).
    const status = await this.agentWs.sendCommand(mgr.id, buildSwarmProxyStatusScript(), "swarm").catch(() => ({ exitCode: 1, output: "" }));
    const replicas = status.output.trim();
    if (status.exitCode !== 0 || !/^1\/1\b/.test(replicas)) {
      throw new ServiceUnavailableException(`swarm proxy did not become ready (${replicas || "no status"})`);
    }
  }

  async status(clusterId: string): Promise<{ exitCode: number; output: string }> {
    const mgr = await this.manager(clusterId);
    return this.agentWs.sendCommand(mgr.id, buildSwarmProxyStatusScript(), "swarm");
  }

  /** Teardown the swarm proxy (on dissolve) and CONFIRM it's gone. Returns true only when the manager
   *  reported GONE — a masked failure / offline manager returns false so the caller can warn instead of
   *  silently leaving an orphaned proxy bound to :80/:443. */
  async teardown(managerId: string): Promise<boolean> {
    const r = await this.agentWs.sendCommand(managerId, buildSwarmProxyTeardownScript(), "swarm").catch(() => ({ exitCode: 1, output: "" }));
    return r.exitCode === 0 && /(^|\s)GONE(\s|$)/.test(r.output);
  }
}
