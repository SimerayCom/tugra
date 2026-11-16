import {
  RunLeaseLostError,
  STEP_MANIFEST,
  StepFailure,
  type AnyStepHandler,
  type CompResult,
  type CompensateHow,
  type DriveTrigger,
  type RunEventInput,
  type RunPatch,
  type RunSnapshot,
  type StepContext,
  type StepKey,
  type StepSnapshot,
  type StepStatus,
} from "../../../core/run-contract";
import { EMPTY_STEP_EVIDENCE } from "../../../core/run-contract";
import {
  ApprovalBindingSchema,
  CodeParamsSchema,
  DryRunItemSchema,
  GateResultSchema,
  RunOptionsSchema,
  WaitSpecSchema,
  type GateResult,
  type StepApprovalRecord,
  type StepEvidence,
  type StepProgress,
  type WaitSpec,
} from "../../../core/dto";
import { isRunCode } from "../../../core/run-contract";

/**
 * Thrown by a fake to simulate the hub dying at that exact line. It IS a {@link RunLeaseLostError}: that is the one error a
 * handler must never swallow, so a handler that catches transport errors and turns them into a code lets a crash through.
 */
export class Crash extends RunLeaseLostError {
  constructor(readonly at: string) {
    super("run1");
    this.message = `crash at ${at}`;
    this.name = "Crash";
  }
}

export interface StepRec {
  status: StepStatus;
  attempt: number;
  gate: GateResult | null;
  approval: StepApprovalRecord | null;
  inputHash: string | null;
  progress: StepProgress | null;
  compensation: Record<string, unknown> | null;
  evidence: StepEvidence;
  wait: WaitSpec | null;
  notBefore: Date | null;
}

export interface TickResult {
  status: StepStatus;
  /** Set when the step asked to be re-ticked (`continue`). */
  pollAfterMs?: number;
  fail?: { code: string; params?: unknown; retryable: boolean };
  wait?: WaitSpec;
  gate?: GateResult;
}

const emptyRec = (): StepRec => ({ status: "PENDING", attempt: 0, gate: null, approval: null, inputHash: null, progress: null, compensation: null, evidence: { attestations: [], attachments: [] }, wait: null, notBefore: null });

export function makeRun(over: Partial<{ -readonly [K in keyof RunSnapshot]: RunSnapshot[K] }> = {}): RunSnapshot {
  const base: RunSnapshot = {
    id: "run1",
    teamId: "team1",
    actorId: "user1",
    targetServerId: "srv1",
    sourceKind: "coolify",
    sourceHost: "coolify.example.com",
    sessionId: null,
    opId: "op1",
    opHistory: [],
    planHash: "a".repeat(32),
    mode: "copy",
    topology: "two-box",
    dryRun: false,
    promotedFromId: null,
    applyInput: { sourceKind: "coolify", targetServerId: "srv1", planHash: "a".repeat(32) },
    options: RunOptionsSchema.parse({}),
    inputs: {},
    status: "RUNNING",
    currentStep: null,
    ponrAt: null,
    windowEstimate: null,
    freezeStartedAt: null,
    freezeEndedAt: null,
    createdAt: new Date("2026-11-20T08:00:00Z"),
  };
  return { ...base, ...over };
}

/**
 * A minimal implementation of the normative engine loop of `run-contract.ts` (lane A owns the real one) so the handlers can
 * be driven end to end in specs. It is deliberately STRICT: one `StepContext` per tick whose `run`/`step` snapshots stay
 * as they were at the start of the tick (also across `act` and the re-observation), so a handler that leans on a refreshed
 * snapshot fails here instead of in production.
 */
export class StepDriver {
  run: { -readonly [K in keyof RunSnapshot]: RunSnapshot[K] };
  readonly steps = new Map<StepKey, StepRec>();
  readonly events: RunEventInput[] = [];
  now: Date;
  leaseLost = false;
  /** Called with the label of every lease-checked boundary (`assertLease`, `markPonr`, `recordCompensation`). */
  onBoundary: (label: string) => void = () => undefined;

  constructor(run: RunSnapshot = makeRun(), now = new Date("2026-11-20T10:00:00Z")) {
    this.run = { ...run };
    this.now = now;
  }

  rec(key: StepKey): StepRec {
    let r = this.steps.get(key);
    if (!r) {
      r = emptyRec();
      this.steps.set(key, r);
    }
    return r;
  }

  setStep(key: StepKey, patch: Partial<StepRec>): void {
    Object.assign(this.rec(key), patch);
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
    this.syncClock();
  }

  /** Keep the wall clock (used by the cutover service itself) on the driver's clock when Date is faked. */
  syncClock(): void {
    try {
      jest.setSystemTime(this.now);
    } catch {
      /* real timers: nothing to sync */
    }
  }

