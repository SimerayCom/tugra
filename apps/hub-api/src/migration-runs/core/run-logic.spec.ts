import type { ApprovalBinding, StepApprovalRecord, WaitSpec } from "./dto";
import { RUN_STATUSES, STEP_KEYS, makeGate, type RunStatus, type StepKey, type StepStatus } from "./run-contract";
import {
  DRIVABLE_STATUSES,
  FAILURE_CHECK_ID,
  OPEN_STATUSES,
  RUN_TRANSITIONS,
  SESSION_EXPIRED_CODE,
  WAIT_SINCE_KEY,
  applyAcks,
  approvalExpiry,
  canTransition,
  clampPollMs,
  deriveNextAction,
  deriveRunAllowed,
  deriveStepAllowed,
  evaluateApproval,
  failureGate,
  flowKeys,
  gateFromDryRun,
  hashOf,
  isRetryable,
  isTerminal,
  measuredDowntimeSec,
  nextFlowStep,
  parkStatus,
  sameWait,
  stable,
  statusCode,
  stripSince,
  waitSince,
  type RunFacts,
  type StepFacts,
} from "./run-logic";

const H = (c: string) => c.repeat(64);
const binding = (over: Partial<ApprovalBinding> = {}): ApprovalBinding => ({ inputHash: H("a"), ponr: false, confirm: "none", ttlSec: null, requiresDataRisk: false, ackable: [], requiredAcks: [], review: {}, ...over });
const record = (over: Partial<StepApprovalRecord> = {}): StepApprovalRecord => ({ byUserId: "u1", at: "2026-11-23T08:00:00.000Z", boundHash: H("a"), acks: [], confirmedName: null, acceptDataRisk: false, expiresAt: null, ...over });
const t0 = new Date("2026-11-23T08:00:00.000Z");

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  status: "RUNNING",
  mode: "copy",
  dryRun: false,
  ponrAt: null,
  pauseRequested: false,
  opId: null,
  opHistory: [],
  failureStep: null,
  failureCode: null,
  currentStep: "IMPORT",
  createdAt: t0,
  updatedAt: t0,
  startedAt: t0,
  finishedAt: null,
  ...over,
});
const step = (key: StepKey, status: StepStatus, over: Partial<StepFacts> = {}): StepFacts => ({ key, status, gate: null, wait: null, lastError: null, startedAt: t0, finishedAt: null, evidenceAttachments: 0, ...over });
const steps = (...s: StepFacts[]) => new Map(s.map((x) => [x.key, x]));

describe("run status machine", () => {
  it("terminal statuses have no exits except ABORTED -> ROLLING_BACK, and every status is covered", () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RUN_STATUSES].sort());
    for (const s of ["ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"] as RunStatus[]) expect(RUN_TRANSITIONS[s]).toEqual([]);
    expect(RUN_TRANSITIONS.ABORTED).toEqual(["ROLLING_BACK"]);
  });

  it("is internally consistent: every target is a status, self transitions are fine, terminal states are not reopened", () => {
    for (const [from, tos] of Object.entries(RUN_TRANSITIONS)) {
      for (const to of tos) expect(RUN_STATUSES).toContain(to);
      expect(canTransition(from as RunStatus, from as RunStatus)).toBe(true);
    }
    expect(canTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransition("DRY_RUN_DONE", "RUNNING")).toBe(false);
    expect(canTransition("ABORTED", "RUNNING")).toBe(false);
  });

  it("encodes the design's flows: pre-PONR abort, post-PONR reverse, FAILED is never terminal", () => {
    expect(canTransition("RUNNING", "ABORTING")).toBe(true);
    expect(canTransition("ABORTING", "ABORTED")).toBe(true);
    expect(canTransition("ABORTED", "ROLLING_BACK")).toBe(true);
    expect(canTransition("ROLLING_BACK", "ROLLED_BACK")).toBe(true);
    expect(canTransition("RUNNING", "REVERSING")).toBe(true);
    expect(canTransition("REVERSING", "REVERSED")).toBe(true);
    for (const to of ["RUNNING", "ABORTING", "REVERSING"] as RunStatus[]) expect(canTransition("FAILED", to)).toBe(true);
    expect(isTerminal("FAILED")).toBe(false);
    expect(isTerminal("ABORTED")).toBe(true);
    expect(DRIVABLE_STATUSES).not.toContain("PAUSED");
    expect(DRIVABLE_STATUSES).not.toContain("FAILED");
    expect(OPEN_STATUSES).toContain("FAILED");
  });

  it("every non-terminal status can reach a terminal one (no dead end)", () => {
    const reach = (from: RunStatus, seen = new Set<RunStatus>()): boolean => {
      if (isTerminal(from)) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return RUN_TRANSITIONS[from].some((t) => reach(t, seen));
    };
    for (const s of RUN_STATUSES) expect(reach(s)).toBe(true);
  });

  it("statusCode is a stable lower-case code", () => {
    expect(statusCode("ROLLED_BACK")).toBe("run.rolled-back");
    expect(statusCode("DRY_RUN_DONE")).toBe("run.dry-run-done");
  });
});

