// Placement per source server and the campaign of runs a mixed placement becomes (Coolify hub takeover, lane E). Pure: no React, no network.
// The hub decides the runs; this only turns the first step's choice into the request and groups the answer for display.
import type { CampaignRunPlan, CampaignStatus, CampaignView, PlacementFailureCode, SourcePlacement } from "@tugra/shared";
import { hostOfItemRef, inPlaceCount, overallPlacement, type ImportScope } from "./import-scope";
import { campaignReportHref } from "./migration-run";
import type { ImportPlanItem, MigrationRunCreateInput, MigrationRunScope } from "./types";

/** The first step's choice as placements, in ref order (the same choice always sends the same body). A server with no target yet is left out. */
export function placementsOf(scope: Pick<ImportScope, "placed" | "placementKind">): SourcePlacement[] {
  return Object.keys(scope.placed)
    .sort()
    .map((ref) => {
      const kind = scope.placementKind[ref] ?? "other-server";
      return { sourceServerRef: ref, kind, targetServerId: scope.placed[ref] };
    });
}

/**
 * The move goes through a campaign whenever any server stays on its own machine: only a campaign creates the in-place run (images reused,
 * no data copy, dark test, new certificates, give back). A lone same-machine server is a campaign of one run. So is a move onto servers of
 * several Tugra teams: a run belongs to one team, so the hub makes one campaign per team (same label).
 */
export const needsCampaign = (scope: Pick<ImportScope, "placementKind" | "multiTeam"> | null | undefined): boolean => !!scope && (overallPlacement(scope) === "mixed" || inPlaceCount(scope) >= 1 || scope.multiTeam === true);

export interface CampaignCreateBody {
  sessionId: string;
  planHash: string;
  placements: Array<{ sourceServerRef: string; kind: SourcePlacement["kind"]; targetServerId: string | null }>;
  label?: string;
  confirm: number;
  mode?: MigrationRunCreateInput["mode"];
  dryRun?: boolean;
  options?: MigrationRunCreateInput["options"];
  inputs?: MigrationRunCreateInput["inputs"];
  acks?: MigrationRunCreateInput["acks"];
  serviceChoices?: MigrationRunCreateInput["serviceChoices"];
  dbDataModes?: MigrationRunCreateInput["dbDataModes"];
  /** What the first step picked (absent = every item of the placed source servers). Each run keeps to its own source servers inside it. */
  scope?: MigrationRunScope;
  /** Apps of the same-machine servers to build with Tugra and verify (plan item refs). Absent = every app reuses Coolify's image. */
  rebuild?: string[];
}

/**
 * The campaign request from what a single run would have sent: the shared run fields, minus what the placement decides (target, topology, server
 * map). The first step's scope rides along; the hub narrows each run to its own source servers inside it. `confirm` is the number of source servers the owner is placing, which the hub checks against the list.
 */
export function campaignBody(run: MigrationRunCreateInput, placements: readonly SourcePlacement[], rebuild: readonly string[] = []): CampaignCreateBody {
  return {
    sessionId: run.sessionId,
    planHash: run.planHash,
    placements: placements.map((p) => ({ sourceServerRef: p.sourceServerRef, kind: p.kind, targetServerId: p.targetServerId ?? null })),
    ...(run.campaign?.trim() ? { label: run.campaign.trim() } : {}),
    confirm: placements.length,
    ...(run.mode ? { mode: run.mode } : {}),
    ...(run.dryRun !== undefined ? { dryRun: run.dryRun } : {}),
    ...(run.options ? { options: run.options } : {}),
    ...(run.inputs ? { inputs: run.inputs } : {}),
    ...(run.acks?.length ? { acks: run.acks } : {}),
    ...(run.serviceChoices ? { serviceChoices: run.serviceChoices } : {}),
    ...(run.dbDataModes && Object.keys(run.dbDataModes).length ? { dbDataModes: run.dbDataModes } : {}),
    ...(run.scope ? { scope: run.scope } : {}),
    ...(rebuild.length > 0 ? { rebuild: [...new Set(rebuild)] } : {}),
  };
}

/** An app of a same-machine run the owner may build with Tugra instead of reusing Coolify's image. */
export interface RebuildChoice {
  itemRef: string;
  name: string;
}

/**
 * The apps the picker offers for one run of the plan: the plan's apps (in scope, when the first step narrowed the move) that live on the run's
 * source servers. Only a same-machine run builds anything; any other run has no choice. Services and databases are not offered.
 */
export function rebuildChoicesOf(run: CampaignRunPlan, items: readonly Pick<ImportPlanItem, "itemRef" | "kind" | "name">[], inScope?: ReadonlySet<string>): RebuildChoice[] {
  if (run.kind !== "in-place") return [];
  const hosts = new Set(sourcesOfRun(run));
  return items.filter((i) => i.kind === "app" && hosts.has(hostOfItemRef(i.itemRef)) && (!inScope || inScope.has(i.itemRef))).map((i) => ({ itemRef: i.itemRef, name: i.name }));
}

