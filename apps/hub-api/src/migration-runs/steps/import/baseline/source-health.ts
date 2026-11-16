/**
 * The source health baseline (R28/R52/R66), pure. PREFLIGHT reads how every source app, database and service is doing before
 * anything changes; VERIFY and OBSERVE judge Tugra against THAT, not against perfection: an app that was crash-looping at the
 * source (90k restarts, exited for weeks) is not a regression when it fails on Tugra too, and an app with no health check
 * (most of the apps of a real fleet) has a defined `unknown`, never a silent pass.
 */
import type { SourceHealthRow } from "../../../../importer/import-source";
import { ns } from "../../../../importer/import-planner";
import { SourceBaselineSchema, type SourceBaseline } from "../../../core/dto";

/** A container restarted this often and not currently healthy is crash-looping, whatever its status string says. */
export const CRASH_LOOP_RESTARTS = 10;
/** The most entries a baseline keeps (the schema cap). */
const MAX_ENTRIES = 5000;

export type BaselineEntry = SourceBaseline["entries"][number];

/** The plan itemRef of a baseline entry (`kind:<serverRef|_>:<ref>`): how a plan item finds its baseline. */
export const baselineItemRef = (e: Pick<BaselineEntry, "kind" | "serverRef" | "ref">): string => ns(e.kind, e.serverRef, e.ref);

/** A baseline from the source's rows: de-duplicated by itemRef, sorted for a stable comparison, capped. */
export function buildSourceBaseline(rows: readonly SourceHealthRow[], now: Date): SourceBaseline {
  const byRef = new Map<string, BaselineEntry>();
  for (const r of rows) {
    const e: BaselineEntry = { kind: r.kind, ref: r.ref, ...(r.serverRef ? { serverRef: r.serverRef } : {}), health: r.health, restartCount: r.restartCount };
    byRef.set(baselineItemRef(e), e);
  }
  const entries = [...byRef.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e).slice(0, MAX_ENTRIES);
  return SourceBaselineSchema.parse({ capturedAt: now.toISOString(), entries });
}

/** The same baseline apart from the capture time: lets PREFLIGHT skip rewriting an unchanged baseline on every tick. */
export const sameBaseline = (a: SourceBaseline | null, b: SourceBaseline): boolean => !!a && JSON.stringify(a.entries) === JSON.stringify(b.entries);

/** Was the resource already failing at the source: unhealthy or exited, or restarting without being healthy? */
export const isDegradedAtSource = (e: BaselineEntry): boolean => e.health === "unhealthy" || e.health === "exited" || (e.health !== "healthy" && e.restartCount !== null && e.restartCount >= CRASH_LOOP_RESTARTS);

/** The itemRefs that were already degraded at the source. */
export function degradedItemRefs(baseline: SourceBaseline | null | undefined): Set<string> {
  return new Set((baseline?.entries ?? []).filter(isDegradedAtSource).map(baselineItemRef));
}

/**
 * How Tugra's state compares with the source's, for VERIFY and OBSERVE:
 *  - `healthy`: it answers (nothing to excuse);
 *  - `pre-existing`: it does not, and it was already degraded at the source (judge it against that, do not block on it);
 *  - `regression`: it does not, and the source had it healthy or merely unchecked (`unknown`: no baseline to excuse it);
 *  - `unbaselined`: it does not, and no baseline exists (never an excuse).
 */
export function baselineVerdict(entry: BaselineEntry | undefined, healthyNow: boolean): "healthy" | "pre-existing" | "regression" | "unbaselined" {
  if (healthyNow) return "healthy";
  if (!entry) return "unbaselined";
  return isDegradedAtSource(entry) ? "pre-existing" : "regression";
}

/** What the comparison with the source says about one resource (see {@link baselineVerdict}). */
export type BaselineVerdict = ReturnType<typeof baselineVerdict>;

/** The baseline entry of a plan itemRef (`app:<serverRef|_>:<ref>`), or undefined when the baseline never saw it. */
export function baselineEntryOf(baseline: SourceBaseline | null | undefined, itemRef: string): BaselineEntry | undefined {
  return baseline?.entries.find((e) => baselineItemRef(e) === itemRef);
}

/**
 * The verdict for one resource of the run, by its plan itemRef (R52): the single place VERIFY, CUTOVER and OBSERVE judge "is this
 * failure new, or was it already failing at the source". A resource the baseline did not see is `unbaselined` (never excused).
 */
export const verdictOf = (baseline: SourceBaseline | null | undefined, itemRef: string | null | undefined, healthyNow: boolean): BaselineVerdict =>
  baselineVerdict(itemRef ? baselineEntryOf(baseline, itemRef) : undefined, healthyNow);

/**
 * The hostnames that fail on Tugra although the app behind them was ALREADY degraded at the source: they are reported as
 * pre-existing (a warning), not as a new failure. `failing` is every host that does not answer, `appOf` maps a host to the plan
 * itemRef of the app that serves it (a host with no known app is never excused).
 */
export function preExistingHosts(baseline: SourceBaseline | null | undefined, failing: readonly string[], appOf: (hostname: string) => string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const h of failing) if (verdictOf(baseline, appOf(h), false) === "pre-existing") out.add(h);
  return out;
}
