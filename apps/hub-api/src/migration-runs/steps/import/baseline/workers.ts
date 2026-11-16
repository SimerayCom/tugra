/**
 * Held workers (R26/C13), pure. A worker is an app that serves no traffic of its own: no domain (a queue consumer, a price
 * feed, a mailer). Started dark next to the live source it would send mail or hit feeds twice, and after an abort the source
 * would replay the jobs it consumed. So the default policy builds it (when asked) but keeps it STOPPED until after the point of
 * no return; an abort never starts it.
 *
 * What is NOT a worker although it has no domain: an app another app reaches by name (a mapped `containerAlias`) and an app
 * the operator marked `web`. What IS one although it has a domain: an app the operator marked `job-runner`.
 */
import type { WorkerPolicy } from "../../../core/run-contract";
import type { RunApplyInput } from "../../../core/dto";
import type { RunHint } from "./run-hints";

export const WORKER_MARKS = ["job-runner", "web"] as const;
export type WorkerMark = (typeof WORKER_MARKS)[number];

/** The plan facts of one app item. `domain`: the primary host, `null` = none, `undefined` = the port could not say. */
export interface WorkerCandidate {
  itemRef: string;
  kind: string;
  domain?: string | null;
}

/** The operator's marks by itemRef. */
export function workerMarks(hints: readonly RunHint[]): Map<string, WorkerMark> {
  const out = new Map<string, WorkerMark>();
  for (const h of hints) if (h.kind === "worker-mark" && (WORKER_MARKS as readonly string[]).includes(h.value)) out.set(h.key, h.value as WorkerMark);
  return out;
}

/** Is this app a worker? An unknown domain is never read as "no domain": without the fact nothing is held. */
export function isWorker(c: WorkerCandidate, applyInput: Pick<RunApplyInput, "mapping">, marks: ReadonlyMap<string, WorkerMark>): boolean {
  if (c.kind !== "app") return false;
  const mark = marks.get(c.itemRef);
  if (mark === "job-runner") return true;
  if (mark === "web") return false;
  if (c.domain !== null) return false;
  return !applyInput.mapping?.items?.[c.itemRef]?.containerAlias;
}

export interface WorkerSets {
  /** `hold-dark`: stopped until after the point of no return, then started. */
  held: Set<string>;
  /** `exclude`: never deployed and never started by this run. */
  excluded: Set<string>;
}

/** The itemRefs the policy keeps away from DEPLOY_DARK. `start-dark` returns two empty sets: workers are ordinary apps. */
export function workerSets(candidates: readonly WorkerCandidate[], applyInput: Pick<RunApplyInput, "mapping">, marks: ReadonlyMap<string, WorkerMark>, policy: WorkerPolicy): WorkerSets {
  const held = new Set<string>();
  const excluded = new Set<string>();
  if (policy === "start-dark") return { held, excluded };
  for (const c of candidates) if (isWorker(c, applyInput, marks)) (policy === "exclude" ? excluded : held).add(c.itemRef);
  return { held, excluded };
}
