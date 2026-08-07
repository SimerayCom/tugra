import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { isIP } from "node:net";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { SwarmProxyService } from "./swarm-proxy.service";
import { isPrivateV4, normalizeIp } from "../common/observed-ip";
import {
  buildNodeLsScript,
  buildSwarmInfoScript,
  buildSwarmInitScript,
  buildSwarmJoinScript,
  buildSwarmJoinTokenScript,
  buildSwarmLeaveScript,
  buildSwarmTokenRotateScript,
} from "../deploy/swarm-script";

type SwarmStatus = "NONE" | "FORMING" | "ACTIVE" | "DEGRADED" | "DISSOLVING";
type SwarmRole = "MANAGER" | "WORKER";

// WS timeout for a worker join. The join script itself is `timeout 25 docker swarm join …`, so it always
// resolves with a real exit code before this fires — avoiding the ambiguous "command timed out while the
// daemon is still retrying in the background" state.
const JOIN_WS_TIMEOUT_MS = 35_000;

interface MemberRow {
  id: string;
  name: string;
  status: string;
  publicIp: string | null;
  reportedIps: string[];
  capabilities: string[];
  swarmRole: SwarmRole | null;
  swarmNodeId: string | null;
  swarmError: string | null;
}

export interface SwarmNodeView {
  serverId: string;
  name: string;
  status: string;
  swarmRole: SwarmRole | null;
  swarmError: string | null;
}
export interface SwarmLiveNode {
  id: string;
  hostname: string;
  role: string;
  state: string;
  availability: string;
}
export interface SwarmView {
  clusterId: string;
  swarmStatus: SwarmStatus;
  managerServerId: string | null;
  swarmLastError: string | null;
  nodes: SwarmNodeView[];
  live: SwarmLiveNode[] | null;
}

/** Local swarm state of one node, from `docker info` — best-effort preflight; the init/join exit code stays
 *  authoritative (a human could join/leave a node between our preflight and our command — TOCTOU). */
function parseSwarmInfo(output: string): { localNodeState: string; nodeId: string | null } {
  try {
    const j = JSON.parse(output.trim());
    return { localNodeState: String(j.LocalNodeState ?? "unknown"), nodeId: j.NodeID ? String(j.NodeID) : null };
  } catch {
    return { localNodeState: "unknown", nodeId: null };
  }
}

/** `docker node ls --format '{{json .}}'` → one JSON object per line. Malformed lines are dropped. */
function parseNodeLs(output: string): SwarmLiveNode[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): SwarmLiveNode | null => {
      try {
        const j = JSON.parse(line);
        return {
          id: String(j.ID ?? ""),
          hostname: String(j.Hostname ?? ""),
          role: j.ManagerStatus ? "manager" : "worker",
          state: String(j.Status ?? ""),
          availability: String(j.Availability ?? ""),
        };
      } catch {
        return null;
      }
    })
    .filter((n): n is SwarmLiveNode => n !== null);
}

/** A sanitized, human-readable join failure — NEVER the raw command output (defence against token/PII leak). */
function classifyJoinError(exitCode: number): string {
  if (exitCode === 124) {
    return "timeout reaching manager on :2377 — open TCP 2377 + TCP/UDP 7946 + UDP 4789 between cluster members";
  }
  return `join failed (exit ${exitCode})`;
}

/** Our own error messages are safe to persist; still bound the length. Raw command output is never routed here. */
function safeMessage(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : "swarm operation failed";
}

/**
 * Docker Swarm formation (Cluster Phase2). Turns a Phase1 server group into a swarm: init one manager, join
 * the rest as workers. Deploy is untouched by this slice. Security-critical bits:
 *  - the worker join-token is fetched live from the manager, used immediately, rotated after joins, and
 *    NEVER logged / persisted / passed to audit — only sanitized `swarmError`/`swarmLastError` are stored.
 *  - `managerServerId` is validated to be a member of THIS cluster (sendCommand does no tenancy check).
 *  - the DB is a reconciled cache of last-known truth (like Server.status), not an eternal source of truth.
 */
