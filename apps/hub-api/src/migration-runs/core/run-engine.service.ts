/**
 * The run engine (P7 lane A): drives a `MigrationRun` through its step handlers.
 *
 * One engine pass (`drive`) holds the run's lease (`ownerId = bootId`), re-reads the run before every tick and applies the
 * normative loop of `StepHandler` (see run-contract.ts): observe -> postGate -> approval -> preGate -> act. Nothing is
 * remembered in process memory except cancellation handles: every decision is rebuilt from the rows, which is what makes a
 * hub restart safe (`RunRecoveryService` simply drives the run again under the new boot id).
 *
 * Authority: a run is only ever changed by the process that holds its lease. The service's human actions are
 * compare-and-set writes on the rows plus a `kick`; the transitions they request (pause, abort, cleanup, reverse) are
 * applied by the loop, so there is exactly one writer of the state machine.
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { DeployLeaseService } from "../../applications/deploy-lease.service";
import {
  CodeParamsSchema,
  OwnerInputsSchema,
  RunApplyInputSchema,
  RunOptionsSchema,
  WindowEstimateSchema,
  type ApprovalBinding,
  type CodeParams,
  type DryRunItem,
  type GateResult,
  type StepApprovalRecord,
  type StepEvidence,
  type WaitSpec,
} from "./dto";
import {
  EMPTY_STEP_EVIDENCE,
  RunLeaseLostError,
  STEP_HANDLERS,
  STEP_MANIFEST,
  StepFailure,
  isRunCode,
  type ActResult,
  type AnyStepHandler,
  type CompResult,
  type CompensateHow,
  type DriveTrigger,
  type Observation,
  type RunMode,
  type RunSnapshot,
  type RunStatus,
  type RunTopology,
  type StepContext,
  type StepHandlerRegistry,
  type StepKey,
  type StepSnapshot,
  type StepStatus,
  type RunEventInput,
  type RunPatch as ContractRunPatch,
} from "./run-contract";
import {
  DRIVABLE_STATUSES,
  WAIT_SINCE_KEY,
  clampPollMs,
  evaluateApproval,
  failureGate,
  gateFromDryRun,
  isWaitingStep,
  nextFlowStep,
  parkStatus,
  sameWait,
  stable,
  stripSince,
  waitSince,
} from "./run-logic";
import { RUN_ENV, RUN_SINK, RUN_STORE, type RunEnvPort, type RunSinkPort } from "./run-ports";
import type { RunRow, RunStore, StepRow } from "./run-store";

/** Thrown inside `markPonr` when an abort won the race: the handler must stop, nothing was flipped. */
export class RunAbortRequestedError extends Error {
  constructor(readonly runId: string) {
    super(`abort requested for run ${runId}`);
    this.name = "RunAbortRequestedError";
  }
}

/** Compensation key the engine writes on the IMPORT step before a cleanup (consumed by the IMPORT handler). */
export const CLEANUP_REQUEST_KEY = "cleanupRequest";
export interface CleanupRequest {
  includeData: boolean;
  dataConfirmNames: string[];
}

