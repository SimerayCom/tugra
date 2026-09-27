import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { envFileB64 } from "../deploy/deploy-script";
import {
  buildClassicProxyRunningScript,
  buildSwarmProxyEnsureScript,
  buildSwarmProxyStatusScript,
  buildSwarmProxyTeardownScript,
  type SwarmProxyDns,
} from "../deploy/swarm-proxy-script";

interface ManagerRow {
  id: string;
  status: string;
  swarmNodeId: string | null;
  certMode: string;
  dnsProvider: string | null;
  dnsCredsEnc: string | null;
}

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
    private readonly crypto: CryptoService,
  ) {}

  /** Resolve the cluster's PRIMARY manager (id + status + swarm node id + its cert/DNS config). Unlike the old
   *  manager() this NO LONGER throws when the primary is offline — callers decide (ensure() still needs it
   *  online because the ingress container is pinned to THIS node's local ACME cert store via a node label, but
   *  status() only needs any manager to answer a cluster-wide read, see dispatchManager()). */
  private async primary(clusterId: string): Promise<ManagerRow> {
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
      select: { id: true, status: true, swarmNodeId: true, certMode: true, dnsProvider: true, dnsCredsEnc: true },
    });
    if (!mgr) throw new ServiceUnavailableException("swarm manager server not found");
    return { id: mgr.id, status: mgr.status, swarmNodeId: mgr.swarmNodeId, certMode: mgr.certMode, dnsProvider: mgr.dnsProvider, dnsCredsEnc: mgr.dnsCredsEnc };
  }

  /** Pick the manager to DISPATCH a cluster-wide read (`docker service …`) to: the primary if it's online, else
   *  any other online manager with the 'swarm' capability (FLEET-G failover). The ~8-line backup query is
   *  duplicated from SwarmDeployService by design — SwarmService already depends on SwarmProxyService, so
   *  importing it back here would create a circular DI edge; each service re-queries prisma independently. */
  private async dispatchManager(clusterId: string, primaryId: string, primaryStatus: string): Promise<string> {
    if (primaryStatus === "ONLINE") return primaryId;
    const backup = await this.prisma.server.findFirst({
      where: { clusterId, swarmRole: "MANAGER", status: "ONLINE", capabilities: { has: "swarm" }, NOT: { id: primaryId } },
      select: { id: true },
    });
    if (!backup) throw new ServiceUnavailableException("swarm manager is offline");
    return backup.id;
  }

  /** The manager's DNS-01 provider + decrypted creds, when certMode is "le-dns" (else null). Mirrors
   *  ProxyService.dnsConfig — unreadable creds fail SAFE (proxy comes up with HTTP-01 only). */
  private dnsConfig(mgr: ManagerRow): { dnsProvider: string; dnsCreds: Record<string, string> } | null {
    if (mgr.certMode !== "le-dns" || !mgr.dnsProvider || !mgr.dnsCredsEnc) return null;
    try {
      return { dnsProvider: mgr.dnsProvider, dnsCreds: JSON.parse(this.crypto.decrypt(mgr.dnsCredsEnc)) };
    } catch {
      return null;
    }
  }

  /** Idempotently ensure the overlay + swarm-Traefik are up on the manager, refusing if a classic proxy
   *  would collide on :80/:443. Verifies the proxy task actually reached 1/1 (a task on a non-manager node
   *  would silently discover zero services). */
  async ensure(clusterId: string): Promise<void> {
    const mgr = await this.primary(clusterId);
    // ensure() is UNCHANGED in behavior: the ingress container can only ever be scheduled on THIS node (pinned
    // by a node label to its local ACME cert store — see swarm-proxy-script.ts), so there is no failover to give
    // it. The online check that manager() used to bake in simply moves inline here.
    if (mgr.status !== "ONLINE") throw new ServiceUnavailableException("swarm manager is offline");

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
    // DNS-01 wildcard when the manager has le-dns configured. Creds ride an immutable, hash-named Docker
    // secret; the confighash label reconciles the proxy (skip if unchanged → no flap on ordinary deploys).
    const secretPrefix = `tugra-swarm-dns-${clusterId}`;
    const dnsCfg = this.dnsConfig(mgr);
    let dns: SwarmProxyDns | null = null;
    let confighash: string;
    if (dnsCfg) {
      const credsB64 = envFileB64(dnsCfg.dnsCreds);
      confighash = createHash("sha256").update(`${email}|${dnsCfg.dnsProvider}|${credsB64}|ledns`).digest("hex").slice(0, 12);
      dns = { provider: dnsCfg.dnsProvider, credsB64, secretName: `${secretPrefix}-${confighash}` };
    } else {
      confighash = createHash("sha256").update(`${email}|http`).digest("hex").slice(0, 12);
    }
    await this.agentWs.sendCommand(
      mgr.id,
      buildSwarmProxyEnsureScript({ managerNodeId: mgr.swarmNodeId, acmeEmail: email, confighash, secretPrefix, dns }),
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
    // `docker service ls` is a cluster-wide read any manager can answer — so status() fails over to a backup
    // online manager when the primary is down (FLEET-G), instead of blacking out like the old manager() did.
    const mgr = await this.primary(clusterId);
    const dispatchTo = await this.dispatchManager(clusterId, mgr.id, mgr.status);
    return this.agentWs.sendCommand(dispatchTo, buildSwarmProxyStatusScript(), "swarm");
  }

  /** Teardown the swarm proxy (on dissolve) and CONFIRM it's gone. Returns true only when the manager
   *  reported GONE — a masked failure / offline manager returns false so the caller can warn instead of
   *  silently leaving an orphaned proxy bound to :80/:443. */
  async teardown(managerId: string, clusterId?: string): Promise<boolean> {
    const secretPrefix = clusterId ? `tugra-swarm-dns-${clusterId}` : undefined;
    const r = await this.agentWs
      .sendCommand(managerId, buildSwarmProxyTeardownScript(secretPrefix), "swarm")
      .catch(() => ({ exitCode: 1, output: "" }));
    return r.exitCode === 0 && /(^|\s)GONE(\s|$)/.test(r.output);
  }
}
