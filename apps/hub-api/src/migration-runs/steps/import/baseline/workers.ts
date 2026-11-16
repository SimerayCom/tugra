/**
 * Held workers (R26/C13), pure. A worker is an app that serves no traffic of its own: no domain (a queue consumer, a price
 * feed, a mailer). Started dark next to the live source it would send mail or hit feeds twice, and after an abort the source
 * would replay the jobs it consumed. So the default policy builds it (when asked) but keeps it STOPPED until after the point of
 * no return; an abort never starts it.
 *
 * What is NOT a worker although it has no domain: an app another app reaches by name (a mapped `containerAlias`) and an app
 * the operator marked `web`. What IS one although it has no further proof: an app the operator marked `job-runner`.
 *
 * A held worker never has a primary domain: an app with a hostname is a cutover host (TLS issuance, the router probe, the flip all
 * need it running dark), so a `job-runner` mark on an app that serves a domain is a CONFLICT, not a worker. {@link markConflicts}
 * names such marks; PREFLIGHT and DEPLOY_DARK refuse them, and `isWorker` never holds the app in the meantime. A mark that matches
 * no app of the plan at all is refused the same way ({@link unmatchedMarks}).
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

const hasDomain = (c: WorkerCandidate): boolean => typeof c.domain === "string" && c.domain !== "";

/** The apps the operator marked `job-runner` that nevertheless serve a primary domain: the mark cannot hold them (see the file header). */
export function markConflicts(candidates: readonly WorkerCandidate[], marks: ReadonlyMap<string, WorkerMark>): WorkerCandidate[] {
  return candidates.filter((c) => c.kind === "app" && marks.get(c.itemRef) === "job-runner" && hasDomain(c));
}

/**
 * The marks whose itemRef names no app of the plan (a typo, a database ref, an item the run does not import). A mark is looked up
 * by exact itemRef, so such a mark is silently ignored: the real worker would start dark next to the live source. Fail closed.
 */
export function unmatchedMarks(candidates: readonly WorkerCandidate[], marks: ReadonlyMap<string, WorkerMark>): string[] {
  const apps = new Set(candidates.filter((c) => c.kind === "app").map((c) => c.itemRef));
  return [...marks.keys()].filter((ref) => !apps.has(ref)).sort();
}

/** Is this app a worker? An unknown domain is never read as "no domain": without the fact nothing is held. */
export function isWorker(c: WorkerCandidate, applyInput: Pick<RunApplyInput, "mapping">, marks: ReadonlyMap<string, WorkerMark>): boolean {
  if (c.kind !== "app") return false;
  const mark = marks.get(c.itemRef);
  if (mark === "web") return false;
  if (mark === "job-runner") return !hasDomain(c);
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
