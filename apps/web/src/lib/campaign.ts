// Placement per source server and the campaign of runs a mixed placement becomes (Coolify hub takeover, lane E). Pure: no React, no network.
// The hub decides the runs; this only turns the first step's choice into the request and groups the answer for display.
import type { CampaignRunPlan, PlacementFailureCode, SourcePlacement } from "@tugra/shared";
import { hostOfItemRef, inPlaceCount, overallPlacement, type ImportScope } from "./import-scope";
import type { ImportPlanItem, MigrationRunCreateInput } from "./types";

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
 * no data copy, dark test, new certificates, give back). A lone same-machine server is a campaign of one run.
 */
export const needsCampaign = (scope: Pick<ImportScope, "placementKind"> | null | undefined): boolean => !!scope && (overallPlacement(scope) === "mixed" || inPlaceCount(scope) >= 1);

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
  /** Apps of the same-machine servers to build with Tugra and verify (plan item refs). Absent = every app reuses Coolify's image. */
  rebuild?: string[];
}

/**
 * The campaign request from what a single run would have sent: the shared run fields, minus what the placement decides (target, topology, server
 * map, scope). `confirm` is the number of source servers the owner is placing, which the hub checks against the list.
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
  "placement_teams_differ",
  "placement_rebuild_not_in_place",
  "placement_rebuild_unknown_item",
];
