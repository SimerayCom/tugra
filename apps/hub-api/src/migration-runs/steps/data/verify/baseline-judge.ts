/**
 * VERIFY judged against the SOURCE, not against perfection (R28/R52/R66), pure. A source app or database that was already failing
 * at the health baseline (crash-looping, exited, unhealthy) is not a regression when it does not run on Tugra either: its
 * `app-running` check becomes a warning that names the pre-existing state, so it neither blocks the approval nor needs an
 * acknowledgement (a database only on a comparable state, see {@link databaseComparable}). A resource that was healthy (or merely unchecked) at the source, or that the baseline
 * never saw, keeps its failure: a NEW failure still fails.
 *
 * It is a post-processing pass over the suite (not a change to `buildVerifySuite`), so the suite's own rows stay as other lanes
 * wrote them and the verdict is visible in one place.
 */
import { baselineEntryOf, verdictOf } from "../../import/baseline/source-health";
import type { SourceBaseline } from "../../../core/dto";
import type { SuiteCheck } from "./verify-suite";

export const BASELINE_CODES = {
  /** A resource that does not run on Tugra either, and was already degraded at the source (a warning, not a block). */
  preExisting: "verify.pre-existing-failure",
} as const;

/** The suite checks that stand for "this resource is running". */
const RUNNING_CHECKS = new Set(["app-running", "database-running"]);

/**
 * A database holds migrated data, so "it was unhealthy at the source" is not enough to excuse it not running here: a source database's
 * health is a container health check (often merely misconfigured while it serves), whereas Tugra's status says whether it RUNS. Only a
 * comparable state is excused: it was not running at the source either (`exited`) and it is stopped here. A database that is
 * FAILED/MISSING/NEW on Tugra, or was merely unhealthy/crash-looping at the source, stays the hard block it always was.
 */
export const databaseComparable = (sourceHealth: string | undefined, targetStatus: unknown): boolean => sourceHealth === "exited" && targetStatus === "STOPPED";

/** What the pass found, for the VERIFY report. */
export interface BaselineJudgement {
  suite: SuiteCheck[];
  /** Checks turned into a pre-existing warning. */
  preExisting: number;
}

export function judgeAgainstBaseline(suite: readonly SuiteCheck[], baseline: SourceBaseline | null | undefined): BaselineJudgement {
  let preExisting = 0;
  const out = suite.map((c): SuiteCheck => {
    if (!RUNNING_CHECKS.has(c.checkId) || c.status === "pass" || c.status === "warn") return c;
    const verdict = verdictOf(baseline, c.subject, false);
    if (verdict !== "pre-existing") return c;
    const entry = baselineEntryOf(baseline, c.subject);
    if (c.checkId === "database-running" && !databaseComparable(entry?.health, c.params?.status)) return c;
    preExisting++;
    return {
      ...c,
      status: "warn",
      code: BASELINE_CODES.preExisting,
      params: { ...(c.params ?? {}), kind: entry?.kind ?? "app", sourceHealth: entry?.health ?? "unknown", sourceRestarts: entry?.restartCount ?? null },
      ackable: false,
      evidence: "source-api-reported",
    };
  });
  return { suite: out, preExisting };
}
