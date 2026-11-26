/**
 * Placement and campaign planning (Coolify hub takeover, lane E). Pure: no database, no agent, no clock. A source server is
 * placed in place (the same machine, proxy swap, no data copy) or on another Tugra server (data copy, two-box). A mixed placement
 * becomes a campaign of guided runs: the other-server placements travel together in one two-box run (so an app and the database it
 * talks to on another source server stay in one run), and every in-place server gets its own swap-proxy run, one after the other.
 * Names, refs and ids only; a source address never enters here.
 */
import { hostOfItemRef } from "../migration-runs/core/run-scope";
import type {
  CampaignRunPlan,
  CampaignStatus,
  CampaignTeamPlan,
  HostEvidence,
  HostLinkedBy,
  HostMatchStatus,
  PlacementFailureCode,
  PlacementKind,
  PlacementLockReason,
  SourcePlacement,
  SourceServerPlacementView,
} from "@tugra/shared";

/** What the hub knows about one source server when the owner chooses where it goes. */
export interface PlacementHostFact {
  ref: string;
  name: string;
  /** The box the Coolify control plane runs on: stopping its proxy would take the panel of every managed server away. */
  controlPlane: boolean;
  matchStatus: HostMatchStatus;
  linkedBy: HostLinkedBy | null;
  evidence: HostEvidence[];
  /** The Tugra server that is the same machine (certain and probable only). */
  matchedServerId: string | null;
  agentOnline: boolean;
}

/** A Tugra server a placement may name as its target. */
export interface PlacementTarget {
  id: string;
  teamId: string;
  /** Agent ONLINE and the `deploy` capability granted (the same gate a run create applies). */
  ready: boolean;
}

/** Why "in place" is not offered for a server, or null when it is. The order is the order the owner should fix things in. */
export function inPlaceLock(f: PlacementHostFact): PlacementLockReason | null {
  if (f.controlPlane) return "control_plane";
  if (f.matchStatus === "ambiguous") return "match_uncertain";
  // no Tugra server is this machine (or a verdict with no server behind it): there is no agent on the box to take it over
  if (f.matchStatus === "none" || !f.matchedServerId) return "agent_missing";
  if (!f.agentOnline) return "agent_offline";
  return null;
}

/** What the screen preselects: in place for a sure match that is not the control plane box; the control plane box goes elsewhere; nothing otherwise. */
export function suggestedPlacement(f: PlacementHostFact): PlacementKind | null {
  if (f.controlPlane) return "other-server";
  if (f.matchStatus === "certain" && inPlaceLock(f) === null) return "in-place";
  return null;
}

export function placementViews(facts: readonly PlacementHostFact[]): SourceServerPlacementView[] {
  return facts.map((f) => ({
    sourceServerRef: f.ref,
    name: f.name,
    matchStatus: f.matchStatus,
    linkedBy: f.linkedBy,
    evidence: f.evidence,
    matchedServerId: f.matchedServerId,
    agentOnline: f.agentOnline,
    controlPlane: f.controlPlane,
    inPlaceLocked: inPlaceLock(f),
    suggested: suggestedPlacement(f),
  }));
}



/** The placements that land on the servers of one Tugra team: one campaign is made per team. */
export interface TeamPlacements {
  teamId: string;
  placements: SourcePlacement[];
}

/** `teamId` is the first team (kept for a caller that has one team); `teams` is every team the targets sit in, in ref order of their first source server. */
export type PlacementCheck = { ok: true; teamId: string; teams: TeamPlacements[]; placements: SourcePlacement[] } | { ok: false; code: PlacementFailureCode; ref?: string; reason?: PlacementLockReason };

/**
 * Check the owner's choices against what the hub knows. In place is refused for a locked server and its target is always the matched
 * Tugra server (a different target named for an in-place choice is a mismatch, never silently replaced). Another server must exist, be
 * ready, and not be the machine the source runs on (a "copy" onto the same box would fight its own ports). The targets may sit in several
 * teams (a Coolify's servers are often spread over the teams of one owner): the result groups the placements by target team, one campaign
 * each. The returned placements are normalised: an in-place choice carries its matched server.
 */