  attest(key: StepKey, checkId: string, subject?: string): void {
    this.rec(key).evidence.attestations.push({ checkId, ...(subject ? { subject } : {}), byUserId: this.run.actorId, at: this.now.toISOString() });
  }

  approve(key: StepKey, boundHash: string, over: Partial<StepApprovalRecord> = {}): void {
    this.rec(key).approval = { byUserId: this.run.actorId, at: this.now.toISOString(), boundHash, acks: [], confirmedName: null, acceptDataRisk: false, expiresAt: null, ...over };
  }

  eventCodes(): string[] {
    return this.events.map((e) => e.code);
  }

  private snapshot(key: StepKey): StepSnapshot {
    const r = this.rec(key);
    return {
      key,
      status: r.status,
      attempt: r.attempt,
      gate: r.gate,
      approval: r.approval,
      inputHash: r.inputHash,
      progress: r.progress,
      compensation: r.compensation ? { ...r.compensation } : null,
      evidence: { attestations: [...r.evidence.attestations], attachments: [...r.evidence.attachments] },
      wait: r.wait,
      notBefore: r.notBefore,
    };
  }

  private ctx(key: StepKey, trigger: DriveTrigger, validApproval: () => StepApprovalRecord | null): StepContext {
    const runSnap: RunSnapshot = { ...this.run };
    const frozen = new Map<StepKey, StepSnapshot>();
    const self = this;
    const ctx: StepContext = {
      run: runSnap,
      step: this.snapshot(key),
      actor: { userId: this.run.actorId },
      bootId: "boot-1",
      trigger,
      dryRun: this.run.dryRun,
      get approval() {
        return validApproval();
      },
      signal: new AbortController().signal,
      now: () => new Date(self.now),
      stepState: (k) => {
        let s = frozen.get(k);
        if (!s) {
          s = self.snapshot(k);
          frozen.set(k, s);
        }
        return s;
      },
      assertLease: async () => {
        self.onBoundary(`lease:${key}`);
        if (self.leaseLost) throw new Error("lease lost");
      },
      emit: async (e) => {
        // The wire contract: a lower-case code and JSON-safe, secret-free params (never English text, never a secret).
        if (!isRunCode(e.code)) throw new Error(`invalid event code ${e.code}`);
        if (e.params) CodeParamsSchema.parse(e.params);
        self.events.push(e);
      },
      setProgress: async (p) => {
        self.rec(key).progress = p;
      },
      recordCompensation: async (patch) => {
        self.onBoundary(`comp:${key}`);
        const r = self.rec(key);
        r.compensation = { ...(r.compensation ?? {}), ...patch };
      },
      patchRun: async (patch: RunPatch) => {
        if (patch.opId !== undefined) self.run.opId = patch.opId;
        if (patch.windowEstimate !== undefined) self.run.windowEstimate = patch.windowEstimate;
        if (patch.freezeStartedAt && !self.run.freezeStartedAt) self.run.freezeStartedAt = patch.freezeStartedAt;
        if (patch.freezeEndedAt && !self.run.freezeEndedAt) self.run.freezeEndedAt = patch.freezeEndedAt;
      },
      markPonr: async () => {
        if (!STEP_MANIFEST[key].ponr) throw new Error(`markPonr is only legal in the PONR step (called in ${key})`);
        if (self.run.dryRun) throw new Error("markPonr in a dry run");
        self.onBoundary("ponr");
        if (!self.run.ponrAt) {
          self.run.ponrAt = new Date(self.now);
          self.events.push({ level: "info", code: "run.ponr.reached", stepKey: key });
        }
        return self.run.ponrAt;
      },
    };
    return ctx;
  }

  /** A fresh context for a direct call of a handler method (no approval). */
  contextFor(key: StepKey, trigger: DriveTrigger = "tick"): StepContext {
    return this.ctx(key, trigger, () => null);
  }

  /** What the post gate says right now (a fresh observation). */
  async postGateOf(h: AnyStepHandler): Promise<GateResult> {
    const ctx = this.contextFor(h.key);
    return h.postGate(ctx, await h.observe(ctx));
  }