/** What survives of the owner's choice after the placement changed: only apps some same-machine run still offers (never a ref the hub would refuse). */
export function pruneRebuild(chosen: readonly string[], runs: readonly CampaignRunPlan[] | null | undefined, items: readonly Pick<ImportPlanItem, "itemRef" | "kind" | "name">[], inScope?: ReadonlySet<string>): string[] {
  const offered = new Set((runs ?? []).flatMap((r) => rebuildChoicesOf(r, items, inScope).map((c) => c.itemRef)));
  return chosen.filter((r) => offered.has(r));
}

/** The runs of a plan grouped by wave, in wave order. Runs of one wave may run together. */
export function runsByWave(runs: readonly CampaignRunPlan[]): Array<{ wave: number; runs: CampaignRunPlan[] }> {
  const m = new Map<number, CampaignRunPlan[]>();
  for (const r of runs) m.set(r.wave, [...(m.get(r.wave) ?? []), r]);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([wave, rs]) => ({ wave, runs: rs }));
}

/** The source servers a run of the plan carries. */
export const sourcesOfRun = (r: CampaignRunPlan): string[] => (r.sourceServerRefs && r.sourceServerRefs.length > 0 ? r.sourceServerRefs : [r.sourceServerRef]);

/** The locale key of a refusal. A code the web does not know falls back to the generic line. */
export function placementFailureKey(code: string): string {
  return (KNOWN_FAILURES as readonly string[]).includes(code) ? `placement.failure.${code}` : "placement.failure.unknown";
}
const KNOWN_FAILURES: readonly PlacementFailureCode[] = [
  "placement_empty",
  "placement_duplicate",
  "placement_unknown_source",
  "placement_in_place_locked",
  "placement_in_place_target_mismatch",
  "placement_target_missing",
  "placement_target_unknown",
  "placement_target_not_ready",
  "placement_other_is_source_host",
  "placement_rebuild_not_in_place",
  "placement_rebuild_unknown_item",
  "placement_team_mismatch",
  "placement_target_shared",
  "placement_in_place_partial",
  "placement_scope_empty",
  "placement_scope_invalid",
  "placement_takeover_busy",
  "placement_tugra_proxy_in_use",
];

/** What creating a campaign returns: the first campaign (the shape of an older hub) plus every campaign made, one per team. */
export type CampaignCreated = CampaignView & { campaigns?: CampaignView[] };

/** Every campaign a create made (an older hub answers with the one). */
export const campaignsOf = (created: CampaignCreated): CampaignView[] => (created.campaigns && created.campaigns.length > 0 ? created.campaigns : [created]);

/** Where the owner lands after a create: the report of the label, which holds the runs of every campaign made under it. */
export const campaignOpenHref = (created: CampaignCreated): string => campaignReportHref(created.label);

/** The campaigns of one label (one per team) as one line: runs added up, the teams counted, the state that needs attention first. */
export interface CampaignGroup {
  label: string;
  status: CampaignStatus;
  runs: number;
  teams: number;
  createdAt: string;
  ids: string[];
}

const STATUS_RANK: readonly CampaignStatus[] = ["paused", "running", "draft", "done", "cancelled"];

