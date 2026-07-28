/**
 * Pure builders for the shell scripts the agent runs to form/tear-down a Docker Swarm
 * (Cluster Phase2). These only produce `docker swarm|node` command strings — the agent is a
 * generic `sh -c` executor, so nothing on the agent changes. Deploy is unaffected by this slice.
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

/** Print (quiet) the current join token for the given role. Workers always use "worker" — the "manager"
 *  token is higher-privilege and out of scope for single-manager v1. */
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

/** Rotate (invalidate) the join token for the given role — run after a batch of joins so any token that
 *  leaked into a process list / stray log stops being usable within seconds. */
export function buildSwarmTokenRotateScript(role: "worker" | "manager"): string {
  return `docker swarm join-token --rotate -q ${role}`;
}
