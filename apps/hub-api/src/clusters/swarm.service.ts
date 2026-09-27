import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { isIP } from "node:net";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { PlacementConstraint } from "../deploy/deploy-script";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { SwarmProxyService } from "./swarm-proxy.service";
import { isPrivateV4, normalizeIp } from "../common/observed-ip";
import {
  buildNodeDemoteScript,
  buildNodeDrainScript,
  buildNodeInspectAllScript,
  buildNodeLabelUpdateScript,
  buildNodePromoteScript,
  buildNodeRemoveScript,
  buildSwarmInfoScript,
  buildSwarmInitScript,
  buildSwarmJoinScript,
  buildSwarmJoinTokenScript,
  buildSwarmLeaveScript,
  buildSwarmTokenRotateScript,
  NODE_DRAIN_TIMEOUT_SEC,
} from "../deploy/swarm-script";

type SwarmStatus = "NONE" | "FORMING" | "ACTIVE" | "DEGRADED" | "DISSOLVING" | "JOINING";
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
  /** Whether the server has been granted the 'swarm' capability — a prerequisite for joining. Lets the UI
   *  exclude ineligible members from the "Add node" picker instead of round-tripping to a guaranteed 400. */
  swarmCapable: boolean;
  /** The docker swarm node id (once joined), so the UI can join this cached row to its LIVE counterpart in
   *  live[] (which carries labels) without guessing at hostname matching. */
  swarmNodeId: string | null;
}
export interface SwarmLiveNode {
  id: string;
  hostname: string;
  role: string;
  state: string;
  availability: string;
  labels: Record<string, string>;
}
/** Raft quorum health, derived live from Server.swarmRole/status (no persisted column). A swarm keeps its
 *  control plane only while a MAJORITY of managers are online — `hasQuorum` mirrors that math so the UI can
 *  warn before an operator loses the ability to deploy/scale/change managers. */