describe("flow ordering", () => {
  it("DECOMMISSION is never part of the flow", () => {
    expect(flowKeys("takeover")).toHaveLength(13);
    expect(flowKeys("copy")).toHaveLength(13);
    expect(flowKeys("takeover")).not.toContain("DECOMMISSION");
  });

  it("nextFlowStep is the first step that is neither PASSED nor SKIPPED", () => {
    const m = new Map<StepKey, StepStatus>([
      ["PREFLIGHT", "PASSED"],
      ["IMPORT", "PASSED"],
      ["DNS_PREPARE", "SKIPPED"],
      ["DATA_SEED", "FAILED"],
    ]);
    expect(nextFlowStep("copy", m)).toBe("DATA_SEED");
    for (const k of STEP_KEYS) m.set(k, "PASSED");
    expect(nextFlowStep("copy", m)).toBeNull();
    m.set("DECOMMISSION", "PENDING");
    expect(nextFlowStep("takeover", m)).toBeNull();
  });
});

describe("approvals are hash-bound, expiring and ack-complete", () => {
  const now = new Date("2026-11-23T08:10:00.000Z");
  it("no stored approval is void (none)", () => {
    expect(evaluateApproval(binding(), null, now)).toEqual({ valid: false, reason: "none" });
  });
  it("a different bound hash is stale: the human must re-review what changed", () => {
    expect(evaluateApproval(binding(), record({ boundHash: H("b") }), now)).toEqual({ valid: false, reason: "stale" });
    expect(evaluateApproval(binding(), record(), now)).toEqual({ valid: true });
  });
  it("expires exactly at expiresAt", () => {
    expect(evaluateApproval(binding(), record({ expiresAt: "2026-11-23T08:10:00.001Z" }), now).valid).toBe(true);
    expect(evaluateApproval(binding(), record({ expiresAt: "2026-11-23T08:10:00.000Z" }), now)).toEqual({ valid: false, reason: "expired" });
  });
  it("hash mismatch wins over expiry (the stronger statement)", () => {
    expect(evaluateApproval(binding(), record({ boundHash: H("b"), expiresAt: "2026-01-01T00:00:00.000Z" }), now)).toEqual({ valid: false, reason: "stale" });
  });
  it("required acks and the data-risk acknowledgement must be present", () => {
    const b = binding({ ackable: ["x", "y"], requiredAcks: ["x"], requiresDataRisk: true });
    expect(evaluateApproval(b, record({ acks: [] }), now)).toEqual({ valid: false, reason: "acks-missing" });
    expect(evaluateApproval(b, record({ acks: ["x"] }), now)).toEqual({ valid: false, reason: "risk-missing" });
    expect(evaluateApproval(b, record({ acks: ["x"], acceptDataRisk: true }), now)).toEqual({ valid: true });
  });
  it("expiry is computed from the binding ttl", () => {
    expect(approvalExpiry(binding({ ttlSec: null }), t0)).toBeNull();
    expect(approvalExpiry(binding({ ttlSec: 1800 }), t0)).toBe("2026-11-23T08:30:00.000Z");
  });
});