export function checkPlacements(placements: readonly SourcePlacement[], facts: readonly PlacementHostFact[], targets: ReadonlyMap<string, PlacementTarget>): PlacementCheck {
  if (placements.length === 0) return { ok: false, code: "placement_empty" };
  const byRef = new Map(facts.map((f) => [f.ref, f] as const));
  const seen = new Set<string>();
  const out: SourcePlacement[] = [];
  const teamOf = new Map<string, string>();
  for (const p of placements) {
    if (seen.has(p.sourceServerRef)) return { ok: false, code: "placement_duplicate", ref: p.sourceServerRef };
    seen.add(p.sourceServerRef);
    const f = byRef.get(p.sourceServerRef);
    if (!f) return { ok: false, code: "placement_unknown_source", ref: p.sourceServerRef };
    let targetId: string;
    if (p.kind === "in-place") {
      const lock = inPlaceLock(f);
      if (lock) return { ok: false, code: "placement_in_place_locked", ref: f.ref, reason: lock };
      targetId = f.matchedServerId as string;
      if (p.targetServerId && p.targetServerId !== targetId) return { ok: false, code: "placement_in_place_target_mismatch", ref: f.ref };
    } else {
      if (!p.targetServerId) return { ok: false, code: "placement_target_missing", ref: f.ref };
      targetId = p.targetServerId;
      if (f.matchedServerId && f.matchedServerId === targetId) return { ok: false, code: "placement_other_is_source_host", ref: f.ref };
    }
    const t = targets.get(targetId);
    if (!t) return { ok: false, code: "placement_target_unknown", ref: f.ref };
    if (!t.ready) return { ok: false, code: "placement_target_not_ready", ref: f.ref };
    teamOf.set(f.ref, t.teamId);
    out.push({ sourceServerRef: f.ref, kind: p.kind, targetServerId: targetId });
  }
  const teams = groupByTeam(out, teamOf);
  return { ok: true, teamId: teams[0].teamId, teams, placements: out };
}

/** The placements grouped by the team of their target. Deterministic: placements in source ref order inside a team, teams in the order of their first ref. */
export function groupByTeam(placements: readonly SourcePlacement[], teamOf: ReadonlyMap<string, string>): TeamPlacements[] {
  const sorted = [...placements].sort((a, b) => (a.sourceServerRef < b.sourceServerRef ? -1 : a.sourceServerRef > b.sourceServerRef ? 1 : 0));
  const byTeam = new Map<string, SourcePlacement[]>();
  for (const p of sorted) {
    const teamId = teamOf.get(p.sourceServerRef) as string;
    byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), p]);
  }
  return [...byTeam.entries()].map(([teamId, ps]) => ({ teamId, placements: ps }));
}

/**
 * The runs a placement becomes. Wave 0 is the single two-box run of every other-server placement (its first server in ref order is the
 * run's default target, the rest ride in a server map); each in-place server follows in its own wave, in ref order, so only one
 * proxy swap is in flight at a time. Deterministic: the same choices give the same plan.
 */
export function planCampaign(placements: readonly SourcePlacement[]): CampaignRunPlan[] {
  const sorted = [...placements].sort((a, b) => (a.sourceServerRef < b.sourceServerRef ? -1 : a.sourceServerRef > b.sourceServerRef ? 1 : 0));
  const other = sorted.filter((p) => p.kind === "other-server");
  const inPlace = sorted.filter((p) => p.kind === "in-place");
  const runs: CampaignRunPlan[] = [];
  let wave = 0;
  if (other.length > 0) {
    runs.push({
      sourceServerRef: other[0].sourceServerRef,
      ...(other.length > 1 ? { sourceServerRefs: other.map((p) => p.sourceServerRef) } : {}),
      kind: "other-server",
      targetServerId: other[0].targetServerId as string,
      topology: "two-box",
      wave,
    });
    wave += 1;
  }
  for (const p of inPlace) {
    runs.push({ sourceServerRef: p.sourceServerRef, kind: "in-place", targetServerId: p.targetServerId as string, topology: "swap-proxy", wave });
    wave += 1;
  }
  return runs;
}

/**
 * The runs of every team's campaign: each team's placements are planned on their own (waves count per team), then the owner's rebuild
 * choices are handed to the in-place run of their own server wherever that run is. A rebuild ref that belongs to no in-place run of
 * any team is refused as {@link withRebuild} refuses it.
 */
