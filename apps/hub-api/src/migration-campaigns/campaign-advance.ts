/**
 * "Start all": which queued run of a campaign the hub starts next. Pure: no I/O, no clock. The campaign's plan says the waves (the copy first,
 * then one same-machine server after the other); a run does not carry its wave, so it is found by what the plan says, the kind and the target.
 *
 * A wave starts when every earlier wave reached a safe point:
 *  - a run that completed;
 *  - an in-place run whose dark test is done and which waits for the owner's VERIFY approval (or is past it). Everything up to that point
 *    only reads the source and starts Tugra's copies beside it, so the pre-swap steps of the next servers can run while the owner reviews.
 * A copy run (another server) must complete: it moves data and holds a freeze window.
 * The swaps themselves stay one at a time: the VERIFY approval of a campaign run is refused while another run of it is switching (see
 * `swapInFlight` in the run core), so starting early never means two servers swapping together.
 * A run that failed, paused, aborted or is being undone holds every later wave; the owner fixes it, and the next pass goes on.
 */
import type { CampaignRunPlan } from "@tugra/shared";

export interface AdvanceStep {
  key: string;
  status: string;
  /** The owner's approval is recorded on the step (the step may still read WAITING_APPROVAL until the engine's next pass). */
  approved?: boolean;
}

export interface AdvanceRun {
  id: string;
  status: string;
  targetServerId: string;
  inPlace: boolean;
  dryRun: boolean;
  createdAt: Date;
  steps: readonly AdvanceStep[];
}

/** Why the hub stopped starting new servers: a stable code the screen names. */
export type AdvanceHoldCode = "run-failed" | "run-paused" | "run-ended" | "dry-run-pending" | "runs-pending";

export interface AdvanceHold {
  code: AdvanceHoldCode;
  runId: string | null;
}

export interface AdvanceDecision {
  /** Queued runs to start now, in wave order. */
  start: string[];
  /** Set when a run (or a missing run) stops the later waves; null when the hub is only waiting for a safe point or has nothing left. */
  hold: AdvanceHold | null;
  /** Every planned run completed: nothing is left to drive. */
  finished: boolean;
}

const ENDED = new Set(["ABORTED", "ABORTING", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED"]);
const LIVE_PRE_SWAP = new Set(["RUNNING", "WAITING"]);
/** The steps after the owner's approval: once one of them has started, the pre-swap work is over. */
const POST_VERIFY = ["CUTOVER", "OBSERVE", "FINALIZE"] as const;

const stepStatus = (r: AdvanceRun, key: string): string | undefined => r.steps.find((s) => s.key === key)?.status;

/** The run that stands for one planned run: same kind and target, the newest (a promoted dry run is replaced by the real run it made). */
export function runOfPlan(p: Pick<CampaignRunPlan, "kind" | "targetServerId">, runs: readonly AdvanceRun[]): AdvanceRun | undefined {
  return runs
    .filter((r) => r.inPlace === (p.kind === "in-place") && r.targetServerId === p.targetServerId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/** An in-place run is past everything that does not touch production: its dark test is done and it waits for, or went through, the owner's approval. */
export function reachedSafePoint(r: AdvanceRun): boolean {
  if (r.status === "COMPLETED") return true;
  if (!r.inPlace || !LIVE_PRE_SWAP.has(r.status)) return false;
  const verify = stepStatus(r, "VERIFY");
  if (verify === "WAITING_APPROVAL" || verify === "PASSED") return true;
  return POST_VERIFY.some((k) => {
    const s = stepStatus(r, k);
    return s !== undefined && s !== "PENDING";
  });
}

export function decideAdvance(plan: readonly CampaignRunPlan[], runs: readonly AdvanceRun[]): AdvanceDecision {
  const waves = [...new Set(plan.map((p) => p.wave))].sort((a, b) => a - b);
  const start: string[] = [];
  let canStart = true;
  let allComplete = plan.length > 0;
  for (const wave of waves) {
    const members = plan.filter((p) => p.wave === wave).map((p) => runOfPlan(p, runs));
    if (members.some((m) => !m)) return { start, hold: { code: "runs-pending", runId: null }, finished: false };
    const wr = members as AdvanceRun[];
    const failed = wr.find((r) => r.status === "FAILED");
    if (failed) return { start, hold: { code: "run-failed", runId: failed.id }, finished: false };
    const ended = wr.find((r) => ENDED.has(r.status));
    if (ended) return { start, hold: { code: "run-ended", runId: ended.id }, finished: false };
    const paused = wr.find((r) => r.status === "PAUSED");
    if (paused) return { start, hold: { code: "run-paused", runId: paused.id }, finished: false };
    const dry = wr.find((r) => r.status === "DRY_RUN_DONE" || (r.dryRun && r.status === "QUEUED"));
    if (dry) return { start, hold: { code: "dry-run-pending", runId: dry.id }, finished: false };
    if (canStart) for (const r of wr) if (r.status === "QUEUED") start.push(r.id);
    if (!wr.every(reachedSafePoint)) canStart = false;
    if (!wr.every((r) => r.status === "COMPLETED")) allComplete = false;
  }
  return { start, hold: null, finished: allComplete };
}
