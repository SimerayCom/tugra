// What the run view says about an in-place takeover (Coolify hub takeover, lane F inside the guided run). Pure: no React, no network.
// The hub states the facts (the takeover's state, per app whether Coolify's image was reused or the app was rebuilt with Tugra and
// verified); this only turns them into locale keys and counts. Names, refs and codes only.
import type { RunInPlaceView, TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import type { MigrationRunStepKey } from "./types";

/** What happened to one app of an in-place run, in the words the owner reads. */
export type AppOutcome =
  | "reused" // Coolify's image runs under Tugra (the default)
  | "rebuilding" // chosen for a rebuild, still being built or not yet checked
  | "rebuilt_verified" // built with Tugra and it answered like Coolify's copy
  | "rebuilt_check_failed" // built with Tugra but a domain did not answer like Coolify's copy
  | "rebuild_failed" // chosen for a rebuild and the build failed: the app is left out
  | "rebuild_declined" // chosen for a rebuild but it shares data with Coolify's copy: reuses the image
  | "skipped" // left out of the takeover, with its reason
  | "database"; // a database taken over on its own data volume

/** The outcome of one app. A database is its own kind and never counts as a rebuild. */
export function outcomeOf(i: Pick<TakeoverItemView, "kind" | "buildMode" | "skipped" | "issues" | "domains" | "rebuildDeclined">): AppOutcome {
  if (i.kind === "database") return i.skipped ? "skipped" : "database";
  if (i.skipped) return i.issues?.includes("rebuild_failed") ? "rebuild_failed" : "skipped";
  if (i.buildMode === "rebuild-verify") {
    if (i.domains.some((d) => d.tempCheck === "failed")) return "rebuilt_check_failed";
    return i.domains.length > 0 && i.domains.every((d) => d.tempCheck === "ok") ? "rebuilt_verified" : "rebuilding";
  }
  return i.rebuildDeclined ? "rebuild_declined" : "reused";
}

export const OUTCOME_KEY: Record<AppOutcome, string> = {
  reused: "inPlaceRun.outcome.reused",
  rebuilding: "inPlaceRun.outcome.rebuilding",
  rebuilt_verified: "inPlaceRun.outcome.rebuilt_verified",
  rebuilt_check_failed: "inPlaceRun.outcome.rebuilt_check_failed",
  rebuild_failed: "inPlaceRun.outcome.rebuild_failed",
  rebuild_declined: "inPlaceRun.outcome.rebuild_declined",
  skipped: "inPlaceRun.outcome.skipped",
  database: "inPlaceRun.outcome.database",
};

/** Good (green), still going (amber), or a problem the owner should look at (red). */
export function outcomeTone(o: AppOutcome): "ok" | "warn" | "danger" | "muted" {
  switch (o) {
    case "rebuilt_verified":
    case "reused":
    case "database":
      return "ok";
    case "rebuilding":
    case "rebuild_declined":
      return "warn";
    case "rebuilt_check_failed":
    case "rebuild_failed":
      return "danger";
    case "skipped":
      return "muted";
  }
}

export interface OutcomeCounts {
  apps: number;
  reused: number;
  rebuiltVerified: number;
  rebuilding: number;
  problems: number;
  declined: number;
  skipped: number;
  databases: number;
}

/** How many apps took each road. Apps and databases are counted apart; a skipped app is in neither of the others. */
export function outcomeCounts(items: readonly TakeoverItemView[]): OutcomeCounts {
  const c: OutcomeCounts = { apps: 0, reused: 0, rebuiltVerified: 0, rebuilding: 0, problems: 0, declined: 0, skipped: 0, databases: 0 };
  for (const i of items) {
    const o = outcomeOf(i);
    if (o === "database") c.databases += 1;
    else c.apps += 1;
    if (o === "reused") c.reused += 1;
    else if (o === "rebuilt_verified") c.rebuiltVerified += 1;
    else if (o === "rebuilding") c.rebuilding += 1;
    else if (o === "rebuilt_check_failed" || o === "rebuild_failed") c.problems += 1;
    else if (o === "rebuild_declined") c.declined += 1;
    else if (o === "skipped" && i.kind !== "database") c.skipped += 1;
  }
  return c;
}

/** The stages an in-place run goes through, in order, for the little tracker above the apps. */
export const STAGES = ["planned", "tested", "handedOver", "verified"] as const;
export type Stage = (typeof STAGES)[number];
export type StageState = "done" | "current" | "todo" | "stopped";

/**
 * Where the takeover is, stage by stage. A takeover that is being given back, was given back or failed shows the stage it reached as
 * `stopped` (never as done), so a failure is never drawn as progress.
 */
export function stagesOf(status: TakeoverStatus, verified: boolean): Array<{ stage: Stage; state: StageState }> {
  const reached: Record<TakeoverStatus, number> = { PLANNED: 0, TESTING: 1, SWAPPING: 2, SWAPPED: 2, VERIFIED: 3, GIVING_BACK: 0, GIVEN_BACK: 0, FAILED: 0 };
  const stopped = status === "GIVING_BACK" || status === "GIVEN_BACK" || status === "FAILED";
  const at = status === "VERIFIED" || verified ? 3 : reached[status];
  return STAGES.map((stage, n) => {
    if (stopped) return { stage, state: n === 0 ? "stopped" : "todo" };
    if (n < at) return { stage, state: "done" };
    if (n === at) return { stage, state: at === 3 ? "done" : "current" };
    return { stage, state: "todo" };
  });
}

/** True while the takeover changes without a click (the run view keeps asking until it settles). */
export const inPlaceBusy = (status: TakeoverStatus | null | undefined): boolean => status === "TESTING" || status === "SWAPPING" || status === "SWAPPED" || status === "GIVING_BACK";

/**
 * What the takeover's state means for one step of the run, as a locale key; null when it has nothing to add. Only the steps an in-place
 * run really does differently carry a note: DEPLOY_DARK (the test beside Coolify), VERIFY (the owner's review) and CUTOVER (the ports).
 */
export function stepNoteKey(step: MigrationRunStepKey, status: TakeoverStatus | null | undefined): string | null {
  if (!status) return null;
  const n = (k: string): string => `inPlaceRun.stepNote.${step}.${k}`;
  switch (step) {
    case "DEPLOY_DARK":
      if (status === "PLANNED") return n("planned");
      if (status === "TESTING") return n("tested");
      if (status === "GIVING_BACK" || status === "GIVEN_BACK") return n("gaveBack");
      if (status === "FAILED") return n("failed");
      return n("done");
    case "VERIFY":
      return status === "TESTING" ? n("review") : null;
    case "CUTOVER":
      if (status === "SWAPPING") return n("swapping");
      if (status === "SWAPPED") return n("swapped");
      if (status === "VERIFIED") return n("verified");
      if (status === "GIVING_BACK" || status === "GIVEN_BACK") return n("gaveBack");
      if (status === "FAILED") return n("failed");
      return null;
    default:
      return null;
  }
}

/** Every app of the view with its outcome, in the order the hub lists them: apps first, databases after. */
export function rowsOf(v: Pick<RunInPlaceView, "items">): Array<{ item: TakeoverItemView; outcome: AppOutcome }> {
  const rows = v.items.map((item) => ({ item, outcome: outcomeOf(item) }));
  return [...rows.filter((r) => r.outcome !== "database"), ...rows.filter((r) => r.outcome === "database")];
}
