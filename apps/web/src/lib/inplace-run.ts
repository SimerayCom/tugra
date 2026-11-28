// What the run view says about an in-place takeover (Coolify hub takeover, lane F inside the guided run). Pure: no React, no network.
// The hub states the facts (the takeover's state, per app whether Coolify's image was reused or the app was rebuilt with Tugra and
// verified); this only turns them into locale keys and counts. Names, refs and codes only.
import type { RunInPlaceView, TakeoverAnswer, TakeoverCheckReason, TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import type { MigrationRunNextAction, MigrationRunStatus, MigrationRunStepKey, MigrationRunView } from "./types";
import { STEP_TITLE_KEY } from "./migration-run";

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

// ───────────────────────────── the simple in-place page ─────────────────────────────

/** What one app of an in-place run is doing, in the one phrase the owner reads next to it. */
export type AppState =
  | "left_out" // not part of the takeover (the issue lines say why)
  | "checking" // started beside Coolify, not yet judged the same
  | "same" // every domain answers like Coolify's copy
  | "needs_look" // a domain answers differently, a rebuild or a database check failed
  | "switching" // the ports are being handed over
  | "live_cert" // Tugra serves it, the new certificate is on its way
  | "live" // Tugra serves it with a new certificate
  | "no_site" // an app without a domain: nothing to compare
  | "database" // taken over on its own data
  | "database_checked" // taken over and the data answers the same
  | "service" // a compose service taken over
  | "given_back"; // Coolify serves it again

export const APP_STATE_KEY: Record<AppState, string> = {
  left_out: "inPlaceRun.app.left_out",
  checking: "inPlaceRun.app.checking",
  same: "inPlaceRun.app.same",
  needs_look: "inPlaceRun.app.needs_look",
  switching: "inPlaceRun.app.switching",
  live_cert: "inPlaceRun.app.live_cert",
  live: "inPlaceRun.app.live",
  no_site: "inPlaceRun.app.no_site",
  database: "inPlaceRun.app.database",
  database_checked: "inPlaceRun.app.database_checked",
  service: "inPlaceRun.app.service",
  given_back: "inPlaceRun.app.given_back",
};

/** Good (green), still going (amber), a problem (red), or nothing to say (muted). */
export function appStateTone(s: AppState): "ok" | "warn" | "danger" | "muted" {
  switch (s) {
    case "same":
    case "live":
    case "database_checked":
      return "ok";
    case "checking":
    case "switching":
    case "live_cert":
      return "warn";
    case "needs_look":
      return "danger";
    default:
      return "muted";
  }
}

const SWITCHED: ReadonlySet<TakeoverStatus> = new Set(["SWAPPED", "VERIFIED"]);

/** The state of one item, from what the hub measured. Nothing is guessed: a check that has not answered is "checking", never "same". */
export function appStateOf(item: TakeoverItemView, takeover: TakeoverStatus): AppState {
  if (item.skipped) return "left_out";
  if (takeover === "GIVEN_BACK" || takeover === "GIVING_BACK") return "given_back";
  if (item.kind === "database") {
    if (item.verify?.state === "failed") return "needs_look";
    return item.verify?.state === "ok" ? "database_checked" : "database";
  }
  if (item.kind === "service") {
    if (item.members?.some((m) => m.ready === "failed" || m.verify?.state === "failed")) return "needs_look";
    return "service";
  }
  if (item.domains.length === 0) return "no_site";
  const switched = SWITCHED.has(takeover);
  if (item.domains.some((d) => d.tempCheck === "failed" || (switched && (d.finalCheck === "failed" || d.cert === "failed")))) return "needs_look";
  if (switched) {
    if (item.domains.every((d) => d.finalCheck === "ok")) return item.domains.every((d) => d.cert === "issued") ? "live" : "live_cert";
    return "switching";
  }
  if (takeover === "SWAPPING") return "switching";
  return item.domains.every((d) => d.tempCheck === "ok") ? "same" : "checking";
}

/** One side of a probe: what the site answered. Null in the check means that side gave no answer at all. */
export interface DomainAnswer {
  status: number | null;
  bytes: number | null;
  location: string | null;
}
/** What the hub kept of a domain's test that did not pass: why, and what each side answered (null = no answer). */
export interface DomainEvidence {
  reason: TakeoverCheckReason;
  coolify: DomainAnswer | null;
  tugra: DomainAnswer | null;
}

type ItemDomain = TakeoverItemView["domains"][number];

const answerOf = (a: TakeoverAnswer | null | undefined): DomainAnswer | null => {
  if (!a) return null;
  const answer = { status: a.status ?? null, bytes: a.bytes ?? null, location: a.location ? a.location : null };
  return answer.status === null && answer.bytes === null && answer.location === null ? null : answer;
};

/**
 * Why a domain did not pass and what Coolify and Tugra each answered, from the `check` the hub sends on the domain while its test has not
 * passed. Null when the hub sent none (the row then says only that it needs a look). A side that did not answer stays null so the row can
 * say "no answer" for it rather than leave it out.
 */
export function domainEvidence(d: ItemDomain): DomainEvidence | null {
  const c = d.check;
  if (!c || c.reason === "ok") return null;
  return { reason: c.reason, coolify: answerOf(c.coolify), tugra: answerOf(c.tugra) };
}

/** The Tugra app behind an item (for its favicon) and the key of its image's brand icon, when the hub sent them. */
export function itemIconHints(item: Pick<TakeoverItemView, "appId" | "iconKey">): { appId: string | null; iconKey: string | null } {
  return { appId: item.appId ? item.appId : null, iconKey: item.iconKey ? item.iconKey : null };
}

/** Domains that answered like Coolify, out of those that count (apps and their domains only). */
export function siteCounts(items: readonly TakeoverItemView[]): { sites: number; same: number; live: number; certified: number; leftOut: number; problems: number } {
  const c = { sites: 0, same: 0, live: 0, certified: 0, leftOut: 0, problems: 0 };
  for (const i of items) {
    if (i.skipped) {
      if (i.kind !== "database") c.leftOut += 1;
      continue;
    }
    if (i.kind === "database" || i.kind === "service") continue;
    for (const d of i.domains) {
      c.sites += 1;
      if (d.tempCheck === "ok") c.same += 1;
      if (d.tempCheck === "failed" || d.finalCheck === "failed" || d.cert === "failed") c.problems += 1;
      if (d.finalCheck === "ok") c.live += 1;
      if (d.finalCheck === "ok" && d.cert === "issued") c.certified += 1;
    }
  }
  return c;
}

/** The first stage that is not done yet (the one the takeover is in), 1-based; the last stage when all are done. */
export function stageLine(status: TakeoverStatus, verified: boolean): { stage: Stage; n: number; state: StageState } {
  const st = stagesOf(status, verified);
  const idx = st.findIndex((s) => s.state === "current" || s.state === "stopped");
  const at = idx >= 0 ? idx : st.length - 1;
  return { stage: st[at].stage, n: at + 1, state: st[at].state };
}

/** The step names of an in-place run: the owner's words, not the copy flow's. A step that does not apply keeps its general name. */
export const IN_PLACE_STEP_TITLE_KEY: Partial<Record<MigrationRunStepKey, string>> = {
  PREFLIGHT: "inPlaceRun.step.PREFLIGHT",
  IMPORT: "inPlaceRun.step.IMPORT",
  REMAP_ENV: "inPlaceRun.step.REMAP_ENV",
  DEPLOY_DARK: "inPlaceRun.step.DEPLOY_DARK",
  VERIFY: "inPlaceRun.step.VERIFY",
  CUTOVER: "inPlaceRun.step.CUTOVER",
  OBSERVE: "inPlaceRun.step.OBSERVE",
  FINALIZE: "inPlaceRun.step.FINALIZE",
};
/** The short in-place page and its words are for a real in-place run; a dry run keeps the current content. */
export const isSimpleInPlace = (run: Pick<MigrationRunView, "inPlace"> & { dryRun?: boolean }): boolean => run.inPlace && !run.dryRun;
export const stepTitleKey = (run: Pick<MigrationRunView, "inPlace"> & { dryRun?: boolean }, key: MigrationRunStepKey): string => (isSimpleInPlace(run) ? IN_PLACE_STEP_TITLE_KEY[key] : undefined) ?? STEP_TITLE_KEY[key];

/** The run's state in plain words, as the header pill says it. */
export function runStateKey(run: Pick<MigrationRunView, "status" | "nextAction">): string {
  switch (run.status) {
    case "QUEUED":
      return "inPlaceRun.state.queued";
    case "PAUSED":
      return "inPlaceRun.state.paused";
    case "FAILED":
      return "inPlaceRun.state.needsLook";
    case "COMPLETED":
      return "inPlaceRun.state.done";
    case "ABORTING":
    case "ROLLING_BACK":
    case "REVERSING":
      return "inPlaceRun.state.givingBack";
    case "ABORTED":
    case "ROLLED_BACK":
    case "REVERSED":
      return "inPlaceRun.state.givenBack";
    case "DRY_RUN_DONE":
      return "inPlaceRun.state.testDone";
    default:
      break;
  }
  switch (run.nextAction.kind) {
    case "approval":
      return "inPlaceRun.state.goAhead";
    case "failed":
    case "gate":
      return "inPlaceRun.state.needsLook";
    case "operator":
    case "session":
      return "inPlaceRun.state.needsYou";
    case "timer":
      return "inPlaceRun.state.watching";
    default:
      return "inPlaceRun.state.moving";
  }
}

/** The one heading of the "what happens now" card, by situation. */
export function nextHeadingKey(kind: MigrationRunNextAction["kind"], stepKey: MigrationRunStepKey | null, status: MigrationRunStatus): string {
  if (status === "QUEUED") return "inPlaceRun.next.ready";
  if (status === "COMPLETED") return "inPlaceRun.next.done";
  if (status === "ABORTED" || status === "ROLLED_BACK" || status === "REVERSED") return "inPlaceRun.next.givenBack";
  if (status === "ABORTING" || status === "ROLLING_BACK" || status === "REVERSING") return "inPlaceRun.next.givingBack";
  switch (kind) {
    case "approval":
      return "inPlaceRun.next.goAhead";
    case "failed":
    case "gate":
      return "inPlaceRun.next.needsLook";
    case "operator":
    case "session":
      return "inPlaceRun.next.connect";
    case "paused":
      return "inPlaceRun.next.paused";
    case "timer":
      return "inPlaceRun.next.watching";
    case "none":
      return "inPlaceRun.next.working";
    default:
      if (stepKey === "DEPLOY_DARK" || stepKey === "VERIFY") return "inPlaceRun.next.checking";
      if (stepKey === "CUTOVER") return "inPlaceRun.next.switching";
      return "inPlaceRun.next.working";
  }
}
