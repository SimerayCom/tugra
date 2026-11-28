/** Small helpers over the import op the safety logic shares (IMPORT, DEPLOY_DARK, the post-PONR release). */
import { resolveOwnerInput, type RunSnapshot } from "../../../core/run-contract";
import type { ImportStepsPort, OpSnapshot, OpTask } from "../import-ports";
import { isFloatingImage, pinFor, serverRefOfItem } from "./image-pins";
import { exactRows } from "./exact-images";
import type { RunHint } from "./run-hints";
import { markConflicts, unmatchedMarks, workerMarks, workerSets, type WorkerSets } from "./workers";

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

/** The itemRefs the operator marked that name no app of the op (see `unmatchedMarks`). */
export function unmatchedMarksOfOp(op: OpSnapshot, hints: readonly RunHint[]): string[] {
  const cands = op.planItems.map((i) => ({ itemRef: i.itemRef, kind: i.kind, domain: i.domain }));
  return unmatchedMarks(cands, workerMarks(hints));
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

/** One exact image still to write into a record the import created: an app, a database, or the members of a compose stack. */
export type ExactDue = { kind: "app" | "database"; itemRef: string; name: string; id: string; ref: string } | { kind: "service"; itemRef: string; name: string; id: string; members: Record<string, string> };

/**
 * The records of the op that the run knows an exact image for (recorded from the source host's running containers) and that the owner
 * keeps. Only a task that is DONE counts. An app, database or stack the host reported nothing for is not in the list: it keeps what the
 * source writes, and the run says so.
 */
export function exactDueOf(op: OpSnapshot, hints: readonly RunHint[], only?: ReadonlySet<string>): ExactDue[] {
  const rows = exactRows(hints).filter((r) => r.kept);
  if (!rows.length) return [];
  const out: ExactDue[] = [];
  for (const t of op.tasks) {
    if (t.status !== "DONE" || !t.itemRef || !t.resourceId) continue;
    if (only && !only.has(t.resourceId)) continue;
    const own = rows.filter((r) => r.itemRef === t.itemRef);
    if (!own.length) continue;
    const name = t.name ?? t.itemRef;
    if (t.kind === "app" && t.resourceType === "application") {
      const r = own.find((x) => x.member === "");
      if (r) out.push({ kind: "app", itemRef: t.itemRef, name, id: t.resourceId, ref: r.ref });
    } else if (t.kind === "database" && t.resourceType === "database") {
      const r = own.find((x) => x.member === "");
      if (r) out.push({ kind: "database", itemRef: t.itemRef, name, id: t.resourceId, ref: r.ref });
    } else if (t.kind === "service" && t.resourceType === "application") {
      const members = Object.fromEntries(own.filter((x) => x.member !== "").map((x) => [x.member, x.ref]));
      if (Object.keys(members).length) out.push({ kind: "service", itemRef: t.itemRef, name, id: t.resourceId, members });
    }
  }
  return out;
}

/** What {@link pinExactImagesDetailed} did: the names it changed, and the records that could not take the image the source runs. */
export interface ExactPinResult {
  changed: string[];
  /** Records the run knows an exact image for that cannot run it (another repository, a database that was started): they would run something else. */
  refused: ExactDue[];
}

/**
 * R11: write the exact image the source runs into every record the import created, before ANY deploy path starts it. Idempotent: a record
 * already on that image (or on a digest of its own), or one the port cannot change, is left alone. Only the records in `only` (resource
 * ids) when given. A record that cannot take the image is reported in `refused`, never skipped silently.
 */
export async function pinExactImagesDetailed(port: Pick<ImportStepsPort, "pinExactImage">, userId: string, op: OpSnapshot, hints: readonly RunHint[], only?: ReadonlySet<string>): Promise<ExactPinResult> {
  const out: ExactPinResult = { changed: [], refused: [] };
  if (!port.pinExactImage) return out;
  for (const d of exactDueOf(op, hints, only)) {
    const r = await port.pinExactImage(userId, d);
    if (r.pinned) out.changed.push(d.name);
    else if (r.state === "refused") out.refused.push(d);
  }
  return out;
}

/** {@link pinExactImagesDetailed}, the names of the records it changed only. */
export async function pinExactImages(port: Pick<ImportStepsPort, "pinExactImage">, userId: string, op: OpSnapshot, hints: readonly RunHint[], only?: ReadonlySet<string>): Promise<string[]> {
  return (await pinExactImagesDetailed(port, userId, op, hints, only)).changed;
}
