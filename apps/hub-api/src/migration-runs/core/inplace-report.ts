/**
 * The report items of an in-place run, pure. The import op's tasks only say a record was created in Tugra; what the owner asks is whether
 * each site is now served by Tugra, and that is the takeover's own state: an item is `moved` once its checks passed after the ports changed
 * (every domain answers and holds its new certificate, a database answers the same, every container of a stack is up). So a run's
 * "N of M apps switched" counts the run's own apps and nothing of the rest of the fleet. Names, outcomes and fixed codes only.
 */
import type { TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import type { RunReport } from "./dto";

type Item = RunReport["items"][number];

/** Codes this mapper emits (the web renders `migrationRun.codes.<code>`). */
export const INPLACE_REPORT_CODES = {
  leftOut: "inplace.left-out",
  waiting: "inplace.waiting",
  failed: "inplace.check-failed",
  notSwitched: "inplace.not-switched",
} as const;

const domainsDone = (i: TakeoverItemView): boolean => i.domains.every((d) => d.finalCheck === "ok" && d.cert === "issued");
const domainsFailed = (i: TakeoverItemView): boolean => i.domains.some((d) => d.tempCheck === "failed" || d.finalCheck === "failed" || d.cert === "failed");

function done(i: TakeoverItemView): boolean {
  if (i.kind === "database") return i.verify?.state === "ok";
  if (i.kind === "service") return (i.members ?? []).length > 0 && (i.members ?? []).every((m) => m.ready === "ok" && (!m.verify || m.verify.state === "ok")) && domainsDone(i);
  return domainsDone(i);
}

function failed(i: TakeoverItemView): boolean {
  if (i.kind === "database") return i.verify?.state === "failed";
  return domainsFailed(i) || (i.kind === "service" && (i.members ?? []).some((m) => m.ready === "failed" || m.verify?.state === "failed"));
}

/**
 * @param settled the run is over (completed, failed, aborted): an item that was not switched is then `not-cut-over`; while the run is still
 *   going it is only `skipped` ("waiting"), so a live run does not list every site it has not reached yet as a problem.
 */
export function inPlaceReportItems(items: readonly TakeoverItemView[], takeover: TakeoverStatus, settled: boolean): Item[] {
  const switched = takeover === "SWAPPED" || takeover === "VERIFIED";
  return items.map((i): Item => {
    const base = { kind: i.kind ?? ("app" as const), name: i.name.slice(0, 300), evidence: "hub-verified" as const };
    if (i.skipped) return { ...base, outcome: "skipped", code: INPLACE_REPORT_CODES.leftOut };
    if (switched && done(i)) return { ...base, outcome: "moved", code: null };
    if (failed(i)) return { ...base, outcome: "failed", code: INPLACE_REPORT_CODES.failed };
    return settled ? { ...base, outcome: "not-cut-over", code: INPLACE_REPORT_CODES.notSwitched } : { ...base, outcome: "skipped", code: INPLACE_REPORT_CODES.waiting };
  });
}