@Injectable()
export class SwarmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly swarmProxy: SwarmProxyService,
  ) {}

  /** Form a swarm: init `managerServerId`, join every other ONLINE member as a worker. Idempotent — safe to
   *  re-run on a DEGRADED cluster to reconcile the members that haven't joined yet. */
  async form(userId: string, id: string, dto: { managerServerId: string; advertiseAddr?: string }): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    const members = await this.members(id);
    const manager = members.find((m) => m.id === dto.managerServerId);
    if (!manager) throw new BadRequestException("manager must be a server in this cluster");
    if (manager.status !== "ONLINE") throw new BadRequestException("manager server is offline");
    if (!manager.capabilities.includes("swarm")) {
      throw new BadRequestException("grant the 'swarm' capability to the manager server first");
    }

    // Advertise addr: explicit override (validated) › manager's private LAN IP › its public IP. Swarm
    // control/gossip should traverse a private network where possible rather than the public internet.
    let advertiseAddr: string;
    if (dto.advertiseAddr !== undefined) {
      if (isIP(dto.advertiseAddr) === 0) throw new BadRequestException("advertiseAddr must be an IP literal");
      advertiseAddr = dto.advertiseAddr;
    } else {
      const picked = this.pickAdvertiseAddr(manager);
      if (!picked) throw new BadRequestException("manager has no usable IP; provide advertiseAddr");
      advertiseAddr = picked;
    }

    // Concurrency guard: only a NONE/DEGRADED cluster can (re)form. CAS to FORMING; a losing racer gets 409.
    const cas = await this.prisma.cluster.updateMany({
      where: { id, swarmStatus: { in: ["NONE", "DEGRADED"] } },
      data: { swarmStatus: "FORMING", swarmLastError: null },
    });
    if (cas.count !== 1) throw new ConflictException("a swarm operation is already in progress");

    // Only trust a cached MANAGER role if the cluster STILL records this exact server as its manager. After a
    // dead-manager abandon (dissolve sets swarmManagerId=null but deliberately keeps the Server's role), that
    // mismatch forces the foreign-swarm preflight + init to run again — so a box still running an old,
    // uncleaned swarm is caught by the "already part of another swarm" check instead of being silently reused.
    let managerReady = manager.swarmRole === "MANAGER" && cluster.swarmManagerId === manager.id;
    try {
      // ── Manager init (skip if it's already our manager — idempotent retry) ──
      if (!managerReady) {
        const info = parseSwarmInfo((await this.run(manager.id, buildSwarmInfoScript())).output);
        if (info.localNodeState === "active") {
          throw new ConflictException("manager server is already part of another swarm");
        }
        const init = await this.run(manager.id, buildSwarmInitScript(advertiseAddr));
        if (init.exitCode !== 0) throw new ServiceUnavailableException("manager swarm init failed");
        managerReady = true;
      }
      const mNodeId = parseSwarmInfo((await this.run(manager.id, buildSwarmInfoScript())).output).nodeId;
      await this.markServer(manager.id, { swarmRole: "MANAGER", swarmNodeId: mNodeId, swarmError: null });

      // ── Join workers (secret token stays local; rotated afterwards) ──
      const workers = members.filter((m) => m.id !== manager.id);
      let joinedAll = true;
      if (workers.length) {
        const tokRes = await this.run(manager.id, buildSwarmJoinTokenScript("worker"));
        const token = tokRes.output.trim();
        if (tokRes.exitCode !== 0 || !token) {
          joinedAll = false; // no token → can't join anyone → DEGRADED
        } else {
          for (const w of workers) {
            if (await this.joinWorker(w, token, advertiseAddr)) joinedAll = false;
          }
          // Invalidate the worker token so anything that leaked (process list / stray log) stops working.
          await this.run(manager.id, buildSwarmTokenRotateScript("worker")).catch(() => undefined);
        }
      }

      const status: SwarmStatus = joinedAll ? "ACTIVE" : "DEGRADED";
      // Commit ONLY if we still hold FORMING. A concurrent dissolve() may have moved the cluster to
      // DISSOLVING/NONE (its CAS accepts FORMING as a source) while we were awaiting agent round-trips —
      // an unconditional write here would resurrect a swarm that was just torn down.
      await this.prisma.cluster.updateMany({
        where: { id, swarmStatus: "FORMING" },
        data: {
          swarmStatus: status,
          swarmManagerId: manager.id,
          swarmLastError: joinedAll ? null : "some workers did not join — re-run Form to reconcile",
        },
      });
      await this.audit.log({
        actor: userId,
        action: "cluster.swarm.form",
        target: id,
        meta: { managerServerId: manager.id, status },
      });
      return this.view(id);
    } catch (e) {
      // Revert FORMING to a sane resting state, but only if we still hold FORMING (a concurrent dissolve may
      // have taken over). The message here is our own (safe) — raw output never lands here.
      await this.prisma.cluster
        .updateMany({
          where: { id, swarmStatus: "FORMING" },
          data: { swarmStatus: managerReady ? "DEGRADED" : "NONE", swarmLastError: safeMessage(e) },
        })
        .catch(() => undefined);
      throw e;
    }
  }

  /** Live swarm status: reconcile the DB cache against `docker node ls` on the manager. Read-only. */
  async status(userId: string, id: string): Promise<SwarmView> {
    const cluster = await this.requireRead(userId, id);
    const base = await this.view(id);
    if (base.swarmStatus === "NONE" || !cluster.swarmManagerId) return base;
    const members = await this.members(id);
    const manager = members.find((m) => m.id === cluster.swarmManagerId);
    if (!manager || manager.status !== "ONLINE") {
      return { ...base, swarmLastError: base.swarmLastError ?? "manager offline — live status unavailable" };
    }
    let live: SwarmLiveNode[] = [];
    try {
      const res = await this.run(manager.id, buildNodeLsScript());
      if (res.exitCode === 0) live = parseNodeLs(res.output);
    } catch {
      // manager unreachable mid-call — fall back to the cached view
    }
    // Self-heal: if fewer nodes are Ready than the DB thinks are joined, downgrade ACTIVE → DEGRADED.
    let swarmStatus = base.swarmStatus;
    if (live.length) {
      const joinedCount = members.filter((m) => m.swarmRole).length;
      const readyCount = live.filter((n) => n.state.toLowerCase() === "ready").length;
      if (readyCount < joinedCount && swarmStatus === "ACTIVE") {
        swarmStatus = "DEGRADED";
        await this.prisma.cluster.update({ where: { id }, data: { swarmStatus: "DEGRADED" } }).catch(() => undefined);
      }
    }
    return { ...base, swarmStatus, live };
  }

  /** Dissolve the swarm: workers leave (best-effort, node-local), then the manager `leave --force` last.
   *  Unreachable nodes are abandoned (bookkeeping cleared, a marker left) rather than blocking teardown. */
  async dissolve(userId: string, id: string): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    if (cluster.swarmStatus === "NONE") return this.view(id); // idempotent

    // Dissolving destroys the swarm's Raft store → every `docker service` on it vanishes cluster-wide, but
    // the Application rows would still point here (and still read RUNNING). Refuse until those apps are
    // removed or moved back to a single server (Phase3 apps set Application.clusterId to this cluster).
    const appCount = await this.prisma.application.count({ where: { clusterId: id } });
    if (appCount > 0) {
      throw new ConflictException(`remove or reassign the ${appCount} app(s) deployed to this cluster's swarm before dissolving`);
    }

    const cas = await this.prisma.cluster.updateMany({
      where: { id, swarmStatus: { in: ["ACTIVE", "DEGRADED", "FORMING"] } },
      data: { swarmStatus: "DISSOLVING" },
    });
    if (cas.count !== 1) throw new ConflictException("a swarm operation is already in progress");

    const members = await this.members(id);
    const manager = members.find((m) => m.swarmRole === "MANAGER");
    const workers = members.filter((m) => m.swarmRole === "WORKER");
    let abandoned = false;

    // Workers first — `swarm leave` is node-local (doesn't need the manager), so a dead worker can't be told
    // to leave but also doesn't block the rest.
    for (const w of workers) {
      if (w.status === "ONLINE" && w.capabilities.includes("swarm")) {
        await this.run(w.id, buildSwarmLeaveScript(false)).catch(() => undefined);
        await this.markServer(w.id, { swarmRole: null, swarmNodeId: null, swarmError: null });
      } else {
        await this.markServer(w.id, {
          swarmRole: null,
          swarmNodeId: null,
          swarmError: "not reachable during dissolve; local swarm state may remain",
        });
        abandoned = true;
      }
    }

    // Manager last.
    if (manager) {
      if (manager.status === "ONLINE" && manager.capabilities.includes("swarm")) {
        // Tear down the swarm-mode Traefik (ingress) BEFORE leaving the swarm. If removal isn't CONFIRMED,
        // the proxy may still be bound to :80/:443 on this box — which will later look like a free classic
        // target (the ProxyService guard only knows swarm MANAGERS) — so warn loudly instead of silently.
        const proxyGone = await this.swarmProxy.teardown(manager.id, id);
        if (!proxyGone) abandoned = true;
        const proxyWarn = proxyGone
          ? null
          : "the swarm ingress proxy may STILL be bound to :80/:443 on this host — verify and 'docker service rm tugra-swarm-proxy'";
        const res = await this.run(manager.id, buildSwarmLeaveScript(true)).catch(() => ({ exitCode: 1, output: "" }));
        if (res.exitCode === 0) {
          // Clear the role but preserve the proxy warning (a successful leave must not mask an orphaned proxy).
          await this.markServer(manager.id, { swarmRole: null, swarmNodeId: null, swarmError: proxyWarn });
        } else {
          await this.markServer(manager.id, { swarmError: proxyWarn ?? "manager leave failed; local swarm state may remain" });
          abandoned = true;
        }
      } else {
        // Dead-manager abandon path: KEEP its swarmRole/swarmNodeId so a later Form's preflight refuses to
        // blindly re-add a box that may still be a live manager; the operator clears it by hand. If it hosted
        // the ingress proxy, that box may STILL be terminating live HTTPS for customer domains — sharper warning.
        await this.markServer(manager.id, {
          swarmError: "manager unreachable during dissolve; it may STILL be serving live HTTPS for your domains — verify and run 'docker swarm leave --force' on it",
        });
        abandoned = true;
      }
    }

    await this.prisma.cluster.update({
      where: { id },
      data: {
        swarmStatus: "NONE",
        swarmManagerId: null,
        swarmLastError: abandoned
          ? "some nodes could not be cleanly removed — run 'docker swarm leave --force' on those hosts"
          : null,
      },
    });
    await this.audit.log({ actor: userId, action: "cluster.swarm.dissolve", target: id, meta: { abandoned } });
    return this.view(id);
  }

  // ── internals ──

  /** Join one worker; returns a short reason string on failure (null = joined or already a worker). Persists
   *  the per-server outcome immediately so the DB never claims a node joined when it didn't. */
  private async joinWorker(w: MemberRow, token: string, managerAddr: string): Promise<string | null> {
    if (w.swarmRole === "WORKER") return null; // already joined (idempotent retry)
    if (w.status !== "ONLINE") {
      await this.markServer(w.id, { swarmError: "server offline" });
      return "offline";
    }
    if (!w.capabilities.includes("swarm")) {
      await this.markServer(w.id, { swarmError: "swarm capability not granted" });
      return "no-cap";
    }
    try {
      const info = parseSwarmInfo((await this.run(w.id, buildSwarmInfoScript())).output);
      if (info.localNodeState === "active") {
        await this.markServer(w.id, { swarmError: "already in a swarm" });
        return "foreign-swarm";
      }
      const join = await this.run(w.id, buildSwarmJoinScript(token, managerAddr), JOIN_WS_TIMEOUT_MS);
      if (join.exitCode !== 0) {
        await this.markServer(w.id, { swarmError: classifyJoinError(join.exitCode) });
        return "join-failed";
      }
      const nodeId = parseSwarmInfo((await this.run(w.id, buildSwarmInfoScript())).output).nodeId;
      await this.markServer(w.id, { swarmRole: "WORKER", swarmNodeId: nodeId, swarmError: null });
      return null;
    } catch (e) {
      await this.markServer(w.id, { swarmError: safeMessage(e) });
      return "error";
    }
  }

  private run(serverId: string, script: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }> {
    return this.agentWs.sendCommand(serverId, script, "swarm", timeoutMs);
  }

  private async markServer(
    id: string,
    data: { swarmRole?: SwarmRole | null; swarmNodeId?: string | null; swarmError?: string | null },
  ): Promise<void> {
    await this.prisma.server.update({ where: { id }, data });
  }

  /** Prefer a private LAN IP for swarm control/gossip; fall back to the public IP. */
  private pickAdvertiseAddr(server: MemberRow): string | null {
    const priv = server.reportedIps.map(normalizeIp).find((ip) => isIP(ip) !== 0 && isPrivateV4(ip));
    if (priv) return priv;
    const pub = server.publicIp ? normalizeIp(server.publicIp) : null;
    if (pub && isIP(pub) !== 0) return pub;
    return null;
  }

  private members(id: string): Promise<MemberRow[]> {
    return this.prisma.server.findMany({
      where: { clusterId: id },
      select: {
        id: true,
        name: true,
        status: true,
        publicIp: true,
        reportedIps: true,
        capabilities: true,
        swarmRole: true,
        swarmNodeId: true,
        swarmError: true,
      },
      orderBy: { name: "asc" },
    }) as unknown as Promise<MemberRow[]>;
  }

  private async view(id: string): Promise<SwarmView> {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id },
      select: { swarmStatus: true, swarmManagerId: true, swarmLastError: true },
    });
    const members = await this.members(id);
    return {
      clusterId: id,
      swarmStatus: (cluster?.swarmStatus ?? "NONE") as SwarmStatus,
      managerServerId: cluster?.swarmManagerId ?? null,
      swarmLastError: cluster?.swarmLastError ?? null,
      nodes: members.map((m) => ({
        serverId: m.id,
        name: m.name,
        status: m.status,
        swarmRole: m.swarmRole,
        swarmError: m.swarmError,
      })),
      live: null,
    };
  }

  /** Load a cluster and require servers:manage on its team; 404 for non-members. */
  private async requireWrite(
    userId: string,
    id: string,
  ): Promise<{ id: string; teamId: string; swarmStatus: SwarmStatus; swarmManagerId: string | null }> {
    const cluster = await this.loadCluster(userId, id);
    await this.access.requirePermission(userId, cluster.teamId, "servers:manage");
    return cluster;
  }

  /** Load a cluster requiring only team membership (read); 404 for non-members. */
  private requireRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; teamId: string; swarmStatus: SwarmStatus; swarmManagerId: string | null }> {
    return this.loadCluster(userId, id);
  }

  private async loadCluster(userId: string, id: string) {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id },
      select: { id: true, teamId: true, swarmStatus: true, swarmManagerId: true },
    });
    if (!cluster || !(await this.access.teamIds(userId)).includes(cluster.teamId)) {
      throw new NotFoundException("cluster not found");
    }
    return cluster as { id: string; teamId: string; swarmStatus: SwarmStatus; swarmManagerId: string | null };
  }
}