export interface SwarmQuorum {
  managers: number;
  managersOnline: number;
  hasQuorum: boolean;
}
export interface SwarmView {
  clusterId: string;
  swarmStatus: SwarmStatus;
  managerServerId: string | null;
  swarmLastError: string | null;
  nodes: SwarmNodeView[];
  live: SwarmLiveNode[] | null;
  /** Manager-quorum health; null only when swarmStatus is NONE (no swarm formed). */
  quorum: SwarmQuorum | null;
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
/** Parse `docker node inspect --format '{{json .}}'` (one JSON object per line). Richer than `node ls`: it
 *  carries Spec.Labels/Spec.Role/Spec.Availability. Prefers the authoritative Spec.Role, falling back to the
 *  ManagerStatus heuristic. State stays lowercase (Docker's NodeState value already is). */
function parseNodeInspect(output: string): SwarmLiveNode[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): SwarmLiveNode | null => {
      try {
        const j = JSON.parse(line);
        const labels = j?.Spec?.Labels;
        return {
          id: String(j.ID ?? ""),
          hostname: String(j?.Description?.Hostname ?? ""),
          role: String(j?.Spec?.Role ?? (j.ManagerStatus ? "manager" : "worker")),
          state: String(j?.Status?.State ?? ""),
          availability: String(j?.Spec?.Availability ?? ""),
          labels: labels && typeof labels === "object" ? (labels as Record<string, string>) : {},
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
  /** Live swarm status — system-safe core (no RBAC / team lookup), for internal callers not acting on behalf
   *  of a single user (SwarmSchedulerService's periodic fleet-wide poll). status() below is the RBAC-gated
   *  wrapper every human-facing path keeps using. Self-heals ACTIVE→DEGRADED when fewer nodes are Ready than
   *  the DB thinks joined — SAME logic status() had, just extracted.
   *  KNOWN, ACCEPTED GAP: when the manager is fully unreachable this returns swarmStatus UNCHANGED (still
   *  ACTIVE) with only an in-memory error string — it never persists DEGRADED for a dead manager, so the
   *  scheduler catches "a worker dropped" but MISSES "the manager itself died". Intentional non-goal for now. */
  async statusInternal(id: string): Promise<SwarmView> {
    const base = await this.view(id);
    if (base.swarmStatus === "NONE" || !base.managerServerId) return base;
    const members = await this.members(id);
    const managers = members.filter((m) => m.swarmRole === "MANAGER");
    // Dispatch the live `docker node inspect` (a cluster-wide Raft read any manager can answer) to the primary
    // if it's online, else to ANY other online manager — so a dead primary no longer blacks out live status
    // (FLEET-G). Single-manager clusters resolve to exactly the same node as before, so behavior is unchanged.
    const primary = members.find((m) => m.id === base.managerServerId);
    const dispatcher = primary && primary.status === "ONLINE" ? primary : managers.find((m) => m.status === "ONLINE");
    if (!dispatcher) {
      return { ...base, swarmLastError: base.swarmLastError ?? "no manager reachable — live status unavailable" };
    }
    let live: SwarmLiveNode[] = [];
    try {
      const res = await this.run(dispatcher.id, buildNodeInspectAllScript());
      if (res.exitCode === 0) live = parseNodeInspect(res.output);
    } catch {
      // manager unreachable mid-call — fall back to the cached view
    }
    // Quorum + self-heal. When live Raft data is available it is AUTHORITATIVE — recompute quorum from the live
    // manager set (role==="manager") rather than the cached Server.swarmRole rows. This is what stops a
    // dead-manager 'abandon' row from a PRIOR swarm incarnation (dissolve() deliberately keeps its swarmRole=
    // MANAGER for the operator to clear by hand) from being counted forever against a freshly re-formed swarm:
    // that ghost is simply not a node in the current swarm's `docker node inspect`, so it never inflates the
    // manager count or spuriously reports quorum loss. When live is unavailable we keep the cached quorum (best
    // effort). Downgrade ACTIVE → DEGRADED when fewer nodes are Ready than the DB thinks joined, OR when the live
    // manager quorum is lost — for a healthy single-manager cluster both are no-ops, so behavior is unchanged.
    let swarmStatus = base.swarmStatus;
    let quorum = base.quorum;
    if (live.length) {
      const liveManagers = live.filter((n) => n.role.toLowerCase() === "manager");
      const managersOnline = liveManagers.filter((n) => n.state.toLowerCase() === "ready").length;
      quorum = { managers: liveManagers.length, managersOnline, hasQuorum: liveManagers.length > 0 && managersOnline > liveManagers.length / 2 };
      const joinedCount = members.filter((m) => m.swarmRole).length;
      const readyCount = live.filter((n) => n.state.toLowerCase() === "ready").length;
      if ((readyCount < joinedCount || !quorum.hasQuorum) && swarmStatus === "ACTIVE") {
        swarmStatus = "DEGRADED";
        await this.prisma.cluster.update({ where: { id }, data: { swarmStatus: "DEGRADED" } }).catch(() => undefined);
      }
    }
    return { ...base, swarmStatus, live, quorum };
  }

  async status(userId: string, id: string): Promise<SwarmView> {
    await this.requireRead(userId, id); // RBAC + existence only; the live check is system-safe
    return this.statusInternal(id);
  }

  /** Read the resolved swarm-ingress pool (FLEET-H) — how many replicas + which nodes/IPs to point DNS at. */
  async getIngress(userId: string, id: string) {
    await this.requireRead(userId, id);
    return this.swarmProxy.ingressInfo(id);
  }

  /** Set the desired swarm-ingress replica count (FLEET-H). Clamped 1-3 here too (defence-in-depth beyond the
   *  DTO) so the invariant holds for any caller. On a live swarm the change is applied ATOMICALLY: persist the
   *  new value, reconcile via ensure(), and if ensure() fails (e.g. the DNS-01-required refusal, or a node that
   *  won't converge) REVERT the persisted value and rethrow — so the API never reports a "success" pool the
   *  ingress didn't actually converge to (which would hand the operator misleading DNS-pointing IPs). On a
   *  not-yet-formed swarm there is no live ingress to reconcile, so the value is simply saved as desired state. */
  async setIngressReplicas(userId: string, id: string, replicas: number) {
    const cluster = await this.requireWrite(userId, id);
    const n = Math.max(1, Math.min(3, Math.floor(replicas)));
    const prev = cluster.ingressReplicas;
    await this.prisma.cluster.update({ where: { id }, data: { ingressReplicas: n } });
    if (cluster.swarmStatus === "ACTIVE" || cluster.swarmStatus === "DEGRADED") {
      try {
        await this.swarmProxy.ensure(id);
      } catch (e) {
        // Reconcile failed → revert so the DB never advertises a replica count the ingress didn't converge to,
        // and surface the real reason (e.g. "ingress HA requires DNS-01") to the operator instead of a false 200.
        await this.prisma.cluster.update({ where: { id }, data: { ingressReplicas: prev } }).catch(() => undefined);
        throw e;
      }
    }
    await this.audit.log({ actor: userId, action: "cluster.swarm.ingress_replicas", target: id, meta: { replicas: n } });
    return this.swarmProxy.ingressInfo(id);
  }

  /** Add ONE more node to an ALREADY-ACTIVE swarm (Phase2b) — joins a single, already-a-cluster-member,
   *  not-yet-joined server without dissolving/reforming the rest. Idempotent (an already-joined target is a
   *  no-op) and CAS-safe: ACTIVE→JOINING sits outside both form()'s and dissolve()'s accepted source sets, so
   *  a concurrent form/dissolve/join-node 409s instead of racing a manager command against this. */
  async joinNode(userId: string, id: string, dto: { serverId: string; advertiseAddr?: string }): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    if (cluster.swarmStatus !== "ACTIVE") {
      throw new ConflictException("the swarm must be ACTIVE to add a node (Form Swarm first, or re-run it to reconcile a DEGRADED cluster)");
    }
    const members = await this.members(id);
    const target = members.find((m) => m.id === dto.serverId);
    if (!target) throw new BadRequestException("server must be a member of this cluster");
    if (target.swarmRole) return this.view(id); // idempotent: already joined, nothing to do
    if (target.status !== "ONLINE") throw new BadRequestException("server is offline");
    if (!target.capabilities.includes("swarm")) {
      throw new BadRequestException("grant the 'swarm' capability to this server first");
    }
    const manager = members.find((m) => m.id === cluster.swarmManagerId);
    if (!manager || manager.status !== "ONLINE") {
      throw new ServiceUnavailableException("swarm manager is offline — cannot add a node right now");
    }

    let advertiseAddr: string;
    if (dto.advertiseAddr !== undefined) {
      if (isIP(dto.advertiseAddr) === 0) throw new BadRequestException("advertiseAddr must be an IP literal");
      advertiseAddr = dto.advertiseAddr;
    } else {
      // Recomputed fresh (not the manager's original init address) — safe because buildSwarmInitScript binds
      // --listen-addr 0.0.0.0:2377, so any currently-reachable manager IP works as the worker's dial target.
      const picked = this.pickAdvertiseAddr(manager);
      if (!picked) throw new BadRequestException("manager has no usable IP; provide advertiseAddr");
      advertiseAddr = picked;
    }

    const cas = await this.prisma.cluster.updateMany({ where: { id, swarmStatus: "ACTIVE" }, data: { swarmStatus: "JOINING" } });
    if (cas.count !== 1) throw new ConflictException("a swarm operation is already in progress");

    try {
      const tokRes = await this.run(manager.id, buildSwarmJoinTokenScript("worker"));
      const token = tokRes.output.trim();
      if (tokRes.exitCode !== 0 || !token) {
        throw new ServiceUnavailableException("could not fetch a join token from the manager");
      }
      const reason = await this.joinWorker(target, token, advertiseAddr);
      await this.run(manager.id, buildSwarmTokenRotateScript("worker")).catch(() => undefined);
      if (reason) {
        const fresh = await this.prisma.server.findUnique({ where: { id: target.id }, select: { swarmError: true } });
        throw new ServiceUnavailableException(fresh?.swarmError ?? "could not add the node to the swarm");
      }
      // Clear any stale error from a prior failed attempt on success — matches form()/dissolve()'s
      // reset-on-every-terminal-transition convention; otherwise the old banner would persist on a healthy
      // swarm AND mask a later real "manager offline" (statusInternal's `?? ...` never fires if it's truthy).
      await this.prisma.cluster.updateMany({ where: { id, swarmStatus: "JOINING" }, data: { swarmStatus: "ACTIVE", swarmLastError: null } });
      await this.audit.log({ actor: userId, action: "cluster.swarm.join_node", target: id, meta: { serverId: target.id } });
      return this.view(id);
    } catch (e) {
      // Never DEGRADED here — the REST of the swarm is unaffected by one node's failed join.
      await this.prisma.cluster
        .updateMany({ where: { id, swarmStatus: "JOINING" }, data: { swarmStatus: "ACTIVE", swarmLastError: safeMessage(e) } })
        .catch(() => undefined);
      throw e;
    }
  }

  /** Remove ONE node from a live swarm (drain → leave → rm) WITHOUT dissolving the rest of the cluster. Only a
   *  WORKER can be removed here — a MANAGER must be demoted to a worker first (FLEET-G's Demote / removeManager),
   *  which keeps the Raft quorum honest and protects the ingress-pinned primary, then removed. The node's cluster
   *  membership is cleared too (this IS "Remove from cluster", not just "leave the swarm").
   *  swarmStatus is reused as a transitional busy-marker (CAS to "FORMING", restored to the prior ACTIVE/
   *  DEGRADED value on both success and failure) to avoid a migration for this slice; swarmLastError carries
   *  the advisory replica-risk warning (already doubles as a "last note", as dissolve()'s abandon note does). */
  async leaveNode(userId: string, id: string, serverId: string): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
      throw new ConflictException(`cluster swarm is ${cluster.swarmStatus} — a node can only be removed from an ACTIVE or DEGRADED swarm`);
    }
    const members = await this.members(id);
    const node = members.find((m) => m.id === serverId);
    if (!node) throw new NotFoundException("server not found in this cluster");
    if (!node.swarmRole) throw new BadRequestException("this server has not joined the cluster's swarm");
    if (node.swarmRole === "MANAGER") {
      // A manager can't be drained+removed directly — demote it to a worker first (FLEET-G's Demote action), then
      // remove it here; or dissolve the swarm. Demoting keeps the Raft quorum honest and can't strand the ingress
      // pin (removeManager refuses the primary), which a blind drain+rm here would risk.
      throw new ConflictException(
        "cannot remove a swarm manager directly — demote it to a worker first (Demote), then remove it, or dissolve the swarm.",
      );
    }
    if (!node.swarmNodeId) throw new ConflictException("this node's swarm identity is unknown — reconcile via Dissolve/Form");
    const manager = members.find((m) => m.id === cluster.swarmManagerId);
    if (!manager || manager.status !== "ONLINE") throw new ServiceUnavailableException("swarm manager is offline — cannot remove a node");

    const restoreStatus = cluster.swarmStatus;
    const cas = await this.prisma.cluster.updateMany({ where: { id, swarmStatus: restoreStatus }, data: { swarmStatus: "FORMING" } });
    if (cas.count !== 1) throw new ConflictException("a swarm operation is already in progress");

    try {
      const warning = await this.replicaRiskWarning(id, node);
      // The node's live docker hostname (captured before removal) so we can also strip apps pinned to it BY
      // hostname — not just by swarm node id — and never leave one permanently unschedulable (FLEET-D).
      const departingHostname = (await this.statusInternal(id).catch(() => null))?.live?.find((n) => n.id === node.swarmNodeId)?.hostname ?? null;
      const drain = await this.run(manager.id, buildNodeDrainScript(node.swarmNodeId), NODE_DRAIN_TIMEOUT_SEC * 1000 + 10_000);
      const drainNote = drain.exitCode === 2 ? "some tasks did not vacate within the drain window — they may be left Pending" : null;

      // Local `swarm leave` is only attempted when the node is reachable AND still holds the swarm capability
      // (an admin can revoke it while joined). The manager-side `node rm --force` below is authoritative
      // regardless — but a skipped local leave leaves the node's own daemon believing it's still a member, so
      // we always note it (covers both offline and capability-revoked, not just offline).
      const localLeaveSkipped = !(node.status === "ONLINE" && node.capabilities.includes("swarm"));
      if (!localLeaveSkipped) {
        await this.run(node.id, buildSwarmLeaveScript(false), JOIN_WS_TIMEOUT_MS).catch(() => undefined);
      }
      const offlineNote = localLeaveSkipped
        ? "local swarm leave was not attempted for this node — if it is still reachable and locally part of the swarm, run 'docker swarm leave --force' on it to clear stale swarm state"
        : null;

      const rm = await this.run(manager.id, buildNodeRemoveScript(node.swarmNodeId));
      if (rm.exitCode !== 0) throw new ServiceUnavailableException("docker node rm failed on the manager");

      const nodeNote = [drainNote, offlineNote].filter(Boolean).join("; ") || null;
      // The node genuinely left the swarm at the docker level → clear its role/cluster unconditionally.
      await this.prisma.server.update({ where: { id: node.id }, data: { swarmRole: null, swarmNodeId: null, swarmError: nodeNote, clusterId: null } });
      // Strip any app placement pinned to the node we just removed (by node id or its live hostname) so it
      // can't be left permanently unschedulable on its next deploy.
      await this.stripPlacementNamingNode(id, node.swarmNodeId, departingHostname);
      // Restore the cluster row ONLY if we still hold the FORMING lock. dissolve()'s CAS accepts FORMING as a
      // source, so a concurrent dissolve() can legitimately tear the swarm down mid-removal — an unconditional
      // write here would resurrect a self-contradictory ACTIVE + null-manager row (mirrors form()'s guarded commit).
      await this.prisma.cluster.updateMany({
        where: { id, swarmStatus: "FORMING" },
        data: { swarmStatus: restoreStatus, swarmLastError: [warning, nodeNote].filter(Boolean).join("; ") || null },
      });
      await this.audit.log({
        actor: userId, action: "cluster.swarm.leave_node", target: id,
        meta: { serverId: node.id, drainTimedOut: drain.exitCode === 2, localLeaveSkipped, warned: !!warning },
      });
      return this.view(id);
    } catch (e) {
      await this.prisma.cluster
        .updateMany({ where: { id, swarmStatus: "FORMING" }, data: { swarmStatus: restoreStatus, swarmLastError: safeMessage(e) } })
        .catch(() => undefined);
      throw e;
    }
  }

