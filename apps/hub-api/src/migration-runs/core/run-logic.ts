/**
 * The PURE half of the run engine (P7 lane A): legal run transitions, approval validity, gate/dry-run derivation,
 * the "what am I waiting for" derivation and the allowed-action flags. No I/O, no Nest, no Prisma runtime: everything
 * here is exhaustively unit-tested (`run-logic.spec.ts`) so the engine and the views cannot disagree about the rules.
 */
import { createHash } from "node:crypto";
import {
  LIVE_RUN_STATUSES,
  STEP_MANIFEST,
  TERMINAL_RUN_STATUSES,
  isRunCode,
  makeGate,
  stepKeysForMode,
  type RunMode,
  type RunStatus,
  type StepKey,
  type StepStatus,
} from "./run-contract";
import type {
  ApprovalBinding,
  DryRunItem,
  GateCheck,
  GateResult,
  NextAction,
  RunAllowed,
  StepAllowed,
  StepApprovalRecord,
  WaitSpec,
} from "./dto";

// ───────────────────────────── run status machine ─────────────────────────────

/**
 * Legal run status transitions. FAILED is never terminal (retry/abort/reverse leave it); ABORTED can only go to
 * ROLLING_BACK (the optional cleanup) and a failed cleanup returns to ABORTED so it can be asked for again.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ["RUNNING", "PAUSED", "ABORTING", "FAILED"],
  RUNNING: ["WAITING", "PAUSED", "FAILED", "COMPLETED", "DRY_RUN_DONE", "ABORTING", "REVERSING"],
  WAITING: ["RUNNING", "PAUSED", "FAILED", "COMPLETED", "ABORTING", "REVERSING"],
  PAUSED: ["RUNNING", "WAITING", "ABORTING", "REVERSING"],
  FAILED: ["RUNNING", "WAITING", "ABORTING", "REVERSING"],
  ABORTING: ["ABORTED", "FAILED"],
  ABORTED: ["ROLLING_BACK"],
  ROLLING_BACK: ["ROLLED_BACK", "ABORTED"],
  ROLLED_BACK: [],
  REVERSING: ["REVERSED", "FAILED"],
  REVERSED: [],
  COMPLETED: [],
  DRY_RUN_DONE: [],
};

export const canTransition = (from: RunStatus, to: RunStatus): boolean => from === to || RUN_TRANSITIONS[from].includes(to);

/** Statuses the engine loop claims the lease for (QUEUED joins only via an explicit start/dry-run kick). */
export const DRIVABLE_STATUSES: readonly RunStatus[] = ["RUNNING", "WAITING", "ABORTING", "ROLLING_BACK", "REVERSING"];
/** Statuses in which a human may still act on the run (forward actions). */
export const OPEN_STATUSES: readonly RunStatus[] = ["QUEUED", "RUNNING", "WAITING", "PAUSED", "FAILED"];

export const isTerminal = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(s);
export const isLive = (s: RunStatus): boolean => LIVE_RUN_STATUSES.includes(s);

/** Stable code of a terminal/paused status (`run.rolled-back`). */
export const statusCode = (s: RunStatus): string => `run.${s.toLowerCase().replace(/_/g, "-")}`;

// ───────────────────────────── steps ─────────────────────────────

/** The linear flow (DECOMMISSION is armed by its own route, never advanced into). */
export const flowKeys = (mode: RunMode): StepKey[] => stepKeysForMode(mode).filter((k) => !STEP_MANIFEST[k].manual);

/** The first flow step that is neither PASSED nor SKIPPED, or null when the flow is complete. */
export function nextFlowStep(mode: RunMode, status: ReadonlyMap<StepKey, StepStatus>): StepKey | null {
  for (const k of flowKeys(mode)) {
    const s = status.get(k) ?? "PENDING";
    if (s !== "PASSED" && s !== "SKIPPED") return k;
  }
  return null;
}

/** The WAITING_* step status a wait spec parks a step in. */
export const parkStatus = (w: WaitSpec): StepStatus => (w.kind === "approval" ? "WAITING_APPROVAL" : w.kind === "timer" ? "WAITING_TIMER" : "WAITING_OPERATOR");
export const isWaitingStep = (s: StepStatus): boolean => s === "WAITING_OPERATOR" || s === "WAITING_APPROVAL" || s === "WAITING_TIMER";

/** Equal wait specs (so a re-park with the same reason does not spam the event log). */
export const sameWait = (a: WaitSpec | null | undefined, b: WaitSpec | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return stable(stripSince(a)) === stable(stripSince(b));
};