describe("gates", () => {
  it("unknown fails by default and passes only when the gate says it never moves data", () => {
    const checks = [{ id: "a", status: "unknown" as const, code: "x.y" }];
    expect(makeGate(checks).passed).toBe(false);
    expect(makeGate(checks, { unknownFails: false }).passed).toBe(true);
  });
  it("applyAcks only acks ackable, non-passing checks by id", () => {
    const out = applyAcks(
      [
        { id: "a", status: "fail", code: "x.a", ackable: true },
        { id: "b", status: "fail", code: "x.b" },
        { id: "c", status: "pass", code: "x.c", ackable: true },
      ],
      ["a", "b", "c"],
    );
    expect(out.map((c) => c.acked === true)).toEqual([true, false, false]);
    expect(makeGate(out).passed).toBe(false);
    expect(makeGate(out.filter((c) => c.id !== "b")).passed).toBe(true);
  });
  it("gateFromDryRun maps block/unknown/warn/info and passes only when nothing blocks or is unknown", () => {
    const g = gateFromDryRun([
      { code: "a.b", level: "info" },
      { code: "a.c", level: "warn" },
    ]);
    expect(g.passed).toBe(true);
    expect(gateFromDryRun([{ code: "a.b", level: "block" }]).passed).toBe(false);
    expect(gateFromDryRun([{ code: "a.b", level: "unknown" }]).passed).toBe(false);
    expect(gateFromDryRun(Array.from({ length: 600 }, () => ({ code: "a.b", level: "info" as const }))).checks).toHaveLength(500);
  });
  it("a failure gate carries retryable and isRetryable reads it back (a gate without one is retryable)", () => {
    expect(isRetryable(failureGate("x.y", { n: 1 }, false))).toBe(false);
    expect(isRetryable(failureGate("x.y", undefined, true))).toBe(true);
    expect(isRetryable(null)).toBe(true);
    expect(failureGate("x.y", undefined, true).checks[0].id).toBe(FAILURE_CHECK_ID);
  });
});