  /** Add ONE more MANAGER to an already-formed swarm (FLEET-G, multi-manager Raft HA) — either by PROMOTING an
   *  existing worker member (`docker node promote`) or by having a fresh, not-yet-joined member JOIN directly as
   *  a manager (manager join-token + `swarm join`). Grows the Raft quorum without dissolving/reforming; form()
   *  stays the only path that creates the FIRST manager. Idempotent (an already-MANAGER target is a no-op).
   *
   *  Deliberately NOT wrapped in a cluster-wide CAS (unlike form()): promote/join are single-node operations, so
   *  a cluster-wide lock would needlessly block unrelated concurrent deploys/proxy calls for the whole duration.
   *  Two admins racing this on the SAME server is accepted as a rare, low-blast-radius risk, backstopped by
   *  Docker's own idempotent `node promote` / `swarm join` semantics. */
  async addManager(userId: string, id: string, dto: { serverId: string; acknowledgeEvenQuorum?: boolean }): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
      throw new BadRequestException("form the swarm before adding a manager");
    }
    const members = await this.members(id);
    const target = members.find((m) => m.id === dto.serverId);
    if (!target) throw new BadRequestException("server must be a member of this cluster");
    if (target.swarmRole === "MANAGER") return this.view(id); // idempotent no-op — no agent call

    // Quorum guardrail (before any agent call): an even manager count buys no extra Raft fault-tolerance over
    // the odd count below it, while raising split-vote risk. Refuse unless the caller explicitly acknowledges.
    const currentManagers = members.filter((m) => m.swarmRole === "MANAGER");
    const newCount = currentManagers.length + 1;
    if (newCount % 2 === 0 && !dto.acknowledgeEvenQuorum) {
      throw new BadRequestException(
        `adding this manager brings the total to ${newCount} — an even manager count adds no extra Raft fault-tolerance over ${newCount - 1} while raising the risk of a split vote; pass acknowledgeEvenQuorum to proceed anyway, or add one more manager instead`,
      );
    }

    // Every promote/join is dispatched THROUGH an existing online manager (Raft membership changes must run on a
    // manager). All preflight refusals below run BEFORE any this.run() — mirrors form()'s "never touches an agent".
    const helper = currentManagers.find((m) => m.status === "ONLINE" && m.capabilities.includes("swarm"));
    if (!helper) throw new ServiceUnavailableException("no online manager available to run this operation");
    if (target.status !== "ONLINE") throw new BadRequestException("server is offline");
    if (!target.capabilities.includes("swarm")) throw new BadRequestException("grant the 'swarm' capability to this server first");

    try {
      if (target.swarmRole === "WORKER") {
        // PROMOTE an existing worker — a Raft membership change on the helper manager; no token involved.
        if (!target.swarmNodeId) throw new BadRequestException("server's swarm node id is unknown — re-run Form to reconcile");
        const res = await this.run(helper.id, buildNodePromoteScript(target.swarmNodeId));
        if (res.exitCode !== 0) throw new ServiceUnavailableException(`promote failed (exit ${res.exitCode})`);
        await this.markMember(target.id, id, { swarmRole: "MANAGER", swarmError: null });
      } else {
        // JOIN a fresh member (swarmRole === null) directly as a manager. Preflight against a foreign swarm.
        const info = parseSwarmInfo((await this.run(target.id, buildSwarmInfoScript())).output);
        if (info.localNodeState === "active") throw new ConflictException("server is already part of another swarm");
        const dialAddr = this.pickAdvertiseAddr(helper);
        if (!dialAddr) throw new ServiceUnavailableException("no manager has a usable IP to advertise");
        const tokRes = await this.run(helper.id, buildSwarmJoinTokenScript("manager"));
        const token = tokRes.output.trim();
        if (tokRes.exitCode !== 0 || !token) throw new ServiceUnavailableException("could not fetch a manager join token");
        const join = await this.run(target.id, buildSwarmJoinScript(token, dialAddr), JOIN_WS_TIMEOUT_MS);
        // Rotate the manager token UNCONDITIONALLY (even on join failure) so anything that leaked into a process
        // list / stray log stops working within seconds — mirrors form()'s worker-token rotation timing.
        await this.run(helper.id, buildSwarmTokenRotateScript("manager")).catch(() => undefined);
        if (join.exitCode !== 0) throw new ServiceUnavailableException(classifyJoinError(join.exitCode));
        // The node has genuinely joined the swarm as a MANAGER at the docker level. Learn its node id
        // best-effort — but if that follow-up info call fails (WS timeout right after a Raft membership change is
        // realistic), we must STILL persist swarmRole=MANAGER, or the DB would permanently understate a real
        // manager (and quorum math would be wrong) even though it IS in the Raft group. nodeId is reconciled on
        // the next status() poll's live inspect regardless.
        let nodeId: string | null = null;
        try {
          nodeId = parseSwarmInfo((await this.run(target.id, buildSwarmInfoScript())).output).nodeId;
        } catch {
          nodeId = null;
        }
        await this.markMember(target.id, id, { swarmRole: "MANAGER", swarmNodeId: nodeId, swarmError: null });
      }
    } catch (e) {
      // A failed promote/join leaves swarmRole untouched and records only a SANITIZED message (never raw output
      // or the token) — same guarantee as joinWorker's failure path.
      await this.markMember(target.id, id, { swarmError: safeMessage(e) }).catch(() => undefined);
      throw e;
    }

    await this.audit.log({ actor: userId, action: "cluster.swarm.addManager", target: id, meta: { serverId: target.id, managerCount: newCount } });
    return this.view(id);
  }

  /** Remove a MANAGER from the swarm (FLEET-G) — DEMOTE it back to a worker (`docker node demote`), shrinking
   *  the Raft quorum. Refuses to demote the PRIMARY manager (cluster.swarmManagerId — it hosts the swarm-mode
   *  ingress, pinned by node label; moving that pin is out of scope, see swarm-proxy-script.ts) or the only
   *  remaining manager. Idempotent (a non-MANAGER target is a no-op). Same no-cluster-wide-CAS rationale as
   *  addManager. */
  async removeManager(userId: string, id: string, dto: { serverId: string; acknowledgeEvenQuorum?: boolean }): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
      throw new BadRequestException("the swarm must be formed before demoting a manager");
    }
    const members = await this.members(id);
    const target = members.find((m) => m.id === dto.serverId);
    if (!target) throw new BadRequestException("server must be a member of this cluster");
    if (target.swarmRole !== "MANAGER") return this.view(id); // idempotent no-op

    if (target.id === cluster.swarmManagerId) {
      throw new BadRequestException("cannot demote the primary manager — it hosts this cluster's swarm ingress; add another manager instead");
    }
    const currentManagers = members.filter((m) => m.swarmRole === "MANAGER");
    if (currentManagers.length <= 1) {
      throw new BadRequestException("cannot remove the only manager — dissolve the swarm instead, or add another manager first");
    }
    const newCount = currentManagers.length - 1;
    if (newCount % 2 === 0 && !dto.acknowledgeEvenQuorum) {
      throw new BadRequestException(
        `removing this manager brings the total to ${newCount} — an even manager count adds no extra Raft fault-tolerance over ${newCount - 1} while raising the risk of a split vote; pass acknowledgeEvenQuorum to proceed anyway, or remove one more manager instead`,
      );
    }

    // Prefer a DIFFERENT online manager to run the demotion; Docker also supports a manager demoting itself, so
    // fall back to self-dispatch when no other manager is reachable.
    const helper =
      currentManagers.find((m) => m.id !== target.id && m.status === "ONLINE" && m.capabilities.includes("swarm")) ??
      currentManagers.find((m) => m.status === "ONLINE" && m.capabilities.includes("swarm"));
    if (!helper) throw new ServiceUnavailableException("no other online manager available to run this operation");
    if (!target.swarmNodeId) throw new BadRequestException("server's swarm node id is unknown — re-run Form to reconcile");

    try {
      const res = await this.run(helper.id, buildNodeDemoteScript(target.swarmNodeId));
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`demote failed (exit ${res.exitCode})`);
      await this.markMember(target.id, id, { swarmRole: "WORKER", swarmError: null });
    } catch (e) {
      await this.markMember(target.id, id, { swarmError: safeMessage(e) }).catch(() => undefined);
      throw e;
    }

    await this.audit.log({ actor: userId, action: "cluster.swarm.removeManager", target: id, meta: { serverId: target.id, managerCount: newCount } });
    return this.view(id);
  }

  /** Advisory-only precheck (never throws, never blocks): would removing `node` leave a swarm-deployed app
   *  with fewer other ONLINE swarm members than its desired replica count? A coarse "warm bodies" count —
   *  Swarm's own scheduler does the real bin-packing; this just flags the operator BEFORE they strand an app
   *  under-replicated, without hard-refusing the removal. */
  private async replicaRiskWarning(clusterId: string, node: MemberRow): Promise<string | null> {
    try {
      const apps = await this.prisma.application.findMany({ where: { clusterId, replicas: { not: null } }, select: { name: true, replicas: true } });
      if (!apps.length) return null;
      const others = await this.prisma.server.count({ where: { clusterId, id: { not: node.id }, swarmRole: { not: null }, status: "ONLINE" } });
      const short = apps.filter((a) => (a.replicas ?? 1) > others);
      if (!short.length) return null;
      return `removing this node leaves only ${others} other online swarm node(s) — ${short.map((a) => a.name).join(", ")} wants more replicas than that and may run under-replicated`;
    } catch {
      return null;
    }
  }

  /** Remove any app placement constraint (FLEET-D) that pinned to a node just removed from the cluster — by
   *  swarm node id (nodeId rules) or its live docker hostname (hostname rules) — so a decommissioned node can
   *  never leave an app permanently unschedulable. Best-effort per app; never throws. */
  private async stripPlacementNamingNode(clusterId: string, swarmNodeId: string, hostname: string | null): Promise<void> {
    const apps = await this.prisma.application.findMany({ where: { clusterId }, select: { id: true, placement: true } }).catch(() => []);
    for (const a of apps) {
      const p = a.placement as { constraints?: PlacementConstraint[]; spreadLabelKey?: string | null } | null;
      const cons = Array.isArray(p?.constraints) ? p!.constraints : [];
      if (!cons.length) continue;
      const kept = cons.filter((c) => !((c.type === "nodeId" && c.value === swarmNodeId) || (c.type === "hostname" && hostname != null && c.value === hostname)));
      if (kept.length !== cons.length) {
        await this.prisma.application
          .update({ where: { id: a.id }, data: { placement: { constraints: kept, spreadLabelKey: p?.spreadLabelKey ?? null } as unknown as Prisma.InputJsonValue } })
          .catch(() => undefined);
      }
    }
  }

  /** Add/remove docker node labels on a live swarm (cluster-scoped, not app-scoped). Feeds the placement
   *  picker so label-based rules have real keys/values to choose from. Runs a signed `docker node update` on
   *  the manager and returns a fresh status() so the caller re-renders with the new labels. */
  async setNodeLabels(userId: string, id: string, nodeId: string, body: { add: Record<string, string>; remove: string[] }): Promise<SwarmView> {
    const cluster = await this.requireWrite(userId, id);
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") throw new BadRequestException("swarm is not active");
    if (!cluster.swarmManagerId) throw new BadRequestException("cluster has no swarm manager");
    const manager = (await this.members(id)).find((m) => m.id === cluster.swarmManagerId);
    if (!manager || manager.status !== "ONLINE") throw new ServiceUnavailableException("swarm manager is offline");
    const res = await this.run(manager.id, buildNodeLabelUpdateScript(nodeId, body.add, body.remove));
    if (res.exitCode !== 0) throw new BadRequestException("node label update failed");
    await this.audit.log({ actor: userId, action: "cluster.swarm.node.labels", target: id, meta: { nodeId, add: Object.keys(body.add), remove: body.remove } });
    return this.status(userId, id);
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
    const managers = members.filter((m) => m.swarmRole === "MANAGER");
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

    // Managers last. Tear down the swarm-mode Traefik (ingress) ONCE — `docker service rm` is a cluster-wide
    // Raft operation any manager can run — via ANY online manager BEFORE any manager leaves. This is the
    // multi-manager fix for the dissolve path: if the PRIMARY is offline but another manager is up, teardown
    // still runs (single-manager code never attempted it when its one manager was down). If removal isn't
    // CONFIRMED, the proxy may still be bound to :80/:443 — warn loudly instead of silently.
    let proxyWarn: string | null = null;
    if (managers.length > 0) {
      const dispatcher = managers.find((m) => m.status === "ONLINE" && m.capabilities.includes("swarm"));
      if (dispatcher) {
        const proxyGone = await this.swarmProxy.teardown(dispatcher.id, id);
        if (!proxyGone) {
          abandoned = true;
          proxyWarn = "the swarm ingress proxy may STILL be bound to :80/:443 on this host — verify and 'docker service rm tugra-swarm-proxy'";
        }
      } else {
        abandoned = true; // no online manager could tear the ingress down — flagged on the primary's row below
      }
    }

    // Each manager leaves with --force (Docker refuses a manager `swarm leave` without it regardless of how many
    // managers remain). Only the PRIMARY's row carries the ingress warning — it's the node the proxy is pinned to.
    for (const m of managers) {
      const carriesProxyWarn = m.id === cluster.swarmManagerId ? proxyWarn : null;
      if (m.status === "ONLINE" && m.capabilities.includes("swarm")) {
        const res = await this.run(m.id, buildSwarmLeaveScript(true)).catch(() => ({ exitCode: 1, output: "" }));
        if (res.exitCode === 0) {
          // Clear the role but preserve any proxy warning (a successful leave must not mask an orphaned proxy).
          await this.markServer(m.id, { swarmRole: null, swarmNodeId: null, swarmError: carriesProxyWarn });
        } else {
          await this.markServer(m.id, { swarmError: carriesProxyWarn ?? "manager leave failed; local swarm state may remain" });
          abandoned = true;
        }
      } else {
        // Dead-manager abandon path: KEEP its swarmRole/swarmNodeId so a later Form's preflight refuses to
        // blindly re-add a box that may still be a live manager; the operator clears it by hand. The PRIMARY
        // (ingress-pinned) box may STILL be terminating live HTTPS for customer domains — sharper warning.
        await this.markServer(m.id, {
          swarmError:
            m.id === cluster.swarmManagerId
              ? "manager unreachable during dissolve; it may STILL be serving live HTTPS for your domains — verify and run 'docker swarm leave --force' on it"
              : "manager unreachable during dissolve; local swarm state may remain — run 'docker swarm leave --force' on it",
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

  /** Cluster-scoped variant used by addManager/removeManager: `updateMany` with a clusterId re-check, so a
   *  concurrent setServers() that moves this server to another cluster mid-flight can't corrupt an unrelated
   *  cluster's row. (form/dissolve/joinWorker keep the bare markServer to minimize their diff.) Throws when zero
   *  rows matched (the server left this cluster mid-flight) so the caller surfaces the race instead of reporting
   *  a false success + auditing an op whose DB write silently no-op'd. Failure-path callers wrap this in .catch. */
  private async markMember(
    serverId: string,
    clusterId: string,
    data: { swarmRole?: SwarmRole | null; swarmNodeId?: string | null; swarmError?: string | null },
  ): Promise<void> {
    const res = await this.prisma.server.updateMany({ where: { id: serverId, clusterId }, data });
    if (res.count === 0) throw new ConflictException("server left this cluster during the operation");
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
    const swarmStatus = (cluster?.swarmStatus ?? "NONE") as SwarmStatus;
    // Quorum is derived live from Server.swarmRole/status (no persisted column) — the manager SET is simply
    // every MANAGER row for this cluster, not just cluster.swarmManagerId (the PRIMARY). A swarm keeps its
    // control plane only while a strict majority of managers are online.
    const managers = members.filter((m) => m.swarmRole === "MANAGER");
    const managersOnline = managers.filter((m) => m.status === "ONLINE").length;
    const quorum: SwarmQuorum | null =
      swarmStatus === "NONE"
        ? null
        : { managers: managers.length, managersOnline, hasQuorum: managers.length > 0 && managersOnline > managers.length / 2 };
    return {
      clusterId: id,
      swarmStatus,
      managerServerId: cluster?.swarmManagerId ?? null,
      swarmLastError: cluster?.swarmLastError ?? null,
      nodes: members.map((m) => ({
        serverId: m.id,
        name: m.name,
        status: m.status,
        swarmRole: m.swarmRole,
        swarmError: m.swarmError,
        swarmCapable: m.capabilities.includes("swarm"),
        swarmNodeId: m.swarmNodeId,
      })),
      live: null,
      quorum,
    };
  }

  /** Load a cluster and require servers:manage on its team; 404 for non-members. */
  private async requireWrite(
    userId: string,
    id: string,
  ): Promise<{ id: string; teamId: string; swarmStatus: SwarmStatus; swarmManagerId: string | null; ingressReplicas: number }> {
    const cluster = await this.loadCluster(userId, id);
    await this.access.requirePermission(userId, cluster.teamId, "servers:manage");
    return cluster;
  }

  /** Load a cluster requiring only team membership (read); 404 for non-members. */
  private requireRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; teamId: string; swarmStatus: SwarmStatus; swarmManagerId: string | null; ingressReplicas: number }> {
    return this.loadCluster(userId, id);
  }

  private async loadCluster(userId: string, id: string) {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id },
      select: { id: true, teamId: true, swarmStatus: true, swarmManagerId: true, ingressReplicas: true },
    });
    if (!cluster || !(await this.access.teamIds(userId)).includes(cluster.teamId)) {
      throw new NotFoundException("cluster not found");
    }
    return cluster as { id: string; teamId: string; swarmStatus: SwarmStatus; swarmManagerId: string | null; ingressReplicas: number };
  }
}
