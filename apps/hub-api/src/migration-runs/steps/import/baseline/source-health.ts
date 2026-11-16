/**
 * The source health baseline (R28/R52/R66), pure. PREFLIGHT reads how every source app, database and service is doing before
 * anything changes; VERIFY and OBSERVE judge Tugra against THAT, not against perfection: an app that was crash-looping at the
 * source (126k restarts, exited for weeks) is not a regression when it fails on Tugra too, and an app with no health check
 * (62 of 78 on the real fleet) has a defined `unknown`, never a silent pass.
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