/** One row per label, newest first. A label's status is the one that needs the owner soonest: paused, then running, draft, done, cancelled. */
export function groupCampaigns(views: readonly CampaignView[]): CampaignGroup[] {
  const by = new Map<string, CampaignView[]>();
  for (const v of views) by.set(v.label, [...(by.get(v.label) ?? []), v]);
  return [...by.entries()]
    .map(([label, vs]) => ({
      label,
      status: STATUS_RANK.find((s) => vs.some((v) => v.status === s)) as CampaignStatus,
      runs: vs.reduce((n, v) => n + v.runIds.length, 0),
      teams: new Set(vs.map((v) => v.teamId ?? v.id)).size,
      createdAt: vs.map((v) => v.createdAt).sort().at(-1) as string,
      ids: vs.map((v) => v.id),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** The run of a campaign that stands for one planned run: the same kind (same machine or copy) on the same target, the newest one (a dry run that was promoted is replaced by the real run it made). */
type GuideRun = { id: string; targetServerId: string; inPlace: boolean; status: string; createdAt: string };

/**
 * Which wave each run of a campaign belongs to, and which run to start next. The hub plans the waves (the copy first, then one same-machine server
 * after the other) but a run does not carry its wave, so it is found by what the plan says: the kind and the target. A run is "next" when it can be
 * started (queued, or a finished dry run) and every run of an earlier wave of the same campaign has completed. A cancelled campaign has none.
 */
export function campaignGuide(views: readonly Pick<CampaignView, "plan" | "status">[], runs: readonly GuideRun[]): { waveOf: Map<string, number>; next: Set<string> } {
  const waveOf = new Map<string, number>();
  const next = new Set<string>();
  const newest = (kind: CampaignRunPlan["kind"], target: string): GuideRun | undefined =>
    runs.filter((r) => r.inPlace === (kind === "in-place") && r.targetServerId === target).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  for (const v of views) {
    const planned = [...v.plan].sort((a, b) => a.wave - b.wave).map((p) => ({ p, run: newest(p.kind, p.targetServerId) }));
    for (const { p } of planned) for (const r of runs) if (r.inPlace === (p.kind === "in-place") && r.targetServerId === p.targetServerId) waveOf.set(r.id, p.wave);
    if (v.status === "cancelled" || v.status === "done") continue;
    for (const { run } of planned) {
      if (!run) break;
      if (run.status === "COMPLETED") continue;
      if (run.status === "QUEUED" || run.status === "DRY_RUN_DONE") next.add(run.id);
      break;
    }
  }
  return { waveOf, next };
}

/** Whether a campaign still has something to cancel: not already cancelled or done. */
export const campaignCancellable = (v: Pick<CampaignView, "status">): boolean => v.status !== "cancelled" && v.status !== "done";

// ───────────────────────────── the campaign's home: one headline, one action ─────────────────────────────

export type CampaignHeadlineKind = "done" | "cancelled" | "failed" | "preparing" | "needs" | "ready" | "paused" | "moving" | "review";

export interface CampaignHeadline {
  kind: CampaignHeadlineKind;
  /** Runs the plan calls for (the runs made so far when the plan is not readable). */
  total: number;
  made: number;
  completed: number;
  /** The first failed run, and the runs that wait for the owner (the hub's own next-action kind says so). */
  failedRunId: string | null;
  needs: string[];
  /** Queued real runs: what "Start all" would hand to the hub. */
  queued: number;
  /** The one action of the page: start (nothing moved yet), continue (the hub was paused or stopped), or none. */
  action: "start" | "continue" | null;
  /** The hub is driving the waves now: offer to hold back the servers that have not started. */
  canPause: boolean;
}

/** The state of the whole campaign in one word, and the one thing to do about it. Pure: summaries of the runs, the campaigns of the label (when the viewer may read them) and the ids of the runs that wait for the owner. */
export function campaignHeadline(
  views: readonly Pick<CampaignView, "plan" | "status" | "driving">[],
  runs: ReadonlyArray<{ id: string; status: string; dryRun: boolean; createdAt?: string }>,
  needsRunIds: readonly string[],
): CampaignHeadline {
  const planned = views.reduce((n, v) => n + v.plan.length, 0);
  const made = runs.length;
  const total = planned > 0 ? planned : made;
  const completed = runs.filter((r) => r.status === "COMPLETED").length;
  const queued = runs.filter((r) => r.status === "QUEUED" && !r.dryRun).length;
  const driving = views.some((v) => v.driving === true);
  const cancelled = views.length > 0 && views.every((v) => v.status === "cancelled");
  const failed = runs.find((r) => r.status === "FAILED") ?? null;
  const started = runs.some((r) => r.status !== "QUEUED" && r.status !== "DRY_RUN_DONE");
  const base = { total, made, completed, failedRunId: failed?.id ?? null, needs: [...needsRunIds], queued };
  const pick = (kind: CampaignHeadlineKind): CampaignHeadline => {
    const startable = queued > 0 && !driving && !cancelled && kind !== "done" && kind !== "preparing";
    return { kind, ...base, action: startable ? (started ? "continue" : "start") : null, canPause: driving && queued > 0 && !cancelled };
  };
  if (cancelled) return pick("cancelled");
  if (made > 0 && completed === made && made >= total) return pick("done");
  if (failed) return pick("failed");
  if (made < total) return pick("preparing");
  if (needsRunIds.length > 0) return pick("needs");
  // queued servers the hub is not driving: ready (nothing started) or paused; a viewer who cannot read the campaigns cannot tell, and is not told either
  if (queued > 0 && !driving && views.length > 0) return pick(started ? "paused" : "ready");
  if (runs.some((r) => r.status === "DRY_RUN_DONE") && !runs.some((r) => !["DRY_RUN_DONE", "COMPLETED"].includes(r.status))) return pick("review");
  return pick("moving");
}

/** The position of each run among the campaign's waves ("wave 2 of 6"): the plan's wave numbers, ranked. Absent when the viewer cannot read the plan. */
export function waveRanks(views: readonly Pick<CampaignView, "plan" | "status">[], runs: readonly GuideRun[]): { rankOf: Map<string, number>; count: number } {
  const { waveOf } = campaignGuide(views, runs);
  const waves = [...new Set(views.flatMap((v) => v.plan.map((p) => p.wave)))].sort((a, b) => a - b);
  const rankOf = new Map<string, number>();
  for (const [id, w] of waveOf) rankOf.set(id, waves.indexOf(w) + 1);
  return { rankOf, count: waves.length };
}