/** The hidden "waiting since" stamp stored beside a wait spec (never part of the wire view). */
export const WAIT_SINCE_KEY = "_since";
/** The hidden "stuck notification sent" marker the watchdog stores beside a wait spec. */
export const WAIT_STUCK_KEY = "_stuck";
/** Drop the engine's hidden bookkeeping keys (every key starting with `_`) so a stored wait spec equals its wire form. */
export const stripSince = <T extends object>(w: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) if (!k.startsWith("_")) out[k] = v;
  return out as T;
};
export const waitSince = (w: unknown): string | null => {
  const v = (w as Record<string, unknown> | null)?.[WAIT_SINCE_KEY];
  return typeof v === "string" ? v : null;
};

/** Deterministic JSON (sorted keys): the basis of every hash and equality in this module. */
export function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** sha256 hex of any JSON value (the helper handlers use to build an {@link ApprovalBinding.inputHash}). */
export const hashOf = (v: unknown): string => createHash("sha256").update(stable(v)).digest("hex");

// ───────────────────────────── approvals ─────────────────────────────

export type ApprovalVerdict = { valid: true } | { valid: false; reason: "none" | "stale" | "expired" | "acks-missing" | "risk-missing" };

/**
 * Is `stored` a valid approval for the binding the step shows right now? Valid only when the hash it was bound to equals
 * the freshly computed one, it has not expired, every required ack is present and (for stateful hosts) the data-risk
 * acknowledgement was ticked. Anything else voids it: the human must re-review what changed.
 */
export function evaluateApproval(binding: ApprovalBinding, stored: StepApprovalRecord | null, now: Date): ApprovalVerdict {
  if (!stored) return { valid: false, reason: "none" };
  if (stored.boundHash !== binding.inputHash) return { valid: false, reason: "stale" };
  if (stored.expiresAt && Date.parse(stored.expiresAt) <= now.getTime()) return { valid: false, reason: "expired" };
  if (!binding.requiredAcks.every((a) => stored.acks.includes(a))) return { valid: false, reason: "acks-missing" };
  if (binding.requiresDataRisk && !stored.acceptDataRisk) return { valid: false, reason: "risk-missing" };
  return { valid: true };
}

/** The instant an approval made at `at` expires under `binding` (null = never). */
export const approvalExpiry = (binding: ApprovalBinding, at: Date): string | null => (binding.ttlSec ? new Date(at.getTime() + binding.ttlSec * 1000).toISOString() : null);

// ───────────────────────────── gates ─────────────────────────────

/** Mark the checks a human acknowledged (`acks` holds check ids) as `acked`, so {@link makeGate} lets them through. */
export function applyAcks(checks: readonly GateCheck[], acks: readonly string[]): GateCheck[] {
  return checks.map((c) => (c.ackable === true && acks.includes(c.id) && c.status !== "pass" ? { ...c, acked: true } : c));
}

/** The id of the failure check the engine writes on a FAILED step's gate (carries `retryable`). */
export const FAILURE_CHECK_ID = "step.failure";

export function failureGate(code: string, params: GateCheck["params"] | undefined, retryable: boolean): GateResult {
  return {
    passed: false,
    checks: [{ id: FAILURE_CHECK_ID, status: "fail", code, params: { ...(params ?? {}), retryable }, ackable: false }],
  };
}

/** Is a FAILED step retryable (its failure check says so; a failed gate without one is retryable)? */
export const isRetryable = (gate: GateResult | null): boolean => {
  const c = gate?.checks.find((x) => x.id === FAILURE_CHECK_ID);
  return c ? c.params?.retryable !== false : true;
};

/**
 * Derive a gate from a dry-run projection: `block` and `unknown` items would stop the real run (unknown fails where
 * data would move), `warn` warns, `info` passes. At most 500 checks (the projection itself is capped).
 */
export function gateFromDryRun(items: readonly DryRunItem[]): GateResult {
  const checks: GateCheck[] = items.slice(0, 500).map((it, i) => ({
    id: `dry-run.${i}`,
    status: it.level === "block" ? "fail" : it.level === "unknown" ? "unknown" : it.level === "warn" ? "warn" : "pass",
    code: it.code,
    ...(it.params ? { params: it.params } : {}),
    ...(it.subject ? { subject: it.subject } : {}),
  }));
  return makeGate(checks);
}

// ───────────────────────────── view derivations ─────────────────────────────

export interface StepFacts {
  key: StepKey;
  status: StepStatus;
  gate: GateResult | null;
  wait: (WaitSpec & { [WAIT_SINCE_KEY]?: string }) | null;
  lastError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  evidenceAttachments: number;
}

