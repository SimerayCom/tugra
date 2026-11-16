/** Small helpers over the import op the safety logic shares (IMPORT, DEPLOY_DARK, the post-PONR release). */
import { resolveOwnerInput, type RunSnapshot } from "../../../core/run-contract";
import type { ImportStepsPort, OpSnapshot, OpTask } from "../import-ports";
import { isFloatingImage, pinFor, serverRefOfItem } from "./image-pins";
import type { RunHint } from "./run-hints";
import { markConflicts, workerMarks, workerSets, type WorkerSets } from "./workers";

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

/** The apps of the op the operator marked `job-runner` although they serve a primary domain (a mark that cannot hold them: see `workers.ts`). */
export function markConflictsOfOp(op: OpSnapshot, hints: readonly RunHint[]): Array<{ itemRef: string; name: string }> {
  const cands = op.planItems.filter((i) => i.kind === "app").map((i) => ({ itemRef: i.itemRef, kind: i.kind, domain: i.domain }));
  const nameOf = new Map(op.tasks.filter((t) => !!t.itemRef).map((t) => [t.itemRef as string, t.name ?? (t.itemRef as string)]));
  return markConflicts(cands, workerMarks(hints)).map((c) => ({ itemRef: c.itemRef, name: nameOf.get(c.itemRef) ?? c.itemRef }));
}

/** The image apps of the op that run a FLOATING tag for which a digest is recorded (R11): what has to be pinned before any deploy path starts them. */
export function duePinsOf(op: OpSnapshot, hints: readonly RunHint[], only?: ReadonlySet<string>): Array<{ appId: string; name: string; digest: string }> {
  const imageOf = new Map(op.planItems.map((p) => [p.itemRef, p.image] as const));
  const out: Array<{ appId: string; name: string; digest: string }> = [];
  for (const t of appTasksOf(op)) {
    if (only && !only.has(t.resourceId!)) continue;
    const ref = t.itemRef ?? "";
    const image = imageOf.get(ref);
    if (!image || !isFloatingImage(image)) continue;
    const digest = pinFor(hints, image, serverRefOfItem(ref));
    if (digest) out.push({ appId: t.resourceId!, name: t.name ?? ref, digest });
  }
  return out;
}

/**
 * R11: point every image app of the op that runs a FLOATING tag at the digest the source runs, before ANY deploy path starts it
 * (the early wave, DEPLOY_DARK, the worker release after the point of no return). Only the apps in `only` when given. Idempotent:
 * an app already on its digest, or one without a recorded digest, is left alone. Returns the names of the apps it changed.
 */
export async function pinFloatingImages(port: Pick<ImportStepsPort, "pinImage">, userId: string, op: OpSnapshot, hints: readonly RunHint[], only?: ReadonlySet<string>): Promise<string[]> {
  if (!port.pinImage) return [];
  const changed: string[] = [];
  for (const d of duePinsOf(op, hints, only)) if ((await port.pinImage(userId, d.appId, d.digest)).pinned) changed.push(d.name);
  return changed;
}