export function planTeams(teams: readonly TeamPlacements[], rebuild: readonly string[], appRefs: ReadonlySet<string>): { ok: true; teams: CampaignTeamPlan[] } | { ok: false; code: PlacementFailureCode; ref: string } {
  const base = teams.map((t) => planCampaign(t.placements));
  const withChoices = withRebuild(base.flat(), rebuild, appRefs);
  if (!withChoices.ok) return withChoices;
  let at = 0;
  return {
    ok: true,
    teams: teams.map((t, i) => {
      const runs = withChoices.runs.slice(at, at + base[i].length);
      at += base[i].length;
      return { teamId: t.teamId, servers: t.placements.length, runs };
    }),
  };
}

/** The service choices that belong to the source servers of one run (a choice for a service of another team's run is not this run's to carry). */
export function serviceChoicesOfRun<T>(choices: Readonly<Record<string, T>> | undefined, run: CampaignRunPlan): Record<string, T> | undefined {
  if (!choices) return undefined;
  const mine = new Set(refsOfRun(run));
  const kept = Object.entries(choices).filter(([itemRef]) => mine.has(hostOfItemRef(itemRef)));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Hand each in-place run the apps of its own source server that the owner chose to rebuild with Tugra. A ref the plan has no app for is
 * `placement_rebuild_unknown_item`; one on a source server that is not placed in place (its data is copied and built anyway) is
 * `placement_rebuild_not_in_place`. The input order is kept inside a run and duplicates are dropped; a run with none carries no list.
 * Pure: `appRefs` is the set of app item refs of the plan the owner reviewed.
 */
export function withRebuild(runs: readonly CampaignRunPlan[], rebuild: readonly string[], appRefs: ReadonlySet<string>): { ok: true; runs: CampaignRunPlan[] } | { ok: false; code: PlacementFailureCode; ref: string } {
  const byRun = new Map<CampaignRunPlan, string[]>();
  for (const ref of new Set(rebuild)) {
    if (!appRefs.has(ref)) return { ok: false, code: "placement_rebuild_unknown_item", ref };
    const host = hostOfItemRef(ref);
    const run = runs.find((r) => r.kind === "in-place" && refsOfRun(r).includes(host));
    if (!run) return { ok: false, code: "placement_rebuild_not_in_place", ref };
    byRun.set(run, [...(byRun.get(run) ?? []), ref]);
  }
  return { ok: true, runs: runs.map((r) => (byRun.has(r) ? { ...r, rebuild: byRun.get(r) as string[] } : r)) };
}

/** The source servers a run of the plan carries. */
export const refsOfRun = (r: CampaignRunPlan): string[] => (r.sourceServerRefs && r.sourceServerRefs.length > 0 ? r.sourceServerRefs : [r.sourceServerRef]);

/** Source server ref to Tugra server for a run that spans several targets (undefined for a single target: the run's own target is the default). */
export function serverMapOfRun(r: CampaignRunPlan, placements: readonly SourcePlacement[]): Record<string, string> | undefined {
  const refs = refsOfRun(r);
  const map: Record<string, string> = {};
  for (const ref of refs) {
    const p = placements.find((x) => x.sourceServerRef === ref);
    if (p?.targetServerId) map[ref] = p.targetServerId;
  }
  return new Set(Object.values(map)).size > 1 ? map : undefined;
}

/** A campaign label that is unique enough per team and readable: `campaign-20261126-1432-ab12`. */
export function newCampaignLabel(now: Date, rand: () => number = Math.random): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  const tail = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `campaign-${stamp}-${tail}`;
}

const LIVE_RUN = new Set(["RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING"]);
const FAILED_RUN = new Set(["FAILED", "ABORTED", "ROLLED_BACK", "REVERSED"]);

/**
 * The campaign's status from its runs. A cancelled campaign stays cancelled. Every run COMPLETED is done; any run still moving is running;
 * a failed or aborted run with others not finished pauses the campaign (the owner decides); otherwise it is a draft (runs created, none started).
 */
export function deriveCampaignStatus(stored: CampaignStatus, runStatuses: readonly string[]): CampaignStatus {
  if (stored === "cancelled") return "cancelled";
  if (runStatuses.length === 0) return stored;
  if (runStatuses.every((s) => s === "COMPLETED")) return "done";
  if (runStatuses.some((s) => LIVE_RUN.has(s))) return "running";
  if (runStatuses.some((s) => FAILED_RUN.has(s) || s === "COMPLETED")) return "paused";
  return "draft";
}
