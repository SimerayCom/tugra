/**
 * Step 2, IMPORT (P7 lane A, rollback UNDOABLE): create the Tugra apps and databases of the frozen plan with the
 * importer's `apply`, on one import op the run points at (`run.opId`).
 *
 * The importer's fan-out is fire-and-forget and in-process, and every apply makes a NEW op (so a partially failed import
 * cannot resume in place). The step therefore encodes three rules:
 *  - observe-then-act: the op's tasks are the truth; `apply` is only called when the run has no live op;
 *  - retry = rollback + re-apply on a fresh op (at most 2 redos), and a hub restart that left PENDING/RUNNING tasks without
 *    a driver (`trigger === "recover"`) is treated the same way: cancel, wait for the stale RUNNING tasks to settle,
 *    rollback, re-apply;
 *  - a crash between the apply and the moment the op id was recorded is healed by `opsSince`: the orphan op is adopted
 *    (and, because its fan-out died with the process, redone).
 * Abort cancels the op (and revokes its migration token); the optional cleanup is the importer's rollback, widened by
 * `RollbackOptions` for the run's own deployments and (with typed names) data-bearing resources.
 */
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  makeGate,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { CLEANUP_REQUEST_KEY, type CleanupRequest } from "../../core/run-engine.service";
import { SESSION_EXPIRED_CODE } from "../../core/run-logic";
import { IMPORT_STEPS_PORT, type DeploymentRef, type ImportStepsPort, type OpSnapshot, type SessionState } from "./import-ports";
import { applyInputOf, deployKeyBase, failureOf, hasActive, hasBad, includedItems, isConflict, itemTasks, unackedBlockers } from "./step-utils";

/** How long a redo waits for orphaned RUNNING tasks to settle before it gives up (the importer's reaper frees them after 10 min). */
const REDO_PATIENCE_MS = 15 * 60_000;
const MAX_REDOS = 2;

export interface ImportObs extends Observation {
  session: SessionState;
  op: OpSnapshot | null;
  /** earlyStateless: stateless apps still to deploy / already deployed / failed. */
  wave: { candidates: Array<{ appId: string; name: string }>; deployed: number; failed: number; active: number } | null;
}

interface Comp {
  applyStartedAt?: string | null;
  applyDone?: boolean;
  adopted?: boolean;
  redos?: number;
  redoOpen?: boolean;
  redoAt?: string;
  [CLEANUP_REQUEST_KEY]?: CleanupRequest;
}

const compOf = (ctx: StepContext): Comp => (ctx.step.compensation ?? {}) as Comp;

/** True while the run has no usable op: the next thing to do is `apply`. */
const needsApply = (obs: ImportObs): boolean => !obs.op || obs.op.rolledBack;

@Injectable()
export class ImportStep implements StepHandler<ImportObs>, OnModuleInit {
  readonly key = "IMPORT" as const;
  readonly kind = "auto" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(IMPORT_STEPS_PORT) private readonly port: ImportStepsPort,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applicable(): boolean {
    return true;
  }

  // ───────────────────────────── observe / gates ─────────────────────────────

  async observe(ctx: StepContext): Promise<ImportObs> {
    const userId = ctx.actor.userId;
    const run = ctx.run;
    const session = await this.port.sessionState(userId, run.sessionId);
    const op = run.opId ? await this.port.opSnapshot(userId, run.opId) : null;
    const wave = op && !op.rolledBack && run.options.deployWaves === "earlyStateless" ? await this.waveState(ctx, op) : null;
    const tasks = op ? itemTasks(op) : [];
    const settled = tasks.filter((t) => !["PENDING", "RUNNING", "AWAITING_CUTOVER"].includes(t.status)).length;
    return { session, op, wave, progress: { done: settled, total: tasks.length, unit: "item" } };
  }