  /** One engine tick of one step, following the normative loop. */
  async tick(h: AnyStepHandler, trigger: DriveTrigger = "tick"): Promise<TickResult> {
    const key: StepKey = h.key;
    const rec = this.rec(key);
    let approval: StepApprovalRecord | null = null;
    const ctx = this.ctx(key, trigger, () => approval);
    if (!h.applicable(ctx.run)) {
      rec.status = "SKIPPED";
      return { status: "SKIPPED" };
    }
    if (this.run.dryRun) {
      const items = await h.dryRun(ctx);
      for (const i of items) DryRunItemSchema.parse(i);
      rec.progress = { done: 0, total: items.length, unit: "item", dryRun: items };
      rec.status = "PASSED";
      return { status: "PASSED" };
    }
    try {
      const obs = await h.observe(ctx);
      const post = GateResultSchema.parse(h.postGate(ctx, obs));
      if (post.passed) {
        rec.status = "PASSED";
        rec.gate = post;
        return { status: "PASSED", gate: post };
      }
      const binding = h.approvalBinding ? await h.approvalBinding(ctx, obs) : null;
      if (binding) ApprovalBindingSchema.parse(binding);
      if (binding && rec.approval && rec.approval.boundHash === binding.inputHash && (rec.approval.expiresAt === null || Date.parse(rec.approval.expiresAt) > this.now.getTime())) approval = rec.approval;
      const pre = GateResultSchema.parse(h.preGate(ctx, obs));
      rec.gate = pre;
      if (!pre.passed) {
        const w = pre.wait ?? ({ kind: "operator", code: "gate.blocked" } as WaitSpec);
        rec.wait = w;
        rec.status = w.kind === "timer" ? "WAITING_TIMER" : w.kind === "approval" ? "WAITING_APPROVAL" : "WAITING_OPERATOR";
        rec.notBefore = w.kind === "timer" ? new Date(w.notBefore) : null;
        return { status: rec.status, wait: w, gate: pre };
      }
      if (binding && !approval) {
        rec.status = "WAITING_APPROVAL";
        rec.wait = { kind: "approval", binding };
        return { status: "WAITING_APPROVAL", wait: rec.wait };
      }
      rec.attempt++;
      rec.status = "RUNNING";
      const res = await h.act(ctx, obs);
      if (res.outcome === "done") {
        const obs2 = await h.observe(ctx);
        const post2 = GateResultSchema.parse(h.postGate(ctx, obs2));
        rec.gate = post2;
        if (post2.passed) {
          rec.status = "PASSED";
          rec.wait = null;
          return { status: "PASSED", gate: post2 };
        }
        rec.status = "FAILED";
        return { status: "FAILED", fail: { code: "step.post-gate-failed", retryable: true }, gate: post2 };
      }
      if (res.outcome === "continue") return { status: "RUNNING", pollAfterMs: Math.min(60_000, Math.max(1_000, res.pollAfterMs)) };
      if (res.outcome === "wait") {
        WaitSpecSchema.parse(res.wait);
        rec.wait = res.wait;
        rec.status = res.wait.kind === "timer" ? "WAITING_TIMER" : res.wait.kind === "approval" ? "WAITING_APPROVAL" : "WAITING_OPERATOR";
        rec.notBefore = res.wait.kind === "timer" ? new Date(res.wait.notBefore) : null;
        return { status: rec.status, wait: res.wait };
      }
      if (!isRunCode(res.code)) throw new Error(`invalid failure code ${res.code}`);
      rec.status = "FAILED";
      return { status: "FAILED", fail: { code: res.code, params: res.params, retryable: res.retryable } };
    } catch (e) {
      if (e instanceof StepFailure) {
        if (e.params) CodeParamsSchema.parse(e.params);
        rec.status = "FAILED";
        return { status: "FAILED", fail: { code: e.code, params: e.params, retryable: e.retryable } };
      }
      if (e instanceof Crash) throw e;
      rec.status = "FAILED";
      return { status: "FAILED", fail: { code: "step.internal-error", params: { message: (e as Error).message }, retryable: true } };
    }
  }

  /** Tick until the step settles (PASSED/FAILED/SKIPPED or an operator/approval wait), advancing the clock like the engine would. */
  async drive(h: AnyStepHandler, o: { maxTicks?: number; stopOnTimer?: boolean; between?: () => Promise<void> } = {}): Promise<TickResult> {
    let trigger: DriveTrigger = "enter";
    let last: TickResult = { status: "PENDING" };
    for (let i = 0; i < (o.maxTicks ?? 60); i++) {
      last = await this.tick(h, trigger);
      if (last.status === "RUNNING" && last.pollAfterMs) {
        this.advance(last.pollAfterMs);
        await o.between?.();
        trigger = "tick";
        continue;
      }
      if (last.status === "WAITING_TIMER" && !o.stopOnTimer) {
        const nb = this.rec(h.key).notBefore;
        if (nb && nb > this.now) this.advance(nb.getTime() - this.now.getTime());
        trigger = "timer";
        continue;
      }
      return last;
    }
    return last;
  }

  /** Call `compensate` the way the engine does. */
  async compensate(h: AnyStepHandler, how: CompensateHow): Promise<CompResult> {
    const ctx = this.ctx(h.key, "tick", () => null);
    const r = await h.compensate(ctx, how);
    if (r.code && !isRunCode(r.code)) throw new Error(`invalid compensation code ${r.code}`);
    if (r.params) CodeParamsSchema.parse(r.params);
    for (const m of r.manual ?? []) {
      if (!isRunCode(m.code)) throw new Error(`invalid manual code ${m.code}`);
      if (m.params) CodeParamsSchema.parse(m.params);
    }
    return r;
  }
}

export { EMPTY_STEP_EVIDENCE };