export interface RunFacts {
  status: RunStatus;
  mode: RunMode;
  dryRun: boolean;
  ponrAt: Date | null;
  pauseRequested: boolean;
  opId: string | null;
  opHistory: readonly string[];
  failureStep: StepKey | null;
  failureCode: string | null;
  currentStep: StepKey | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The code a step wait uses when the source token must be re-entered (the view then says `session`). */
export const SESSION_EXPIRED_CODE = "step.session-expired";

/** "What I am waiting for": exactly one per run. */
export function deriveNextAction(run: RunFacts, steps: ReadonlyMap<StepKey, StepFacts>): NextAction {
  const iso = (d: Date | null | undefined, fb: Date): string => (d ?? fb).toISOString();
  if (isTerminal(run.status)) return { kind: "none", stepKey: null, code: statusCode(run.status), since: iso(run.finishedAt, run.updatedAt) };
  if (run.status === "PAUSED") return { kind: "paused", stepKey: run.currentStep, code: "run.paused", since: run.updatedAt.toISOString() };
  if (run.status === "FAILED") {
    return {
      kind: "failed",
      stepKey: run.failureStep,
      code: run.failureCode && isRunCode(run.failureCode) ? run.failureCode : "run.failed",
      since: run.updatedAt.toISOString(),
    };
  }
  const cur = run.currentStep ? steps.get(run.currentStep) : undefined;
  if (cur && cur.wait && isWaitingStep(cur.status)) {
    const w = cur.wait;
    const since = waitSince(w) ?? iso(cur.startedAt, run.updatedAt);
    if (w.kind === "approval") return { kind: "approval", stepKey: cur.key, code: "step.waiting-approval", since, approval: w.binding };
    if (w.kind === "timer") return { kind: "timer", stepKey: cur.key, code: w.code, ...(w.params ? { params: w.params } : {}), since, notBefore: w.notBefore };
    const gateBlocked = cur.gate !== null && !cur.gate.passed;
    const kind = w.code === SESSION_EXPIRED_CODE ? "session" : gateBlocked ? "gate" : "operator";
    return {
      kind,
      stepKey: cur.key,
      code: w.code,
      ...(w.params ? { params: w.params } : {}),
      since,
      ...(w.attest?.length ? { attest: w.attest } : {}),
      ...(w.offersCommand ? { offersCommand: true } : {}),
    };
  }
  return { kind: "engine", stepKey: run.currentStep, code: run.status === "QUEUED" ? "run.queued" : "run.working", since: iso(run.startedAt, run.createdAt) };
}

/** What the UI may offer on the run right now. */
export function deriveRunAllowed(run: RunFacts, steps: ReadonlyMap<StepKey, StepFacts>): RunAllowed {
  const open = OPEN_STATUSES.includes(run.status);
  const decom = steps.get("DECOMMISSION");
  return {
    start: (run.status === "QUEUED" && !run.dryRun) || run.status === "DRY_RUN_DONE",
    pause: (run.status === "RUNNING" || run.status === "WAITING") && !run.pauseRequested,
    resume: run.status === "PAUSED",
    abort: open && run.ponrAt === null && !run.dryRun,
    cleanup: run.status === "ABORTED" && !run.dryRun && (run.opId !== null || run.opHistory.length > 0),
    reverse: open && run.ponrAt !== null && run.status !== "QUEUED" && !run.dryRun,
    decommission: run.mode === "takeover" && run.status === "COMPLETED" && !!decom && (decom.status === "PENDING" || decom.status === "FAILED"),
    setInputs: open,
    sourceSession: open && !run.dryRun,
  };
}

/** Steps that accept `POST /attach`. */
export const ATTACH_STEPS: readonly StepKey[] = ["DATA_SEED", "DATA_FINAL"];
/** Steps that can mint the migrator command. */
export const COMMAND_STEPS: readonly StepKey[] = ["DATA_SEED", "DATA_FINAL"];

/** What the UI may offer on one step right now. */
export function deriveStepAllowed(run: RunFacts, step: StepFacts): StepAllowed {
  const open = OPEN_STATUSES.includes(run.status) && !run.dryRun;
  const waiting = isWaitingStep(step.status);
  const manifest = STEP_MANIFEST[step.key];
  return {
    approve: open && step.status === "WAITING_APPROVAL",
    retry: open && ((step.status === "FAILED" && isRetryable(step.gate)) || step.status === "WAITING_OPERATOR"),
    skip: open && manifest.skippable === true && (step.status === "PENDING" || waiting || step.status === "FAILED"),
    evidence: open && step.status === "WAITING_OPERATOR" && !!step.wait && step.wait.kind === "operator" && !!step.wait.attest?.length,
    attach: open && ATTACH_STEPS.includes(step.key) && (step.status === "PENDING" || step.status === "RUNNING" || waiting),
    command: open && waiting && !!step.wait && step.wait.kind === "operator" && step.wait.offersCommand === true && COMMAND_STEPS.includes(step.key),
  };
}

/** `freezeEndedAt - freezeStartedAt` in whole seconds once both are set. */
export const measuredDowntimeSec = (start: Date | null, end: Date | null): number | null => (start && end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000)) : null);

/** Clamp an `ActResult.continue` poll delay to 1 s .. 60 s. */
export const clampPollMs = (ms: number): number => Math.min(60_000, Math.max(1_000, Math.round(Number.isFinite(ms) ? ms : 1_000)));
