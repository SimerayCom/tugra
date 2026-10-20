/**
 * Pure builders for the shell scripts the agent runs to form/tear-down a Docker Swarm.
 * These only produce `docker swarm|node` command strings — the agent is a
 * generic `sh -c` executor, so nothing on the agent changes.
 *
 * Security notes:
 *  - Every interpolated value is `shq()`-quoted (defence-in-depth even for DB/validated values).
 *  - advertise/manager addresses MUST be IP literals — a non-literal (e.g. a newline-smuggling string)
 *    throws HERE, before any script reaches an agent (mirrors `isPublicIp`'s "reject non-IP" reasoning).
 *  - The worker join-token is a secret. It is only ever interpolated (shq'd) into the join command; the
 *    caller must keep it in a local variable, never log/persist it, and rotate it after joins.
 */
import { isIP } from "node:net";

/** Single-quote a value for safe shell interpolation. */
function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Docker Swarm control-plane port (manager). Workers dial <managerAddr>:2377 to join. */
export const SWARM_MGMT_PORT = 2377;

/** Bound the join so it resolves deterministically well before the WS command timeout fires (otherwise a
 *  worker unable to reach 2377 keeps retrying in the background after the hub already reported a timeout). */
export const SWARM_JOIN_TIMEOUT_SEC = 25;

/** Reject anything that is not a well-formed IPv4/IPv6 literal (isIP → 0). */
function requireIpLiteral(addr: string, label: string): string {
  if (isIP(addr) === 0) throw new Error(`${label} must be an IP literal, got: ${JSON.stringify(addr)}`);
  return addr;
}

/** Local swarm state of this node: `{ LocalNodeState: "active"|"inactive"|..., ControlAvailable, ... }`.
 *  Used as a friendly preflight ("already in a foreign swarm?"). The join/init exit code stays authoritative. */
export function buildSwarmInfoScript(): string {
  return "docker info --format '{{json .Swarm}}'";
}

/** Initialize a new swarm on the manager, advertising a reachable IP for workers to dial. */
export function buildSwarmInitScript(advertiseAddr: string): string {
  const addr = requireIpLiteral(advertiseAddr, "advertise-addr");
  return `docker swarm init --advertise-addr ${shq(addr)} --listen-addr ${shq(`0.0.0.0:${SWARM_MGMT_PORT}`)}`;
}

/** Print (quiet) the current join token for the given role. The "manager" token is higher-privilege — used by
 *  addManager() to grow a multi-manager Raft quorum. */
export function buildSwarmJoinTokenScript(role: "worker" | "manager"): string {
  return `docker swarm join-token -q ${role}`;
}

/** Join an existing swarm as a worker. Wrapped in `timeout` so an unreachable manager fails fast+cleanly. */
export function buildSwarmJoinScript(token: string, managerAddr: string): string {
  const addr = requireIpLiteral(managerAddr, "manager-addr");
  return `timeout ${SWARM_JOIN_TIMEOUT_SEC} docker swarm join --token ${shq(token)} ${shq(`${addr}:${SWARM_MGMT_PORT}`)}`;
}

/** Leave the swarm. Workers leave plainly; the manager needs --force (it's the last node / a manager). */
export function buildSwarmLeaveScript(force: boolean): string {
  return force ? "docker swarm leave --force" : "docker swarm leave";
}

/** List swarm nodes as one JSON object per line (id, hostname, role, availability, state) — for reconcile. */
export function buildNodeLsScript(): string {
  return "docker node ls --format '{{json .}}'";
}

/** Full node inspect (one JSON object per line) — richer than `node ls`: carries Spec.Labels, Spec.Role and
 *  Spec.Availability, which the placement picker needs. Run on a MANAGER. */
export function buildNodeInspectAllScript(): string {
  return "docker node inspect $(docker node ls -q) --format '{{json .}}'";
}

/** Add/remove node labels on the swarm (run on a MANAGER). `nodeId` is the DOCKER swarm node id
 *  (Server.swarmNodeId / SwarmLiveNode.id), never Tugra's Server.id — `docker node update` only knows the former. */