/** Injectable time source (the specs run on a fake clock). */
export interface RunClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
const REAL_CLOCK: RunClock = { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Engine tunables (the specs shrink them). */
export interface EngineOptions {
  /** Lease heartbeat period; 0 disables the timer (specs). */
  heartbeatMs: number;
}

type TickResult = { kind: "advance" } | { kind: "sleep"; ms: number } | { kind: "idle" };
type Command = { fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** Per-run in-process driving state (cancellation handles only; never authority). */
class Driving {
  controller = new AbortController();
  readonly kicks: DriveTrigger[] = [];
  readonly commands: Command[] = [];
  /** Resolves when the pass ends (so a second `drive` call can be awaited too). */
  done: Promise<void> = Promise.resolve();
  private waker: (() => void) | null = null;

  wake(): void {
    const w = this.waker;
    this.waker = null;
    w?.();
  }
  /** Resolves on the next wake (or immediately when something is already queued). */
  waitWake(): Promise<void> {
    if (this.kicks.length || this.commands.length) return Promise.resolve();
    return new Promise((r) => {
      this.waker = r;
    });
  }
  interrupt(): void {
    this.controller.abort();
    this.wake();
  }
}

const DRIVING_STATUSES: readonly RunStatus[] = ["RUNNING", "WAITING"];
const errLog = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isAbortLike = (e: unknown): boolean => e instanceof Error && (e.name === "AbortError" || e instanceof RunAbortRequestedError);

@Injectable()
export class RunEngineService implements OnModuleDestroy {
  private readonly logger = new Logger(RunEngineService.name);
  private readonly driving = new Map<string, Driving>();
  /** Set by the service: persists the final report once a run settles (best effort, never throws). */
  terminalHook?: (runId: string) => Promise<void>;
  clock: RunClock = REAL_CLOCK;
  options: EngineOptions = { heartbeatMs: 10_000 };

  constructor(
    @Inject(RUN_STORE) private readonly store: RunStore,
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    private readonly lease: DeployLeaseService,
    @Inject(RUN_ENV) private readonly env: RunEnvPort,
    @Inject(RUN_SINK) private readonly sink: RunSinkPort,
  ) {}

  get bootId(): string {
    return this.lease.bootId;
  }

  onModuleDestroy(): void {
    for (const d of this.driving.values()) d.interrupt();
  }

  // ───────────────────────────── entry points ─────────────────────────────

  /** Is this process driving the run right now? */
  isDriving(runId: string): boolean {
    return this.driving.has(runId);
  }

  /** Ask the engine to look at a run again (fire and forget). */
  kick(runId: string, trigger: DriveTrigger = "tick"): void {
    void this.drive(runId, trigger).catch((e: unknown) => this.logger.warn(`run ${runId}: drive failed: ${errLog(e)}`));
  }

  /** Stop what the loop is doing right now (pause/abort requested): in-flight handlers see the signal abort. */
  interrupt(runId: string): void {
    this.driving.get(runId)?.interrupt();
  }

  /**
   * Run `fn` as an exclusive command: inside the driving loop when this process drives the run (between two ticks), else
   * under a short-lived lease of its own. Used for the few human actions that call a handler (skip, decommission).
   */
  async exclusive<T>(runId: string, statusIn: readonly RunStatus[], fn: () => Promise<T>): Promise<T> {
    const d = this.driving.get(runId);
    if (d) {
      return new Promise<T>((resolve, reject) => {
        d.commands.push({ fn, resolve: resolve as (v: unknown) => void, reject });
        d.wake();
      });
    }
    const mine = new Driving();
    this.driving.set(runId, mine);
    try {
      const c = await this.store.claim(runId, this.bootId, this.clock.now(), statusIn);
      if (!c.claimed) throw new RunLeaseLostError(runId);
      return await fn();
    } finally {
      this.driving.delete(runId);
    }
  }

  /**
   * Drive a run until it parks (waiting for a human / timer), settles, pauses or fails. Never throws. Safe to call any
   * number of times: a second call while this process is already driving only wakes the loop.
   */
  drive(runId: string, trigger: DriveTrigger = "tick"): Promise<void> {
    const existing = this.driving.get(runId);
    if (existing) {
      existing.kicks.push(trigger);
      existing.wake();
      return existing.done;
    }
    const d = new Driving();
    this.driving.set(runId, d);
    d.done = this.pass(runId, d, trigger);
    return d.done;
  }

  private async pass(runId: string, d: Driving, trigger: DriveTrigger): Promise<void> {
    let hb: ReturnType<typeof setInterval> | undefined;
    try {
      const c = await this.store.claim(runId, this.bootId, this.clock.now(), DRIVABLE_STATUSES);
      if (!c.claimed) return;
      if (c.previousOwner && c.previousOwner !== this.bootId) {
        await this.store.appendEvent(runId, { stepKey: null, level: "info", code: "run.recovered", params: null, actorId: null }, this.bootId);
      }
      if (this.options.heartbeatMs > 0) {
        hb = setInterval(() => void this.store.heartbeat(runId, this.bootId, this.clock.now()).catch(() => undefined), this.options.heartbeatMs);
        hb.unref?.();
      }
      await this.loop(runId, d, c.previousOwner && c.previousOwner !== this.bootId && trigger === "tick" ? "recover" : trigger);
      await this.runCommands(d); // a command that raced the end of the pass still runs under the lease
    } catch (e) {
      if (e instanceof RunLeaseLostError) this.logger.warn(`run ${runId}: lease lost, stopping`);
      else this.logger.warn(`run ${runId}: engine pass failed: ${errLog(e)}`);
    } finally {
      if (hb) clearInterval(hb);
      for (const c of d.commands.splice(0)) c.reject(new RunLeaseLostError(runId));
      this.driving.delete(runId);
    }
  }

  /**
   * Drive ONE manual step (DECOMMISSION) of a finished takeover run. The run stays COMPLETED; only the step row moves.
   */
  driveManual(runId: string, key: StepKey, trigger: DriveTrigger = "tick"): Promise<void> {
    const existing = this.driving.get(runId);
    if (existing) {
      existing.kicks.push(trigger);
      existing.wake();
      return existing.done;
    }
    const d = new Driving();
    this.driving.set(runId, d);
    d.done = this.manualPass(runId, key, d, trigger);
    return d.done;
  }

  private async manualPass(runId: string, key: StepKey, d: Driving, trigger: DriveTrigger): Promise<void> {
    try {
      const c = await this.store.claim(runId, this.bootId, this.clock.now(), ["COMPLETED"]);
      if (!c.claimed) return;
      let trig: DriveTrigger = trigger;
      for (;;) {
        const run = await this.store.get(runId);
        if (!run || run.status !== "COMPLETED") return;
        const r = await this.stepTick(run, trig, d, key);
        trig = d.kicks.shift() ?? "tick";
        if (r.kind === "sleep") {
          await this.nap(d, r.ms);
          continue;
        }
        if (r.kind === "idle" && d.kicks.length) continue;
        break;
      }
    } catch (e) {
      if (!(e instanceof RunLeaseLostError)) this.logger.warn(`run ${runId}: manual step ${key} failed: ${errLog(e)}`);
    } finally {
      // the run is terminal: hand the lease back
      await this.store.updateRun(runId, { bootId: this.bootId }, { ownerId: null }).catch(() => undefined);
      this.driving.delete(runId);
    }
  }

  /**
   * Compensate ONE step (the operator skipped it after it had started). Must run inside {@link exclusive}: the caller holds
   * the run's lease. A handler-less step has nothing to undo.
   */
  async compensateOne(runId: string, key: StepKey, how: CompensateHow): Promise<CompResult> {
    const run = await this.store.get(runId);
    const handler = this.registry.get(key);
    if (!run || !handler) return { outcome: "nothing-to-do" };
    const rows = await this.store.steps(runId);
    const row = rows.find((r) => r.key === key);
    if (!row) return { outcome: "nothing-to-do" };
    const ctx = this.makeCtx(run, row, rows, "tick", new AbortController().signal, null, false);
    try {
      return await handler.compensate(ctx, how);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      this.logger.error(`run ${runId} ${key}: compensate(${how}) threw: ${errLog(e)}`);
      return { outcome: "failed", code: e instanceof StepFailure ? e.code : "step.internal-error" };
    }
  }

  /** The approval binding a step shows right now (read-only: `observe` + `approvalBinding`), or null. */
  async bindingFor(runId: string, key: StepKey): Promise<ApprovalBinding | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    const handler = this.registry.get(key);
    if (!handler?.approvalBinding) return null;
    const rows = await this.store.steps(runId);
    const row = rows.find((r) => r.key === key);
    if (!row) return null;
    const ctx = this.makeCtx(run, row, rows, "tick", new AbortController().signal, null, true);
    const obs = await handler.observe(ctx);
    return handler.approvalBinding(ctx, obs);
  }

  // ───────────────────────────── the loop ─────────────────────────────

  private async loop(runId: string, d: Driving, firstTrigger: DriveTrigger): Promise<void> {
    let trigger = firstTrigger;
    for (;;) {
      await this.runCommands(d);
      const run = await this.store.get(runId);
      if (!run) return;
      if (d.controller.signal.aborted) d.controller = new AbortController();
      const trig = d.kicks.shift() ?? trigger;
      trigger = "tick";

      switch (run.status) {
        case "RUNNING":
        case "WAITING": {
          if (run.pauseRequested) {
            if (!(await this.setStatus(run, "PAUSED", {}))) continue; // an abort/reverse won: the loop re-reads and applies it
            await this.emit(run.id, { level: "info", code: "run.paused" });
            return;
          }
          if (!run.startedAt) {
            await this.owned(run.id, { startedAt: this.clock.now() });
            await this.emit(run.id, { level: "info", code: "run.started" });
          }
          const standing = await this.env.standing(run.actorId, run.teamId);
          if (!standing.member || !standing.appsConfig || !standing.databases) {
            if (!(await this.setStatus(run, "PAUSED", {}))) continue;
            await this.emit(run.id, { level: "warn", code: "run.auth-lost" });
            await this.sink.notify(run.teamId, { runId: run.id, kind: "auth-lost", mode: run.mode as RunMode, stepKey: run.currentStep, code: "run.auth-lost" }).catch(() => undefined);
            return;
          }
          const r = await this.stepTick(run, trig, d);
          if (r.kind === "advance") continue;
          if (r.kind === "sleep") {
            await this.nap(d, r.ms);
            continue;
          }
          if (d.kicks.length || d.commands.length) continue;
          return;
        }
        case "ABORTING":
          await this.compensateRun(run, "abort", d);
          continue;
        case "ROLLING_BACK":
          await this.compensateRun(run, "cleanup", d);
          continue;
        case "REVERSING":
          await this.compensateRun(run, "reverse", d);
          continue;
        default:
          return;
      }
    }
  }

  private async runCommands(d: Driving): Promise<void> {
    for (let c = d.commands.shift(); c; c = d.commands.shift()) {
      try {
        c.resolve(await c.fn());
      } catch (e) {
        c.reject(e);
      }
    }
  }

  private async nap(d: Driving, ms: number): Promise<void> {
    await Promise.race([this.clock.sleep(ms), d.waitWake()]);
  }

  // ───────────────────────────── one tick of one step ─────────────────────────────

  private async stepTick(run: RunRow, trigger: DriveTrigger, d: Driving, forceKey?: StepKey): Promise<TickResult> {
    const manual = forceKey !== undefined;
    const mode = run.mode as RunMode;
    const rows = await this.store.steps(run.id);
    const statusMap = new Map<StepKey, StepStatus>(rows.map((r) => [r.key as StepKey, r.status as StepStatus]));
    const key = forceKey ?? nextFlowStep(mode, statusMap);
    if (!key) return this.completeFlow(run);
    const row = rows.find((r) => r.key === key);
    if (!row) throw new Error(`run ${run.id} has no step row for ${key}`);
    const handler = this.registry.get(key);
    const now = this.clock.now();

    if (!manual && run.currentStep !== key) await this.owned(run.id, { currentStep: key });
    if (row.status === "PENDING") {
      await this.store.updateStep(run.id, key, { status: "RUNNING", startedAt: now, lastError: null }, this.bootId);
      await this.emit(run.id, { level: "info", code: "step.entered", stepKey: key });
      row.status = "RUNNING";
      row.startedAt = now;
    }
    if (!manual && run.status === "WAITING" && !isWaitingStep(row.status as StepStatus)) {
      if (!(await this.setStatus(run, "RUNNING", {}))) return { kind: "advance" };
    }

    const ctxFor = (approval: StepApprovalRecord | null = null): StepContext => this.makeCtx(run, row, rows, trigger, d.controller.signal, approval, false);

    if (!handler) {
      if (run.dryRun) return this.dryRunPass(run, row, [{ code: "step.handler-unavailable", level: "unknown" }]);
      return this.failStep(run, row, "step.handler-unavailable", undefined, false, manual);
    }

    // applicable?
    if (!handler.applicable(this.snapshot(run))) {
      await this.store.updateStep(
        run.id,
        key,
        { status: "SKIPPED", lastError: "step.not-applicable", finishedAt: now, wait: null, notBefore: null, gate: null },
        this.bootId,
      );
      await this.emit(run.id, { level: "info", code: "step.skipped", stepKey: key, params: { reason: "not-applicable" } });
      return { kind: "advance" };
    }

    if (run.dryRun) {
      let items: DryRunItem[];
      try {
        items = await handler.dryRun(ctxFor());
      } catch (e) {
        if (e instanceof RunLeaseLostError) throw e;
        this.logger.warn(`run ${run.id} ${key}: dryRun failed: ${errLog(e)}`);
        items = [{ code: e instanceof StepFailure ? e.code : "step.internal-error", level: "unknown" }];
      }
      return this.dryRunPass(run, row, items);
    }

    // ── real run ──
    const parked = isWaitingStep(row.status as StepStatus);
    const gate = row.gate as GateResult | null;
    const passiveTrigger = trigger === "tick" || trigger === "timer" || trigger === "recover";
    const actWaiting = parked && gate?.passed === true && passiveTrigger && (row.status === "WAITING_OPERATOR" || (row.status === "WAITING_TIMER" && row.notBefore !== null && row.notBefore.getTime() > now.getTime()));

    let ctx = ctxFor();
    let obs: Observation;
    try {
      obs = await handler.observe(ctx);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      if (isAbortLike(e) || d.controller.signal.aborted) return { kind: "idle" };
      if (parked && passiveTrigger) {
        this.logger.warn(`run ${run.id} ${key}: observe failed while parked: ${errLog(e)}`);
        return { kind: "idle" };
      }
      return this.handlerFailed(run, row, e, manual);
    }
    await this.persistProgress(run.id, row, obs);

    const post = handler.postGate(ctx, obs);
    if (post.passed) return this.markPassed(run, row, post);
    if (actWaiting) return { kind: "idle" };

    // approval
    let binding: ApprovalBinding | null = null;
    let approval: StepApprovalRecord | null = null;
    if (handler.approvalBinding) {
      try {
        binding = await handler.approvalBinding(ctx, obs);
      } catch (e) {
        if (e instanceof RunLeaseLostError) throw e;
        return this.handlerFailed(run, row, e, manual);
      }
      if (binding) {
        if (row.inputHash !== binding.inputHash) {
          await this.store.updateStep(run.id, key, { inputHash: binding.inputHash }, this.bootId);
          row.inputHash = binding.inputHash;
        }
        const stored = row.approval as StepApprovalRecord | null;
        const verdict = evaluateApproval(binding, stored, now);
        if (verdict.valid) approval = stored;
        else if (stored) {
          await this.store.updateStep(run.id, key, { approval: null }, this.bootId);
          row.approval = null;
          await this.emit(run.id, { level: "warn", code: verdict.reason === "expired" ? "approval.expired" : "approval.void", stepKey: key, params: { reason: verdict.reason } });
        }
      }
      ctx = ctxFor(approval);
    }

    const pre = handler.preGate(ctx, obs);
    if (!pre.passed) {
      return this.park(run, row, pre.wait ?? { kind: "operator", code: "step.gate-blocked" }, pre, manual);
    }
    if (binding && !approval) {
      return this.park(run, row, { kind: "approval", binding }, pre, manual);
    }

    // ── act ──
    const attempt = row.attempt + 1;
    await this.store.updateStep(run.id, key, { attempt, status: "RUNNING", wait: null, gate: pre, notBefore: null, lastError: null, finishedAt: null }, this.bootId);
    row.attempt = attempt;
    row.status = "RUNNING";
    if (!manual && run.status !== "RUNNING" && !(await this.setStatus(run, "RUNNING", {}))) return { kind: "advance" }; // an abort/reverse won: do not act
    ctx = this.makeCtx(run, row, rows, trigger, d.controller.signal, approval, false);
    let res: ActResult;
    try {
      res = await handler.act(ctx, obs);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      if (isAbortLike(e) || d.controller.signal.aborted) return { kind: "idle" };
      return this.handlerFailed(run, row, e, manual);
    }
    switch (res.outcome) {
      case "done": {
        let after: Observation;
        try {
          after = await handler.observe(this.makeCtx(run, row, rows, trigger, d.controller.signal, approval, false));
        } catch (e) {
          if (e instanceof RunLeaseLostError) throw e;
          if (isAbortLike(e) || d.controller.signal.aborted) return { kind: "idle" };
          return this.handlerFailed(run, row, e, manual);
        }
        await this.persistProgress(run.id, row, after);
        const verdict = handler.postGate(ctx, after);
        if (verdict.passed) return this.markPassed(run, row, verdict);
        return this.failStep(run, row, "step.post-gate-failed", undefined, true, manual, verdict);
      }
      case "continue":
        return { kind: "sleep", ms: clampPollMs(res.pollAfterMs) };
      case "wait":
        return this.park(run, row, res.wait, pre, manual);
      case "fail":
        if (!isRunCode(res.code)) return this.failStep(run, row, "step.internal-error", undefined, false, manual);
        return this.failStep(run, row, res.code, res.params, res.retryable, manual);
    }
  }

  private async persistProgress(runId: string, row: StepRow, obs: Observation): Promise<void> {
    if (!obs.progress) return;
    const prev = row.progress as { dryRun?: unknown } | null;
    const next = { ...obs.progress, ...(prev?.dryRun ? { dryRun: prev.dryRun } : {}) };
    if (stable(row.progress) === stable(next)) return;
    await this.store.updateStep(runId, row.key as StepKey, { progress: next }, this.bootId);
    row.progress = next as never;
  }

  private async dryRunPass(run: RunRow, row: StepRow, items: DryRunItem[]): Promise<TickResult> {
    const capped = items.slice(0, 500);
    await this.store.updateStep(
      run.id,
      row.key as StepKey,
      {
        status: "PASSED",
        gate: gateFromDryRun(capped),
        progress: { done: 0, total: capped.length, unit: "item", dryRun: capped },
        finishedAt: this.clock.now(),
        wait: null,
        notBefore: null,
        lastError: null,
      },
      this.bootId,
    );
    await this.emit(run.id, { level: "info", code: "step.passed", stepKey: row.key as StepKey, params: { dryRun: true } });
    return { kind: "advance" };
  }

  private async markPassed(run: RunRow, row: StepRow, gate: GateResult): Promise<TickResult> {
    const key = row.key as StepKey;
    await this.store.updateStep(run.id, key, { status: "PASSED", gate, wait: null, notBefore: null, finishedAt: this.clock.now(), lastError: null }, this.bootId);
    await this.emit(run.id, { level: "info", code: "step.passed", stepKey: key });
    return { kind: "advance" };
  }

  private async park(run: RunRow, row: StepRow, wait: WaitSpec, gate: GateResult, manual: boolean): Promise<TickResult> {
    const key = row.key as StepKey;
    const target = parkStatus(wait);
    const prev = row.wait as WaitSpec | null;
    const changed = row.status !== target || !sameWait(prev, wait);
    const since = changed ? this.clock.now().toISOString() : (waitSince(prev) ?? this.clock.now().toISOString());
    // the engine's own bookkeeping on an unchanged wait (the watchdog's `_stuck` marker) survives a re-park
    const hidden = !changed && prev ? Object.fromEntries(Object.entries(prev).filter(([k]) => k.startsWith("_"))) : {};
    const stored = { ...wait, ...hidden, [WAIT_SINCE_KEY]: since };
    await this.store.updateStep(
      run.id,
      key,
      { status: target, wait: stored, gate, notBefore: wait.kind === "timer" ? new Date(wait.notBefore) : null },
      this.bootId,
    );
    row.status = target;
    row.wait = stored as never;
    if (changed) {
      const code = wait.kind === "approval" ? "step.waiting-approval" : wait.code;
      await this.emit(run.id, { level: "info", code: "step.waiting", stepKey: key, params: { kind: wait.kind, reason: code } });
      if (!manual) await this.sink.notify(run.teamId, { runId: run.id, kind: "waiting", mode: run.mode as RunMode, stepKey: key, code }).catch(() => undefined);
    }
    if (!manual && run.status !== "WAITING" && !(await this.setStatus(run, "WAITING", {}))) return { kind: "advance" }; // an abort/reverse won
    return { kind: "idle" };
  }

  private async handlerFailed(run: RunRow, row: StepRow, e: unknown, manual: boolean): Promise<TickResult> {
    if (e instanceof StepFailure) return this.failStep(run, row, e.code, e.params, e.retryable, manual);
    this.logger.error(`run ${run.id} ${row.key}: handler threw: ${errLog(e)}`);
    return this.failStep(run, row, "step.internal-error", undefined, true, manual);
  }

  private async failStep(run: RunRow, row: StepRow, code: string, params: CodeParams | undefined, retryable: boolean, manual: boolean, gate?: GateResult): Promise<TickResult> {
    const key = row.key as StepKey;
    const safeParams = params && CodeParamsSchema.safeParse(params).success ? params : undefined;
    const base = failureGate(code, safeParams, retryable);
    const fgate: GateResult = gate ? { ...base, checks: [...base.checks, ...gate.checks] } : base;
    await this.store.updateStep(
      run.id,
      key,
      { status: "FAILED", lastError: code, gate: fgate, wait: null, notBefore: null, finishedAt: this.clock.now() },
      this.bootId,
    );
    await this.emit(run.id, { level: "error", code: "step.failed", stepKey: key, params: { code, ...(safeParams ?? {}) } });
    if (!manual) {
      if (!(await this.setStatus(run, "FAILED", { failureStep: key, failureCode: code }))) return { kind: "advance" }; // an abort/reverse won: it compensates this step
      await this.emit(run.id, { level: "error", code: "run.failed", stepKey: key, params: { code } });
      await this.sink.notify(run.teamId, { runId: run.id, kind: "failed", mode: run.mode as RunMode, stepKey: key, code }).catch(() => undefined);
    }
    return { kind: "idle" };
  }

  /** Every flow step passed or was skipped. */
  private async completeFlow(run: RunRow): Promise<TickResult> {
    const now = this.clock.now();
    if (run.dryRun) {
      if (!(await this.setStatus(run, "DRY_RUN_DONE", { finishedAt: now, currentStep: null, pauseRequested: false }))) return { kind: "advance" };
      await this.emit(run.id, { level: "info", code: "run.dry-run-done" });
      await this.settled(run.id);
      await this.release(run.id);
      return { kind: "idle" };
    }
    if (!(await this.setStatus(run, "COMPLETED", { finishedAt: now, currentStep: null, activeKey: null, failureStep: null, failureCode: null }))) return { kind: "advance" };
    await this.emit(run.id, { level: "info", code: "run.completed" });
    await this.sink.notify(run.teamId, { runId: run.id, kind: "completed", mode: run.mode as RunMode, stepKey: null, code: "run.completed" }).catch(() => undefined);
    await this.sink.audit({ actor: run.actorId, action: "migration.run.complete", target: run.id, meta: { mode: run.mode, topology: run.topology } }).catch(() => undefined);
    await this.settled(run.id);
    await this.release(run.id);
    return { kind: "idle" };
  }

  // ───────────────────────────── compensation (abort / cleanup / reverse) ─────────────────────────────

  private async compensateRun(run: RunRow, how: CompensateHow, d: Driving): Promise<void> {
    const rows = (await this.store.steps(run.id)).sort((a, b) => b.idx - a.idx);
    const cands = rows.filter((r) => {
      const s = r.status as StepStatus;
      if (s === "PENDING" || s === "SKIPPED") return false;
      if (how === "abort") return s !== "COMPENSATED";
      if (how === "reverse") return r.rollbackClass === "LOSSY_AFTER_PONR";
      return true; // cleanup: every step that ever acted (the handlers return nothing-to-do unless they own a resource)
    });
    let failure: { key: StepKey; code: string } | null = null;
    const manual: Array<{ code: string; params?: CodeParams }> = [];
    if (!run.dryRun) {
      for (const row of cands) {
        const key = row.key as StepKey;
        const handler = this.registry.get(key);
        if (!handler) continue;
        const ctx = this.makeCtx(run, row, rows, "tick", d.controller.signal, null, false);
        let res: CompResult;
        try {
          res = await handler.compensate(ctx, how);
        } catch (e) {
          if (e instanceof RunLeaseLostError) throw e;
          this.logger.error(`run ${run.id} ${key}: compensate(${how}) threw: ${errLog(e)}`);
          res = { outcome: "failed", code: e instanceof StepFailure ? e.code : "step.internal-error" };
        }
        const code = res.code && isRunCode(res.code) ? res.code : undefined;
        await this.emit(run.id, { level: res.outcome === "failed" ? "error" : "info", code: "step.compensated", stepKey: key, params: { how, outcome: res.outcome, ...(code ? { code } : {}) } });
        if (res.outcome === "done" && how === "abort") await this.store.updateStep(run.id, key, { status: "COMPENSATED" }, this.bootId);
        if (res.outcome === "manual") for (const m of res.manual ?? []) if (isRunCode(m.code)) manual.push({ code: m.code, ...(m.params ? { params: m.params } : {}) });
        if (res.outcome === "failed") {
          failure = { key, code: code ?? "step.compensation-failed" };
          break;
        }
      }
    }
    if (manual.length) await this.appendManual(run.id, manual);
    const now = this.clock.now();
    if (failure) {
      if (how === "cleanup") {
        await this.owned(run.id, { status: "ABORTED", activeKey: null, failureStep: failure.key, failureCode: failure.code });
        await this.emit(run.id, { level: "error", code: "run.failed", stepKey: failure.key, params: { code: failure.code, how } });
        await this.release(run.id);
      } else {
        await this.owned(run.id, { status: "FAILED", failureStep: failure.key, failureCode: failure.code, abortRequested: false });
        await this.emit(run.id, { level: "error", code: "run.failed", stepKey: failure.key, params: { code: failure.code, how } });
        await this.sink.notify(run.teamId, { runId: run.id, kind: "failed", mode: run.mode as RunMode, stepKey: failure.key, code: failure.code }).catch(() => undefined);
      }
      return;
    }
    if (how === "abort") {
      await this.owned(run.id, { status: "ABORTED", finishedAt: now, activeKey: null, abortRequested: false, failureStep: null, failureCode: null });
      await this.emit(run.id, { level: "info", code: "run.aborted" });
      await this.sink.notify(run.teamId, { runId: run.id, kind: "aborted", mode: run.mode as RunMode, stepKey: null, code: "run.aborted" }).catch(() => undefined);
    } else if (how === "cleanup") {
      await this.owned(run.id, { status: "ROLLED_BACK", finishedAt: now, activeKey: null, failureStep: null, failureCode: null });
      await this.emit(run.id, { level: "info", code: "run.rolled-back" });
    } else {
      await this.owned(run.id, { status: "REVERSED", finishedAt: now, activeKey: null, failureStep: null, failureCode: null });
      await this.emit(run.id, { level: "info", code: "run.reversed" });
      await this.appendManual(run.id, [{ code: "run.reverse-sync-guidance" }]);
      await this.sink.notify(run.teamId, { runId: run.id, kind: "reversed", mode: run.mode as RunMode, stepKey: null, code: "run.reversed" }).catch(() => undefined);
    }
    await this.settled(run.id);
    await this.release(run.id);
  }

  /** Hand the lease back (the run is settled: nobody drives it any more). */
  private async release(runId: string): Promise<void> {
    await this.owned(runId, { ownerId: null });
  }

  /** Operator steps a compensation could not do itself (kept in `report.manual`, shown by the view and the report). */
  private async appendManual(runId: string, items: Array<{ code: string; params?: CodeParams }>): Promise<void> {
    const row = await this.store.get(runId);
    const prev = (row?.report && typeof row.report === "object" ? (row.report as { manual?: Array<{ code: string; params?: CodeParams }> }) : {}) as { manual?: Array<{ code: string; params?: CodeParams }> };
    const have = new Set((prev.manual ?? []).map((m) => stable(m)));
    const merged = [...(prev.manual ?? []), ...items.filter((m) => !have.has(stable(m)))];
    await this.owned(runId, { report: { ...(row?.report && typeof row.report === "object" ? row.report : {}), manual: merged } });
  }

  private async settled(runId: string): Promise<void> {
    if (!this.terminalHook) return;
    await this.terminalHook(runId).catch((e: unknown) => this.logger.warn(`run ${runId}: report persist failed: ${errLog(e)}`));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /**
   * The engine's own run-status write: a compare-and-set on the driving statuses. An abort, reverse or pause issued by a
   * service command moves the status under the driver (the loop's `run` is only a snapshot), and an unguarded write
   * here would silently undo it. `false` means one of those won: the caller stops, and the loop re-reads the run.
   */
  private async setStatus(run: RunRow, status: RunStatus, extra: Parameters<RunStore["updateRun"]>[2]): Promise<boolean> {
    const ok = await this.store.updateRun(run.id, { bootId: this.bootId, statusIn: DRIVING_STATUSES }, { status, ...extra });
    if (ok) run.status = status;
    return ok;
  }

  private async owned(runId: string, patch: Parameters<RunStore["updateRun"]>[2]): Promise<void> {
    await this.store.updateRun(runId, { bootId: this.bootId }, patch);
  }

  private async emit(runId: string, e: RunEventInput): Promise<void> {
    await this.store.appendEvent(runId, { stepKey: e.stepKey ?? null, level: e.level, code: e.code, params: e.params ?? null, actorId: e.actorId ?? null }, this.bootId);
  }

  /** The run as handlers see it. */
  snapshot(r: RunRow): RunSnapshot {
    return {
      id: r.id,
      teamId: r.teamId,
      actorId: r.actorId,
      targetServerId: r.targetServerId,
      sourceKind: r.sourceKind as "coolify" | "dokploy",
      sourceHost: r.sourceHost,
      sessionId: r.sessionId,
      opId: r.opId,
      opHistory: [...r.opHistory],
      planHash: r.planHash,
      mode: r.mode as RunMode,
      topology: r.topology as RunTopology,
      dryRun: r.dryRun,
      promotedFromId: r.promotedFromId,
      applyInput: RunApplyInputSchema.parse(r.applyInput),
      options: RunOptionsSchema.parse(r.options),
      inputs: OwnerInputsSchema.parse(r.inputs ?? {}),
      status: r.status as RunStatus,
      currentStep: (r.currentStep as StepKey | null) ?? null,
      ponrAt: r.ponrAt,
      windowEstimate: r.windowEstimate ? WindowEstimateSchema.parse(r.windowEstimate) : null,
      freezeStartedAt: r.freezeStartedAt,
      freezeEndedAt: r.freezeEndedAt,
      createdAt: r.createdAt,
    };
  }

  stepSnapshot(s: StepRow): StepSnapshot {
    const wait = s.wait ? (stripSince(s.wait as object) as WaitSpec) : null;
    return {
      key: s.key as StepKey,
      status: s.status as StepStatus,
      attempt: s.attempt,
      gate: (s.gate as GateResult | null) ?? null,
      approval: (s.approval as StepApprovalRecord | null) ?? null,
      inputHash: s.inputHash,
      progress: (s.progress as StepSnapshot["progress"]) ?? null,
      compensation: (s.compensation as Record<string, unknown> | null) ?? null,
      evidence: (s.evidence as StepEvidence | null) ?? EMPTY_STEP_EVIDENCE,
      wait,
      notBefore: s.notBefore,
    };
  }

  /** The {@link StepContext} of one tick. `readOnly` contexts (binding lookups) refuse every write. */
  makeCtx(run: RunRow, row: StepRow, rows: readonly StepRow[], trigger: DriveTrigger, signal: AbortSignal, approval: StepApprovalRecord | null, readOnly: boolean): StepContext {
    const snap = this.snapshot(run);
    const key = row.key as StepKey;
    const stepSnaps = new Map<StepKey, StepSnapshot>(rows.map((r) => [r.key as StepKey, this.stepSnapshot(r)]));
    const bootId = this.bootId;
    const store = this.store;
    const clock = this.clock;
    let compensation: Record<string, unknown> = { ...((row.compensation as Record<string, unknown> | null) ?? {}) };
    const deny = (): never => {
      throw new Error("this context is read-only");
    };
    const requireRun = async (): Promise<RunRow> => {
      const r = await store.get(run.id);
      if (!r || r.ownerId !== bootId) throw new RunLeaseLostError(run.id);
      return r;
    };
    const self = this;
    const ctx: StepContext = {
      run: snap,
      get step(): StepSnapshot {
        const s = stepSnaps.get(key)!;
        return { ...s, compensation: Object.keys(compensation).length ? compensation : s.compensation };
      },
      actor: { userId: run.actorId },
      bootId,
      trigger,
      dryRun: run.dryRun,
      approval,
      signal,
      now: () => clock.now(),
      stepState: (k) => {
        const s = stepSnaps.get(k);
        if (!s) throw new Error(`no step ${k}`);
        return s;
      },
      assertLease: async () => {
        await requireRun();
      },
      emit: async (event) => {
        if (readOnly) return deny();
        if (!isRunCode(event.code)) throw new Error(`invalid event code: ${event.code}`);
        if (event.params && !CodeParamsSchema.safeParse(event.params).success) throw new Error("invalid event params");
        await self.emit(run.id, { ...event, stepKey: event.stepKey === undefined ? key : event.stepKey });
      },
      setProgress: async (progress) => {
        if (readOnly) return deny();
        await store.updateStep(run.id, key, { progress }, bootId);
      },
      recordCompensation: async (patch) => {
        if (readOnly) return deny();
        compensation = { ...compensation, ...patch };
        await store.updateStep(run.id, key, { compensation }, bootId);
      },
      patchRun: async (p: ContractRunPatch) => {
        if (readOnly) return deny();
        const r = await requireRun();
        const patch: Parameters<RunStore["updateRun"]>[2] = {};
        if (p.opId !== undefined && p.opId !== r.opId) {
          patch.opId = p.opId;
          if (r.opId && !r.opHistory.includes(r.opId)) patch.opHistory = [...r.opHistory, r.opId];
        }
        if (p.windowEstimate !== undefined) patch.windowEstimate = p.windowEstimate;
        if (p.freezeStartedAt !== undefined && r.freezeStartedAt === null) patch.freezeStartedAt = p.freezeStartedAt;
        if (p.freezeEndedAt !== undefined && r.freezeEndedAt === null) patch.freezeEndedAt = p.freezeEndedAt;
        if (Object.keys(patch).length) await store.updateRun(run.id, { bootId }, patch);
      },
      markPonr: async () => {
        if (readOnly) return deny();
        if (!STEP_MANIFEST[key].ponr) throw new Error(`markPonr is only legal inside the point-of-no-return step, not ${key}`);
        if (run.dryRun) throw new Error("markPonr is never legal in a dry-run");
        const r = await requireRun();
        if (r.ponrAt) return r.ponrAt;
        const at = await store.setPonr(run.id, bootId, clock.now(), run.actorId);
        if (at === "abort") throw new RunAbortRequestedError(run.id);
        await self.emit(run.id, { level: "warn", code: "run.ponr.reached", stepKey: key });
        await self.sink.notify(run.teamId, { runId: run.id, kind: "ponr-reached", mode: run.mode as RunMode, stepKey: key, code: "run.ponr.reached" }).catch(() => undefined);
        await self.sink.audit({ actor: run.actorId, action: "migration.run.ponr", target: run.id, meta: { step: key } }).catch(() => undefined);
        return at;
      },
    };
    return ctx;
  }
}