  private async waveState(ctx: StepContext, op: OpSnapshot): Promise<NonNullable<ImportObs["wave"]>> {
    const userId = ctx.actor.userId;
    const stateless = new Set(op.planItems.filter((p) => p.kind === "app" && p.dependsOn.length === 0).map((p) => p.itemRef));
    const candidates = op.tasks.filter((t) => t.kind === "app" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId && !!t.itemRef && stateless.has(t.itemRef));
    let deployed = 0;
    let failed = 0;
    let active = 0;
    for (const t of candidates) {
      const deps = await this.port.deployments(t.resourceId!, deployKeyBase(ctx.run.id, t.resourceId!));
      const last = deps[deps.length - 1];
      if (last?.status === "SUCCESS") deployed++;
      else if (last?.status === "FAILED" || last?.status === "CANCELLED") failed++;
      else if (last) active++;
    }
    void userId;
    return { candidates: candidates.map((t) => ({ appId: t.resourceId!, name: t.name ?? t.itemRef ?? "" })), deployed, failed, active };
  }

  preGate(ctx: StepContext, obs: ImportObs): GateResult {
    const comp = compOf(ctx);
    const willApply = needsApply(obs) && !(comp.applyStartedAt && comp.applyDone !== true);
    if (willApply && obs.session !== "active") {
      return makeGate([{ id: "import.session", status: "fail", code: "import.session-expired", evidence: "hub-verified" }], { wait: { kind: "operator", code: SESSION_EXPIRED_CODE } });
    }
    return makeGate([{ id: "import.ready", status: "pass", code: "import.ready", evidence: "hub-verified" }]);
  }

  postGate(ctx: StepContext, obs: ImportObs): GateResult {
    const op = obs.op;
    const checks: GateCheck[] = [];
    if (!op || op.rolledBack) return makeGate([{ id: "import.op", status: "fail", code: "import.no-op" }]);
    const tasks = itemTasks(op);
    const done = tasks.filter((t) => t.status === "DONE").length;
    const skipped = tasks.filter((t) => t.status === "SKIPPED").length;
    const bad = tasks.filter((t) => ["FAILED", "FAILED_VERIFY", "CANCELLED"].includes(t.status));
    const active = hasActive(op);
    checks.push({
      id: "import.tasks",
      status: active ? "fail" : bad.length ? "fail" : "pass",
      code: active ? "import.tasks-running" : bad.length ? "import.tasks-failed" : "import.tasks-done",
      params: { done, skipped, failed: bad.length, total: tasks.length },
      evidence: "hub-verified",
    });
    const needsSource = tasks.filter((t) => t.gitStatus === "needs_source").map((t) => t.name ?? t.itemRef ?? "");
    if (needsSource.length) checks.push({ id: "import.git-needs-source", status: "warn", code: "import.git-needs-source", params: { count: needsSource.length, items: needsSource.slice(0, 10) }, evidence: "hub-verified" });
    if (obs.wave) {
      const w = obs.wave;
      const ok = w.deployed === w.candidates.length;
      checks.push({ id: "import.early-wave", status: ok ? "pass" : "fail", code: ok ? "import.early-wave-done" : "import.early-wave-pending", params: { deployed: w.deployed, total: w.candidates.length }, evidence: "hub-verified" });
    }
    void ctx;
    return makeGate(checks);
  }

  // ───────────────────────────── act ─────────────────────────────

  async act(ctx: StepContext, obs: ImportObs): Promise<ActResult> {
    const comp = compOf(ctx);
    const userId = ctx.actor.userId;
    const run = ctx.run;

    // A crash between `apply` and recording the op id: adopt the orphan op the apply created.
    if (comp.applyStartedAt && comp.applyDone !== true) {
      const known = new Set<string>([...run.opHistory, ...(run.opId ? [run.opId] : [])]);
      const found = (await this.port.opsSince(userId, run.targetServerId, new Date(comp.applyStartedAt))).filter((id) => !known.has(id));
      if (found.length) {
        await ctx.patchRun({ opId: found[found.length - 1] });
        await ctx.recordCompensation({ applyDone: true, adopted: true });
        await ctx.emit({ level: "warn", code: "import.op-adopted" });
        return { outcome: "continue", pollAfterMs: 1000 };
      }
    }

    const op = obs.op;
    if (op && !op.rolledBack) {
      const active = hasActive(op);
      const orphan = active && (ctx.trigger === "recover" || comp.adopted === true);
      const failed = !active && hasBad(op);
      if (comp.redoOpen === true || orphan || (failed && ctx.trigger === "retry")) return this.redo(ctx, obs, op);
      if (active) return { outcome: "continue", pollAfterMs: 2000 };
      if (failed) return { outcome: "fail", code: "import.tasks-failed", params: { failed: itemTasks(op).filter((t) => ["FAILED", "FAILED_VERIFY", "CANCELLED"].includes(t.status)).length }, retryable: true };
      return this.earlyWave(ctx, obs);
    }
    return this.applyNow(ctx);
  }