describe("determinism helpers", () => {
  it("stable() sorts keys and drops undefined: equal values hash equal whatever the key order", () => {
    expect(stable({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(stable({ a: [2, { d: 1 }], b: 1 }));
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
  it("clampPollMs is 1 s .. 60 s", () => {
    expect(clampPollMs(5)).toBe(1000);
    expect(clampPollMs(5000)).toBe(5000);
    expect(clampPollMs(999_999)).toBe(60_000);
    expect(clampPollMs(Number.NaN)).toBe(1000);
  });
  it("waits: parkStatus, hidden bookkeeping keys never count and are stripped from the wire form", () => {
    const op: WaitSpec = { kind: "operator", code: "a.b" };
    expect(parkStatus(op)).toBe("WAITING_OPERATOR");
    expect(parkStatus({ kind: "approval", binding: binding() })).toBe("WAITING_APPROVAL");
    expect(parkStatus({ kind: "timer", notBefore: "2026-11-24T00:00:00.000Z", code: "a.b" })).toBe("WAITING_TIMER");
    const stored = { ...op, [WAIT_SINCE_KEY]: "2026-11-23T08:00:00.000Z", _stuck: true };
    expect(sameWait(stored as WaitSpec, op)).toBe(true);
    expect(sameWait(op, { kind: "operator", code: "a.c" })).toBe(false);
    expect(stripSince(stored)).toEqual(op);
    expect(waitSince(stored)).toBe("2026-11-23T08:00:00.000Z");
    expect(waitSince(op)).toBeNull();
  });
  it("measuredDowntimeSec needs both ends", () => {
    expect(measuredDowntimeSec(null, t0)).toBeNull();
    expect(measuredDowntimeSec(t0, new Date(t0.getTime() + 90_400))).toBe(90);
  });
});

describe("nextAction names exactly what the run waits for", () => {
  it("terminal -> none, paused -> paused, failed -> failed with the failure code", () => {
    expect(deriveNextAction(run({ status: "COMPLETED", finishedAt: t0 }), steps()).kind).toBe("none");
    expect(deriveNextAction(run({ status: "PAUSED" }), steps()).kind).toBe("paused");
    const f = deriveNextAction(run({ status: "FAILED", failureStep: "IMPORT", failureCode: "import.tasks-failed" }), steps());
    expect(f).toMatchObject({ kind: "failed", stepKey: "IMPORT", code: "import.tasks-failed" });
    expect(deriveNextAction(run({ status: "FAILED", failureCode: "Not A Code" }), steps()).code).toBe("run.failed");
  });
  it("an approval wait carries its binding; a timer wait its notBefore", () => {
    const b = binding({ ponr: true });
    const a = deriveNextAction(run({ currentStep: "VERIFY" }), steps(step("VERIFY", "WAITING_APPROVAL", { wait: { kind: "approval", binding: b } })));
    expect(a).toMatchObject({ kind: "approval", stepKey: "VERIFY", approval: b });
    const t = deriveNextAction(run({ currentStep: "DNS_PREPARE" }), steps(step("DNS_PREPARE", "WAITING_TIMER", { wait: { kind: "timer", notBefore: "2026-11-24T00:00:00.000Z", code: "dns.ttl-wait" } })));
    expect(t).toMatchObject({ kind: "timer", notBefore: "2026-11-24T00:00:00.000Z", code: "dns.ttl-wait" });
  });
  it("operator waits: gate-blocked vs operator vs session, with attest/command hints and the hidden since stamp", () => {
    const wait = { kind: "operator", code: "data.run-migrator", offersCommand: true, attest: ["c1"], [WAIT_SINCE_KEY]: "2026-11-23T09:00:00.000Z" } as WaitSpec;
    const op = deriveNextAction(run({ currentStep: "DATA_FINAL" }), steps(step("DATA_FINAL", "WAITING_OPERATOR", { wait, gate: makeGate([]) })));
    expect(op).toMatchObject({ kind: "operator", offersCommand: true, attest: ["c1"], since: "2026-11-23T09:00:00.000Z" });
    const gate = deriveNextAction(run({ currentStep: "PREFLIGHT" }), steps(step("PREFLIGHT", "WAITING_OPERATOR", { wait: { kind: "operator", code: "preflight.blocked" }, gate: makeGate([{ id: "a", status: "fail", code: "x.y" }]) })));
    expect(gate.kind).toBe("gate");
    const sess = deriveNextAction(run({ currentStep: "IMPORT" }), steps(step("IMPORT", "WAITING_OPERATOR", { wait: { kind: "operator", code: SESSION_EXPIRED_CODE }, gate: makeGate([{ id: "a", status: "fail", code: "x.y" }]) })));
    expect(sess.kind).toBe("session");
  });
  it("a working run is `engine`", () => {
    expect(deriveNextAction(run({ currentStep: "IMPORT" }), steps(step("IMPORT", "RUNNING"))).kind).toBe("engine");
    expect(deriveNextAction(run({ status: "QUEUED", currentStep: null }), steps()).code).toBe("run.queued");
  });
});

describe("allowed flags", () => {
  it("start: a QUEUED real run or a DRY_RUN_DONE run", () => {
    expect(deriveRunAllowed(run({ status: "QUEUED" }), steps()).start).toBe(true);
    expect(deriveRunAllowed(run({ status: "DRY_RUN_DONE", dryRun: true }), steps()).start).toBe(true);
    expect(deriveRunAllowed(run({ status: "RUNNING" }), steps()).start).toBe(false);
  });
  it("abort is offered only before the point of no return; reverse only after", () => {
    expect(deriveRunAllowed(run(), steps())).toMatchObject({ abort: true, reverse: false, pause: true, resume: false, setInputs: true });
    expect(deriveRunAllowed(run({ ponrAt: t0 }), steps())).toMatchObject({ abort: false, reverse: true });
    expect(deriveRunAllowed(run({ status: "FAILED", ponrAt: t0 }), steps())).toMatchObject({ abort: false, reverse: true });
    expect(deriveRunAllowed(run({ status: "COMPLETED", ponrAt: t0 }), steps())).toMatchObject({ abort: false, reverse: false, setInputs: false });
    expect(deriveRunAllowed(run({ status: "PAUSED" }), steps())).toMatchObject({ resume: true, pause: false });
    expect(deriveRunAllowed(run({ pauseRequested: true }), steps()).pause).toBe(false);
  });
  it("cleanup needs an aborted run that has an op; decommission a completed takeover with a pending step", () => {
    expect(deriveRunAllowed(run({ status: "ABORTED", opId: "op1" }), steps()).cleanup).toBe(true);
    expect(deriveRunAllowed(run({ status: "ABORTED" }), steps()).cleanup).toBe(false);
    expect(deriveRunAllowed(run({ status: "COMPLETED", mode: "takeover" }), steps(step("DECOMMISSION", "PENDING"))).decommission).toBe(true);
    expect(deriveRunAllowed(run({ status: "COMPLETED", mode: "copy" }), steps()).decommission).toBe(false);
    expect(deriveRunAllowed(run({ status: "COMPLETED", mode: "takeover" }), steps(step("DECOMMISSION", "PASSED"))).decommission).toBe(false);
  });
  it("a dry-run offers no actions on its steps", () => {
    const a = deriveStepAllowed(run({ dryRun: true }), step("DATA_SEED", "WAITING_OPERATOR", { wait: { kind: "operator", code: "a.b", offersCommand: true, attest: ["x"] } }));
    expect(Object.values(a).every((v) => v === false)).toBe(true);
  });
  it("per-step flags follow the step status and wait", () => {
    const r = run();
    expect(deriveStepAllowed(r, step("VERIFY", "WAITING_APPROVAL")).approve).toBe(true);
    expect(deriveStepAllowed(r, step("IMPORT", "FAILED", { gate: failureGate("a.b", undefined, true) })).retry).toBe(true);
    expect(deriveStepAllowed(r, step("IMPORT", "FAILED", { gate: failureGate("a.b", undefined, false) })).retry).toBe(false);
    expect(deriveStepAllowed(r, step("DATA_SEED", "WAITING_OPERATOR", { wait: { kind: "operator", code: "a.b" } })).skip).toBe(true);
    expect(deriveStepAllowed(r, step("IMPORT", "WAITING_OPERATOR", { wait: { kind: "operator", code: "a.b" } })).skip).toBe(false);
    expect(deriveStepAllowed(r, step("DATA_FINAL", "WAITING_OPERATOR", { wait: { kind: "operator", code: "a.b", offersCommand: true } })).command).toBe(true);
    expect(deriveStepAllowed(r, step("FREEZE", "WAITING_OPERATOR", { wait: { kind: "operator", code: "a.b", offersCommand: true } })).command).toBe(false);
    expect(deriveStepAllowed(r, step("FREEZE", "WAITING_OPERATOR", { wait: { kind: "operator", code: "a.b", attest: ["c"] } })).evidence).toBe(true);
    expect(deriveStepAllowed(r, step("DATA_SEED", "PENDING")).attach).toBe(true);
    expect(deriveStepAllowed(r, step("IMPORT", "PENDING")).attach).toBe(false);
  });
});