export function buildNodeLabelUpdateScript(nodeId: string, add: Record<string, string>, remove: string[]): string {
  const flags = [
    ...Object.entries(add).map(([k, v]) => `--label-add ${shq(`${k}=${v}`)}`),
    ...remove.map((k) => `--label-rm ${shq(k)}`),
  ];
  return `docker node update ${flags.join(" ")} ${shq(nodeId)}`;
}

/** Rotate (invalidate) the join token for the given role — run after a batch of joins so any token that
 *  leaked into a process list / stray log stops being usable within seconds. */
export function buildSwarmTokenRotateScript(role: "worker" | "manager"): string {
  return `docker swarm join-token --rotate -q ${role}`;
}

/** Bound the drain wait so an operator gets a definitive answer instead of the WS command hanging on a stuck
 *  task. Draining itself ALWAYS proceeds regardless of timeout — the node is left drained (safe, reversible
 *  via `docker node update --availability active`); only the wait for a clean evacuation is time-boxed. */
export const NODE_DRAIN_TIMEOUT_SEC = 90;

/** Drain a node (mark unschedulable, evict its tasks for rescheduling) then poll `docker node ps` until no
 *  RUNNING task remains on it, or timeoutSec elapses. MUST run on a MANAGER — `docker node update`/`node ps`
 *  are Raft-store operations, so this works even if the draining node's own agent is offline/unreachable.
 *  Exits 0 once clean, 2 on timeout (still drained; remaining tasks are likely Pending because there is
 *  nowhere left to schedule — the caller treats this as a soft warning, not a failure). */
export function buildNodeDrainScript(nodeId: string, timeoutSec = NODE_DRAIN_TIMEOUT_SEC): string {
  const id = shq(nodeId);
  const intervalSec = 3;
  const maxIter = Math.max(1, Math.ceil(timeoutSec / intervalSec));
  return [
    `docker node update --availability drain ${id} >/dev/null`,
    `TUGRA_I=0`,
    `while [ "$TUGRA_I" -lt ${maxIter} ]; do`,
    // Capture `node ps`'s OWN exit status separately from the row count, so a transient query failure isn't
    // misread as "zero running tasks" (a false-positive clean drain). Only converge when the query SUCCEEDED
    // and no running task remains; otherwise keep polling until the timeout soft-warning fires.
    `  TUGRA_PS=$(docker node ps ${id} --filter desired-state=running --format '{{.ID}}' 2>/dev/null); TUGRA_RC=$?`,
    `  TUGRA_RUN=$(printf '%s\\n' "$TUGRA_PS" | grep -c .)`,
    `  if [ "$TUGRA_RC" -eq 0 ] && [ "\${TUGRA_RUN:-0}" -eq 0 ]; then echo "TUGRA_DRAIN: clean"; exit 0; fi`,
    `  TUGRA_I=$((TUGRA_I+1)); sleep ${intervalSec}`,
    `done`,
    `echo "TUGRA_DRAIN: timeout"; exit 2`,
  ].join("\n");
}

/** Remove a node from the swarm's member list, run on a MANAGER. --force covers every departure shape: a
 *  node that already ran `swarm leave` cleanly, one that's Down because it was unreachable, or one that never
 *  got the chance to leave locally at all. */
export function buildNodeRemoveScript(nodeId: string): string {
  return `docker node rm --force ${shq(nodeId)}`;
}

/** Promote an existing worker node to MANAGER (grow the Raft quorum), run on a MANAGER. `nodeId` is the DOCKER
 *  swarm node id (Server.swarmNodeId), never Tugra's Server.id — `docker node promote` only knows the former.
 *  Idempotent: promoting an already-manager node is a no-op that exits 0. */
export function buildNodePromoteScript(nodeId: string): string {
  return `docker node promote ${shq(nodeId)}`;
}

/** Demote a MANAGER back to worker (shrink the Raft quorum), run on a MANAGER. `nodeId` is the DOCKER swarm
 *  node id (Server.swarmNodeId). Idempotent: demoting an already-worker node is a no-op that exits 0. The
 *  caller MUST guard against demoting the last reachable manager (that would lose the control plane). */
export function buildNodeDemoteScript(nodeId: string): string {
  return `docker node demote ${shq(nodeId)}`;
}
