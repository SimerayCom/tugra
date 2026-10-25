import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { envFileB64 } from "../deploy/deploy-script";
import {
  buildClassicProxyRunningScript,
  buildSwarmProxyCertDirScript,
  buildSwarmProxyEnsureScript,
  buildSwarmProxyStatusScript,
  buildSwarmProxyTeardownScript,
  type SwarmProxyDns,
} from "../deploy/swarm-proxy-script";
import type { IngressView } from "./dto";

interface ManagerRow {
  id: string;
  name: string;
  status: string;
  publicIp: string | null;
  swarmNodeId: string | null;
  certMode: string;
  dnsProvider: string | null;
  dnsCredsEnc: string | null;
  ingressReplicas: number;
}

/** One node in the resolved ingress pool (manager first, then online joined members). */
interface IngressPoolNode {
  id: string;
  name: string;
  swarmNodeId: string | null;
  publicIp: string | null;
}

/**
 * Ensures the swarm-mode Traefik that fronts a cluster's swarm services. One service per cluster,
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
    private readonly settings: InstanceSettingsService,
  ) {}

  /** Resolve the cluster's PRIMARY manager (id + status + swarm node id + its cert/DNS config). Unlike the old
   *  manager() this NO LONGER throws when the primary is offline — callers decide (ensure() still needs it
   *  online because the ingress container is pinned to THIS node's local ACME cert store via a node label, but
   *  status() only needs any manager to answer a cluster-wide read, see dispatchManager()). */
  private async primary(clusterId: string): Promise<ManagerRow> {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id: clusterId },
      select: { swarmStatus: true, swarmManagerId: true, ingressReplicas: true },
    });
    if (!cluster) throw new BadRequestException("cluster not found");
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
      throw new BadRequestException(`cluster swarm is ${cluster.swarmStatus} — form it before routing traffic`);
    }
    if (!cluster.swarmManagerId) throw new BadRequestException("cluster has no swarm manager");
    const mgr = await this.prisma.server.findUnique({
      where: { id: cluster.swarmManagerId },
      select: { id: true, name: true, status: true, publicIp: true, swarmNodeId: true, certMode: true, dnsProvider: true, dnsCredsEnc: true },
    });
    if (!mgr) throw new ServiceUnavailableException("swarm manager server not found");
    return {
      id: mgr.id,
      name: mgr.name,
      status: mgr.status,
      publicIp: mgr.publicIp,
      swarmNodeId: mgr.swarmNodeId,
      certMode: mgr.certMode,
      dnsProvider: mgr.dnsProvider,
      dnsCredsEnc: mgr.dnsCredsEnc,
      ingressReplicas: cluster.ingressReplicas,
    };
  }

  /** Resolve the live ingress pool: the primary manager FIRST, then (when ingressReplicas > 1) up to
   *  ingressReplicas-1 OTHER online, swarm-joined members in deterministic id order. Pool size is
   *  min(ingressReplicas, available online joined members) so ensure() never fails purely because the fleet
   *  hasn't grown into the requested count yet. Re-derived fresh on every call (never snapshotted). */
  private async resolveIngressPool(clusterId: string): Promise<{ mgr: ManagerRow; pool: IngressPoolNode[] }> {
    const mgr = await this.primary(clusterId);
    const pool: IngressPoolNode[] = [{ id: mgr.id, name: mgr.name, swarmNodeId: mgr.swarmNodeId, publicIp: mgr.publicIp }];
    if (mgr.ingressReplicas > 1) {
      const extra = await this.prisma.server.findMany({
        // MANAGERS only: Traefik's swarm provider needs the manager-only Docker API, so a worker replica
        // would start but discover zero services. Workers stay out of the pool (and get their label stripped).
        where: { clusterId, id: { not: mgr.id }, status: "ONLINE", swarmNodeId: { not: null }, swarmRole: "MANAGER", capabilities: { has: "swarm" } },
        orderBy: { id: "asc" },
        take: mgr.ingressReplicas - 1,
        select: { id: true, name: true, swarmNodeId: true, publicIp: true },
      });
      pool.push(...extra);
    }
    return { mgr, pool };
  }

  /** Read-only view of the resolved ingress pool for the UI: how many replicas + which nodes/IPs an operator
   *  should point DNS at for failover. */
  async ingressInfo(clusterId: string): Promise<IngressView> {
    const { pool } = await this.resolveIngressPool(clusterId);
    return { replicas: pool.length, nodes: pool.map((p) => ({ id: p.id, name: p.name, ip: p.publicIp })) };
  }

  /** Pick the manager to DISPATCH a cluster-wide read (`docker service …`) to: the primary if it's online, else
   *  any other online manager with the 'swarm' capability (failover). The ~8-line backup query is
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

  /** Idempotently ensure the overlay + swarm-Traefik ingress pool are up, refusing if a classic proxy would
   *  collide on :80/:443 anywhere in the swarm. Pins + labels every pool node, publishes on the routing mesh
   *  (mode=ingress), gates 2+ replicas on DNS-01, and verifies the service converged to <poolSize>/<poolSize>. */
  async ensure(clusterId: string): Promise<void> {
    const { mgr, pool } = await this.resolveIngressPool(clusterId);
    // The primary must be ONLINE: it is where we dispatch the signed `docker service create`, and it is always
    // the first pool node. (Other pool members only need to be schedulable task hosts.)
    if (mgr.status !== "ONLINE") throw new ServiceUnavailableException("swarm manager is offline");

    const email = (await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"))) ?? null;
    const secretPrefix = `tugra-swarm-dns-${clusterId}`;
    const dnsCfg = this.dnsConfig(mgr);
    // HA gate FIRST (before ANY docker/agent command): 2+ replicas each hold an INDEPENDENT node-local ACME
    // store, which is only safe under DNS-01 (an outbound TXT challenge every replica can complete for the same
    // domain). HTTP-01 can't be routed to one specific replica behind the mesh. Failing here — ahead of the
    // per-node coexistence round-trips — makes an unconfigured request fail fast (no N×agent timeouts).
    if (pool.length > 1 && !dnsCfg) {
      throw new BadRequestException(
        "ingress HA (2+ replicas) requires DNS-01 — set the manager's certMode to le-dns with a DNS provider before increasing ingressReplicas (HTTP-01 challenges cannot be routed to one specific replica behind the swarm mesh)",
      );
    }

    // Coexistence guard, scoped to EVERY swarm-joined member (not just the manager): `mode=ingress` reserves
    // :80/:443 across the WHOLE routing mesh, so a classic per-server Traefik or classic domain app on ANY
    // joined node collides — refuse loudly instead of a silent port-bind failure. (Old `mode=host` only ever
    // touched the pinned manager, hence the old manager-only scope.)
    const joined = await this.prisma.server.findMany({ where: { clusterId, swarmNodeId: { not: null } }, select: { id: true, name: true, swarmNodeId: true } });
    const joinedIds = joined.map((s) => s.id);
    const classicDomainApps = await this.prisma.application.count({
      where: { serverId: { in: joinedIds }, clusterId: null, domain: { not: null } },
    });
    if (classicDomainApps > 0) {
      throw new BadRequestException(
        "a swarm-joined server hosts classic domain-routed apps on :80/:443 — the routing mesh reserves those ports cluster-wide; move those apps before routing swarm traffic",
      );
    }
    const checks = await Promise.all(
      joined.map(async (s) => ({ s, r: await this.agentWs.sendCommand(s.id, buildClassicProxyRunningScript(), "swarm").catch(() => ({ exitCode: 1, output: "" })) })),
    );
    const collided = checks.find((c) => c.r.exitCode === 0 && c.r.output.trim());
    if (collided) {
      throw new BadRequestException(
        `a classic Traefik (tugra-proxy) is running on swarm-joined server '${collided.s.name}' — the routing mesh reserves :80/:443 cluster-wide; remove it before routing swarm traffic`,
      );
    }

    // DNS-01 wildcard when the manager has le-dns configured. Creds ride an immutable, hash-named Docker secret;
    // the confighash label reconciles the proxy (skip if unchanged → no flap on ordinary deploys).
    const nodeIds = pool.map((p) => p.swarmNodeId).filter((x): x is string => !!x);
    const poolKey = [...nodeIds].sort().join(","); // fold the pool into the hash so a replica/membership change reconciles
    // Strip the tugra.proxy label from joined members that are NOT in the current pool (a scale-down leftover),
    // so the label constraint only matches intended nodes and the service can't schedule a replica onto a stale
    // one. Uses full DB node ids (docker node update accepts them); pool nodes are never in this set.
    const poolNodeIdSet = new Set(nodeIds);
    const unlabelNodeIds = joined.map((s) => s.swarmNodeId).filter((x): x is string => !!x && !poolNodeIdSet.has(x));
    let dns: SwarmProxyDns | null = null;
    let confighash: string;
    if (dnsCfg) {
      const credsB64 = envFileB64(dnsCfg.dnsCreds);
      confighash = createHash("sha256").update(`${email}|${dnsCfg.dnsProvider}|${credsB64}|ledns|${pool.length}|${poolKey}`).digest("hex").slice(0, 12);
      dns = { provider: dnsCfg.dnsProvider, credsB64, secretName: `${secretPrefix}-${confighash}` };
    } else {
      confighash = createHash("sha256").update(`${email}|http|${pool.length}|${poolKey}`).digest("hex").slice(0, 12);
    }
    // The Traefik service bind-mounts a NODE-LOCAL ACME dir; a missing source makes the task fail to start
    // on that node, so every replica node needs it. The manager's ensure script creates it for itself —
    // prepare every OTHER pool node first (idempotent; a no-op for the single-node pool). Fail loudly rather
    // than let the service sit at <N/N replicas with nothing in the deploy log.
    const certDirScript = buildSwarmProxyCertDirScript(!!dns);
    await Promise.all(
      pool.slice(1).map(async (p) => {
        const r = await this.agentWs.sendCommand(p.id, certDirScript, "swarm").catch(() => ({ exitCode: 1, output: "" }));
        if (r.exitCode !== 0) {
          throw new ServiceUnavailableException(`could not prepare the ingress ACME store on swarm node '${p.name}'`);
        }
      }),
    );
    await this.agentWs.sendCommand(
      mgr.id,
      buildSwarmProxyEnsureScript({ nodeIds, unlabelNodeIds, replicas: pool.length, acmeEmail: email, confighash, secretPrefix, dns }),
      "swarm",
      60_000,
    );

    // Verify the proxy actually converged to <poolSize>/<poolSize> (a constraint/label miss could leave tasks
    // Pending). `docker service ls` reports "<running>/<desired>"; desired == pool.length (≤3, single digit).
    const status = await this.agentWs.sendCommand(mgr.id, buildSwarmProxyStatusScript(), "swarm").catch(() => ({ exitCode: 1, output: "" }));
    const replicas = status.output.trim();
    const expect = `${pool.length}/${pool.length}`;
    if (status.exitCode !== 0 || !replicas.startsWith(expect)) {
      throw new ServiceUnavailableException(`swarm proxy did not become ready (${replicas || "no status"})`);
    }
  }

  async status(clusterId: string): Promise<{ exitCode: number; output: string }> {
    // `docker service ls` is a cluster-wide read any manager can answer — so status() fails over to a backup
    // online manager when the primary is down, instead of blacking out like the old manager() did.
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