  private async applyNow(ctx: StepContext): Promise<ActResult> {
    const run = ctx.run;
    if (!run.sessionId) return { outcome: "fail", code: "import.session-expired", retryable: true };
    await ctx.assertLease();
    await ctx.recordCompensation({ applyStartedAt: ctx.now().toISOString(), applyDone: false });
    let opId: string;
    try {
      opId = (await this.port.apply(ctx.actor.userId, applyInputOf(run, run.sessionId))).opId;
    } catch (e) {
      const f = failureOf(e, "import.apply");
      // a definitive refusal created no op: forget the marker so a retry does not go looking for one
      if (!f.retryable) await ctx.recordCompensation({ applyStartedAt: null });
      throw f;
    }
    await ctx.patchRun({ opId });
    await ctx.recordCompensation({ applyDone: true, adopted: false, redoOpen: false });
    await ctx.emit({ level: "info", code: "import.applied" });
    return { outcome: "continue", pollAfterMs: 1000 };
  }

  /** Cancel -> wait for the fan-out to stop -> rollback -> (the next act applies a fresh op). */
  private async redo(ctx: StepContext, obs: ImportObs, op: OpSnapshot): Promise<ActResult> {
    const comp = compOf(ctx);
    const userId = ctx.actor.userId;
    let redoAt = comp.redoAt;
    if (comp.redoOpen !== true) {
      const n = comp.redos ?? 0;
      if (n >= MAX_REDOS) return { outcome: "fail", code: "import.retry-exhausted", params: { redos: n }, retryable: false };
      redoAt = ctx.now().toISOString();
      await ctx.recordCompensation({ redos: n + 1, redoOpen: true, redoAt, adopted: false });
      await ctx.emit({ level: "warn", code: "import.redo", params: { attempt: n + 1 } });
    }
    if (hasActive(op)) {
      const since = redoAt ? Date.parse(redoAt) : ctx.now().getTime();
      if (ctx.now().getTime() - since > REDO_PATIENCE_MS) return { outcome: "fail", code: "import.op-stuck", retryable: true };
      await this.port.cancelOp(userId, op.id);
      return { outcome: "continue", pollAfterMs: 15_000 };
    }
    try {
      await this.port.rollbackOp(userId, op.id, {});
    } catch (e) {
      if (isConflict(e)) return { outcome: "continue", pollAfterMs: 15_000 }; // still settling
      throw failureOf(e, "import.rollback");
    }
    const after = await this.port.opSnapshot(userId, op.id);
    const kept = itemTasks(after).filter((t) => t.status === "DONE" && !!t.resourceId);
    if (kept.length) return { outcome: "fail", code: "import.rollback-incomplete", params: { count: kept.length }, retryable: false };
    void obs;
    return { outcome: "continue", pollAfterMs: 1000 };
  }

