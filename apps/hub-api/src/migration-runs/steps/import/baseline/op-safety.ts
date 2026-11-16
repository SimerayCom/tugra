/** Small helpers over the import op the safety logic shares (IMPORT, DEPLOY_DARK, the post-PONR release). */
import { resolveOwnerInput, type RunSnapshot } from "../../../core/run-contract";
import type { OpSnapshot, OpTask } from "../import-ports";
import { serverRefOfItem } from "./image-pins";
import type { RunHint } from "./run-hints";
import { workerMarks, workerSets, type WorkerSets } from "./workers";

/** The op's app tasks that produced a Tugra application. */
export const appTasksOf = (op: OpSnapshot): OpTask[] => op.tasks.filter((t) => t.kind === "app" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId);

/** The held / excluded workers of the op under the run's `workerPolicy` and the operator's marks. */
export function workerSetsOfOp(run: RunSnapshot, op: OpSnapshot, hints: readonly RunHint[]): WorkerSets {
  const policy = resolveOwnerInput(run.inputs, "workerPolicy") ?? "hold-dark";
  const cands = op.planItems.filter((i) => i.kind === "app").map((i) => ({ itemRef: i.itemRef, kind: i.kind, domain: i.domain }));
  return workerSets(cands, run.applyInput, workerMarks(hints), policy);
}

/** The Tugra application ids of an op's tasks whose itemRef is in `refs`. */
export const appIdsOf = (op: OpSnapshot, refs: ReadonlySet<string>): string[] => appTasksOf(op).filter((t) => !!t.itemRef && refs.has(t.itemRef)).map((t) => t.resourceId!);

/** The Tugra target server an op task's resource lives on: the run's `serverMap` entry for the item's source server, else the default. */
export const targetOfTask = (targetFor: (sourceServerUuid: string | null | undefined) => string, t: Pick<OpTask, "itemRef">): string => targetFor(serverRefOfItem(t.itemRef ?? "") || null);
