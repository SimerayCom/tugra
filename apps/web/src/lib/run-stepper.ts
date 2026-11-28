// The live step list of a run (the updater's pattern: ordered steps, one state word each, the current action in plain words).
// Pure: no React, no network. The hub states the facts (step status, next action); this only picks the steps that apply and names their state.
import type { MigrationRunStepKey, MigrationRunStepView, MigrationRunView } from "./types";

/** What a step reads like to the owner. Words next to every mark, never colour alone. */
export type StepperState = "todo" | "working" | "waiting" | "needs-you" | "done" | "failed" | "undone" | "paused";

/**
 * The steps an in-place takeover really does: it copies no data and moves no DNS, so the copy, freeze and certificate-pre-issue steps
 * never apply. Everything else (a move to another server) shows every step the hub made.
 */
export const IN_PLACE_STEPS: readonly MigrationRunStepKey[] = ["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK", "VERIFY", "CUTOVER", "OBSERVE", "FINALIZE"];

export interface StepperRow {
  step: MigrationRunStepView;
  state: StepperState;
  /** The step the run is on now (the one the action line is about). */
  current: boolean;
}

export interface StepperModel {
  rows: StepperRow[];
  /** Steps of the flow that are not shown because they do not apply (in place) or were skipped. */
  hidden: number;
  /** How many shown steps are done. */
  done: number;
  /** The run is moving by itself right now (a step works or the hub waits on time). */
  working: boolean;
}

const ENDED = new Set(["ABORTED", "ROLLED_BACK", "REVERSED"]);

/** The state word of one step, given the run it belongs to. */
export function stepState(run: Pick<MigrationRunView, "status" | "currentStep">, step: Pick<MigrationRunStepView, "key" | "status">): StepperState {
  switch (step.status) {
    case "PASSED":
      return "done";
    case "FAILED":
      return "failed";
    case "COMPENSATED":
      return "undone";
    case "WAITING_OPERATOR":
    case "WAITING_APPROVAL":
      return "needs-you";
    case "WAITING_TIMER":
      return run.status === "PAUSED" && run.currentStep === step.key ? "paused" : "waiting";
    case "RUNNING":
      return run.status === "PAUSED" ? "paused" : "working";
    case "SKIPPED":
    case "PENDING":
      return "todo";
  }
}

/** The steps to draw, in order, with their state. A step that does not apply is counted, not drawn. */
export function stepperModel(run: Pick<MigrationRunView, "status" | "currentStep" | "inPlace" | "steps">): StepperModel {
  const flow = [...run.steps].filter((s) => s.key !== "DECOMMISSION").sort((a, b) => a.idx - b.idx);
  const shown = flow.filter((s) => s.status !== "SKIPPED" && (!run.inPlace || IN_PLACE_STEPS.includes(s.key)));
  const rows: StepperRow[] = shown.map((step) => ({ step, state: stepState(run, step), current: run.currentStep === step.key }));
  // a run that ended or has not started has no "current" step to point at
  const live = !ENDED.has(run.status) && run.status !== "QUEUED" && run.status !== "COMPLETED";
  const working = live && rows.some((r) => r.state === "working" || r.state === "waiting");
  return { rows, hidden: flow.length - shown.length, done: rows.filter((r) => r.state === "done").length, working };
}

/** The state that stands for a whole run on a list: its current step's state, or done/not started. */
export function runStepperState(run: Pick<MigrationRunView, "status" | "currentStep" | "inPlace" | "steps">): StepperState {
  if (run.status === "COMPLETED") return "done";
  if (run.status === "QUEUED") return "todo";
  const m = stepperModel(run);
  return m.rows.find((r) => r.current)?.state ?? m.rows.find((r) => r.state !== "done" && r.state !== "todo")?.state ?? "todo";
}

export const STATE_KEY: Record<StepperState, string> = {
  todo: "migrationRun.stepper.state.todo",
  working: "migrationRun.stepper.state.working",
  waiting: "migrationRun.stepper.state.waiting",
  "needs-you": "migrationRun.stepper.state.needsYou",
  done: "migrationRun.stepper.state.done",
  failed: "migrationRun.stepper.state.failed",
  undone: "migrationRun.stepper.state.undone",
  paused: "migrationRun.stepper.state.paused",
};

/** The colour of a state (the words carry the meaning; colour only helps). */
export const STATE_COLOR: Record<StepperState, string> = {
  todo: "var(--c-tx3)",
  working: "var(--c-a)",
  waiting: "var(--c-a)",
  "needs-you": "var(--c-am)",
  done: "var(--c-g)",
  failed: "var(--c-r)",
  undone: "var(--c-tx3)",
  paused: "var(--c-am)",
};

/** Seconds a step took, or has been running; null before it started. */
export function stepElapsedSec(step: Pick<MigrationRunStepView, "startedAt" | "finishedAt">, nowMs: number): number | null {
  if (!step.startedAt) return null;
  const end = step.finishedAt ? new Date(step.finishedAt).getTime() : nowMs;
  const d = (end - new Date(step.startedAt).getTime()) / 1000;
  return Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
}

/**
 * Whether the run needs the owner right now: an approval, something to do on the source, a gate to answer, a session to reconnect,
 * a pause, or a failure. The hub's own next-action kind says it; nothing is guessed here.
 */
export const NEEDS_YOU_KINDS = ["approval", "operator", "gate", "session", "paused", "failed"] as const;
export const needsYou = (run: Pick<MigrationRunView, "status" | "nextAction">): boolean => run.status !== "COMPLETED" && !ENDED.has(run.status) && (NEEDS_YOU_KINDS as readonly string[]).includes(run.nextAction.kind);

/** An in-place run that switches traffic now, or is approved to: the next one waits for it (the hub refuses a second approval with `campaign-swap-busy`). */
export function isSwitching(run: Pick<MigrationRunView, "status" | "inPlace" | "steps">): boolean {
  if (!run.inPlace || ["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"].includes(run.status)) return false;
  const cutover = run.steps.find((s) => s.key === "CUTOVER")?.status;
  if (cutover === "PASSED" || cutover === "SKIPPED" || cutover === "COMPENSATED") return false;
  if (cutover !== undefined && cutover !== "PENDING") return true;
  const verify = run.steps.find((s) => s.key === "VERIFY");
  return verify?.status === "PASSED" || (verify?.status === "WAITING_APPROVAL" && verify.approval != null);
}