  /** earlyStateless: deploy the apps that depend on nothing right after the import settled. Idempotent per `migrun:` key. */
  private async earlyWave(ctx: StepContext, obs: ImportObs): Promise<ActResult> {
    const w = obs.wave;
    if (!w || w.deployed === w.candidates.length) return { outcome: "done" };
    const userId = ctx.actor.userId;
    if (w.failed > 0 && ctx.trigger !== "retry") return { outcome: "fail", code: "import.early-deploy-failed", params: { failed: w.failed }, retryable: true };
    await ctx.recordCompensation({ earlyAppIds: w.candidates.map((c) => c.appId) });
    const todo: Array<{ appId: string; key: string }> = [];
    for (const c of w.candidates) {
      const deps = await this.port.deployments(c.appId, deployKeyBase(ctx.run.id, c.appId));
      const last = deps[deps.length - 1];
      if (!last) todo.push({ appId: c.appId, key: deployKeyBase(ctx.run.id, c.appId) });
      else if ((last.status === "FAILED" || last.status === "CANCELLED") && ctx.trigger === "retry") todo.push({ appId: c.appId, key: `${deployKeyBase(ctx.run.id, c.appId)}:${deps.length}` });
    }
    if (!todo.length) return { outcome: "continue", pollAfterMs: 3000 };
    for (const t of todo.slice(0, 3)) {
      await ctx.assertLease();
      let d: DeploymentRef | null;
      try {
        d = await this.port.deploy(userId, t.appId, t.key);
      } catch (e) {
        throw failureOf(e, "import.early-deploy");
      }
      if (d && d.requestedBy !== userId) throw new StepFailure("import.early-deploy-collision", undefined, false);
    }
    return { outcome: "continue", pollAfterMs: 1000 };
  }

  // ───────────────────────────── dry-run ─────────────────────────────

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    const state = await this.port.sessionState(ctx.actor.userId, run.sessionId);
    if (state !== "active" || !run.sessionId) return [{ code: "import.session-expired", level: "block" }];
    let plan;
    try {
      plan = await this.port.plan(ctx.actor.userId, { sessionId: run.sessionId, sourceKind: run.sourceKind, ...(run.applyInput.dbDataModes ? { dbDataModes: run.applyInput.dbDataModes } : {}) });
    } catch (e) {
      return [{ code: failureOf(e, "import.plan").code, level: "block" }];
    }
    const items = includedItems(plan, run);
    const blocked = unackedBlockers(plan, run);
    const out: DryRunItem[] = [
      { code: "import.projection", level: "info", params: { apps: items.filter((i) => i.kind === "app").length, databases: items.filter((i) => i.kind === "database").length, services: items.filter((i) => i.kind === "service").length } },
      { code: plan.planHash === run.planHash ? "import.plan-fresh" : "import.plan-changed", level: plan.planHash === run.planHash ? "info" : "block" },
    ];
    for (const [code, names] of blocked) out.push({ code: "import.item-skipped", level: "warn", params: { risk: code, count: names.length, items: names.slice(0, 10) } });
    return out;
  }

  // ───────────────────────────── compensate ─────────────────────────────

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    const userId = ctx.actor.userId;
    const run = ctx.run;
    if (how === "reverse") return { outcome: "nothing-to-do" };
    if (!run.opId) return { outcome: "nothing-to-do" };

    if (how === "abort") {
      const snap = await this.port.opSnapshot(userId, run.opId).catch(() => null);
      if (!snap || snap.rolledBack) return { outcome: "nothing-to-do" };
      try {
        await this.port.cancelOp(userId, run.opId); // cancels PENDING tasks, revokes the migration token, drops staged artifacts
      } catch (e) {
        return { outcome: "failed", code: failureOf(e, "import.abort").code };
      }
      return { outcome: "done" };
    }

    // cleanup: the importer's rollback with the run's own deployments (and, typed, the data-bearing resources)
    const req = compOf(ctx)[CLEANUP_REQUEST_KEY] ?? { includeData: false, dataConfirmNames: [] };
    try {
      await this.port.rollbackOp(userId, run.opId, {
        runOwnedDeployments: { runId: run.id },
        includeData: req.includeData,
        dataConfirmNames: req.dataConfirmNames,
      });
    } catch (e) {
      if (isConflict(e)) return { outcome: "failed", code: "import.cleanup-op-running" };
      return { outcome: "failed", code: failureOf(e, "import.cleanup").code };
    }
    const after = await this.port.opSnapshot(userId, run.opId).catch(() => null);
    const kept = after ? itemTasks(after).filter((t) => t.status === "DONE" && !!t.resourceId && (t.resourceType === "application" || t.resourceType === "database")) : [];
    if (kept.length) {
      return { outcome: "manual", manual: kept.slice(0, 50).map((t) => ({ code: "import.cleanup-kept", params: { name: t.name ?? t.itemRef ?? "", kind: t.resourceType ?? "" } })) };
    }
    return { outcome: "done" };
  }
}
