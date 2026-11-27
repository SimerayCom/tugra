// Guards of the Coolify move that say "this cannot work" at the step where the choice is made, instead of after the click. Each one mirrors a
// refusal the hub would otherwise give later (a run create, a promotion, a cleanup), from facts the screen already has. Pure: no React, no
// network. Ids, refs and codes only.
import type { MoveOffHub, MoveOffServerRow } from "@tugra/shared";
import { ApiError } from "./api";
import { hostTugra, involvedHosts, isControlPlaneHost, serverReadiness, type ImportScope, type ScopeServer, type ServerReadiness } from "./import-scope";
import type { ImportPlan, MigrationRunServerMap, MigrationRunSummary, MigrationRunView, ProxyStatus } from "./types";

// ───────────── topology: the proxy swap needs one machine that is the source's own ─────────────

/** Why a same-server move (proxy swap) cannot be chosen. Mirrors the hub's `swap-*` refusals of a run create. */
export type SwapBlock = "unsupported-source" | "control-plane" | "multi-target" | "not-source-host";

/**
 * The first thing that makes a same-server move impossible for this run, or null. The hub refuses the same things at create:
 * only Coolify has a proxy swap, the box that runs Coolify must keep its proxy, a swap covers one machine, and the target must be the
 * Tugra server that IS the source machine (a missing match is not proof either way, so it blocks too).
 * `refs` are the source servers the run takes something from; none known means every server of the plan.
 */
export function swapProxyBlock(input: { plan: ImportPlan; targetId: string; placement: MigrationRunServerMap | null; refs?: readonly string[] }): SwapBlock | null {
  const { plan, targetId, placement } = input;
  if (plan.sourceKind !== "coolify") return "unsupported-source";
  const refs = input.refs && input.refs.length > 0 ? input.refs : (plan.preflight?.hosts ?? []).map((h) => h.ref);
  if (new Set([targetId, ...Object.values(placement ?? {})].filter(Boolean)).size > 1) return "multi-target";
  if (refs.some((r) => isControlPlaneHost(plan, r))) return "control-plane";
  if (refs.some((r) => hostTugra(plan, r)?.serverId !== (placement?.[r] ?? targetId))) return "not-source-host";
  return null;
}

/** The source servers a scope takes something from (all of the plan when the move is not narrowed or there is no scope). */
export const involvedRefs = (plan: ImportPlan, scope: Pick<ImportScope, "inScope"> | null | undefined): string[] => (scope ? involvedHosts(plan, scope.inScope).map((h) => h.ref) : []);

/**
 * Source servers whose own machine is the chosen target of a copy: a two-box move onto the box the source already runs on would fight its
 * own ports (the campaign refuses it as `placement_other_is_source_host`; a single run has no such check). Returns the refs.
 */
export function copyOntoSourceHost(input: { plan: ImportPlan; targetId: string; placement: MigrationRunServerMap | null; refs?: readonly string[] }): string[] {
  const refs = input.refs && input.refs.length > 0 ? input.refs : (input.plan.preflight?.hosts ?? []).map((h) => h.ref);
  return refs.filter((r) => {
    const own = hostTugra(input.plan, r)?.serverId;
    return !!own && own === (input.placement?.[r] ?? input.targetId);
  });
}

// ───────────── a target that already carries a live guided run ─────────────

/** Statuses the hub holds a server lock for (a real run that has not settled). A dry run holds none. */
const LIVE: ReadonlySet<string> = new Set(["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING", "FAILED"]);

/**
 * Server id to the live real run that holds it. A second run on the same server is refused (`server-has-live-run`), and a run holds every
 * server it places something on (the default target and each placement target), not only its main one.
 */
export function busyServers(runs: readonly Pick<MigrationRunSummary, "id" | "targetServerId" | "targetServerIds" | "status" | "dryRun">[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of runs ?? []) {
    if (r.dryRun || !LIVE.has(r.status)) continue;
    for (const id of r.targetServerIds && r.targetServerIds.length > 0 ? r.targetServerIds : [r.targetServerId]) if (!out.has(id)) out.set(id, r.id);
  }
  return out;
}

// ───────────── taking a server over in place: what the hub refuses at the plan ─────────────

export type TakeoverStartBlock = "server_busy" | "tugra_proxy_in_use";

/** Takeover statuses that hold the server (the hub's own list): from planned until it is given back. */
const LIVE_TAKEOVER: ReadonlySet<string> = new Set(["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "VERIFIED", "GIVING_BACK"]);
export const takeoverIsLive = (status: string | null | undefined): boolean => !!status && LIVE_TAKEOVER.has(status);

/**
 * Why the plan of an in-place takeover would be refused on this server, known before it is started (the hub answers `takeover_server_busy` and
 * `takeover_tugra_proxy_in_use` there). Busy: another live run or takeover holds the server. Proxy: Tugra's own proxy already publishes ports here
 * and runs, so starting it dark for the test would take the apps it serves down. A fact that is not known yet (the server list or the proxy status
 * did not answer) is not judged: the hub still decides.
 */
export function takeoverStartBlock(i: { busyRunId: string | null; takeoverLive: boolean; proxyBind: string | undefined; proxy: ProxyStatus | undefined }): TakeoverStartBlock | null {
  if (i.busyRunId || i.takeoverLive) return "server_busy";
  if (i.proxyBind !== undefined && i.proxyBind !== "none" && i.proxy === "running") return "tugra_proxy_in_use";
  return null;
}

// ───────────── is what the owner reviewed still true? ─────────────

export type Freshness = "plan-changed" | "session-ended";

/** What a failed re-read of the plan (or the campaign preview) says about the review: the source moved on, or the session ended. */
export function freshnessOfError(e: unknown): Freshness | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 409) return "plan-changed";
  if (e.status === 400 || e.status === 404) return "session-ended";
  return null;
}

/** The freshness of the reviewed plan: a re-read with another hash is a changed source, a failed re-read says why. Null while all is well or unknown. */
export function freshnessOf(reviewedHash: string, read: { hash?: string; error?: unknown }): Freshness | null {
  if (read.hash !== undefined) return read.hash !== reviewedHash ? "plan-changed" : null;
  return freshnessOfError(read.error);
}

// ───────────── promoting a finished dry run ─────────────

export type PromoteBlock =
  | { kind: "target"; serverId: string; name: string | null; why: Exclude<ServerReadiness, "ready"> }
  | { kind: "session"; viaAgent: boolean; agentServerId: string | null; sourceTeamRef: string | null };

/**
 * What would make the hub refuse to start the real run from this finished dry run, known now: a target server that is offline, still waiting
 * for its agent or without the deploy grant, and a source session that ended (an hour is shorter than a review). `renewed` is true once the
 * owner has made a new session on this screen. A server the list does not show is not judged (the hub still does).
 */
export function promoteBlocks(run: Pick<MigrationRunView, "targetServers" | "sourceSession" | "inPlace">, servers: ReadonlyArray<ScopeServer>, renewed: boolean): PromoteBlock[] {
  const out: PromoteBlock[] = [];
  for (const t of run.targetServers) {
    const s = servers.find((x) => x.id === t.serverId);
    if (!s) continue;
    const r = serverReadiness(s);
    if (r !== "ready") out.push({ kind: "target", serverId: t.serverId, name: t.serverName, why: r });
  }
  const ss = run.sourceSession;
  if (ss && ss.state !== "active" && !renewed) out.push({ kind: "session", viaAgent: ss.viaAgent, agentServerId: ss.agentServerId, sourceTeamRef: ss.sourceTeamRef });
  return out;
}

// ───────────── Coolify cleanup of one server ─────────────

export type CleanupGuard = "control_plane" | "no_coolify_link" | "read_stale" | "takeover_not_verified";

/** The stored Coolify read a cleanup checks against may be at most this old (the hub's own limit). */
export const CLEANUP_READ_MAX_MS = 30 * 60_000;

/**
 * Why checking this server for a cleanup cannot work yet, from the "Move off Coolify" status the page already loads: it is the Coolify host
 * itself (retired separately), no stored read knows it, the read is too old, or its takeover is not verified yet. Null when it can go ahead or the status is not known.
 */
export function cleanupGuard(row: (Pick<MoveOffServerRow, "coolify" | "isCoolifyHub"> & Partial<Pick<MoveOffServerRow, "takeover">>) | undefined, hub: Pick<MoveOffHub, "readAt"> | null | undefined, now: number): CleanupGuard | null {
  if (!row) return null;
  if (row.isCoolifyHub) return "control_plane";
  if (!row.coolify || !hub) return "no_coolify_link";
  if (!hub.readAt || now - Date.parse(hub.readAt) > CLEANUP_READ_MAX_MS) return "read_stale";
  // only a verified takeover (or none, or one that was given back) lets Coolify's leftovers go: the hub refuses the rest
  if (row.takeover && row.takeover !== "none" && row.takeover !== "VERIFIED" && row.takeover !== "GIVEN_BACK") return "takeover_not_verified";
  return null;
}
