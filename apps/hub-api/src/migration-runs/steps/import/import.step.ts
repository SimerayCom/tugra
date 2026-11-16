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
 *
 * Grup-7 safety rules, applied once the op's tasks settled and before anything is deployed:
 *  - push-to-deploy is switched OFF on every imported app that had it on (R17/R64): while the source is authoritative a push
 *    would otherwise deploy on Tugra too. The ids are recorded before the switch; OBSERVE/FINALIZE restore them after the
 *    point of no return (`baseline/post-ponr.ts`);
 *  - `deployWaves: earlyBuild` builds every app image on its target server, `deployConcurrency` at a time per server, with
 *    nothing started (R27/C5): the freeze window then holds only starts;
 *  - `earlyStateless` never starts a held worker (R26/C13).
 */
import { HttpException, Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  RunLeaseLostError,
  StepFailure,
  deployConcurrencyOf,
  makeGate,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { CLEANUP_REQUEST_KEY, RunAbortRequestedError, type CleanupRequest } from "../../core/run-engine.service";
import { SESSION_EXPIRED_CODE } from "../../core/run-logic";
import { IMPORT_STEPS_PORT, type DeploymentRef, type ImportStepsPort, type OpSnapshot, type SessionState } from "./import-ports";
import { applyInputOf, deployKeyBase, failureOf, hasActive, hasBad, includedItems, isConflict, itemTasks, stopRunApps, unackedBlockers } from "./step-utils";
import { appTasksOf, targetOfTask, workerSetsOfOp } from "./baseline/op-safety";
import { RUN_HINTS, type RunHint, type RunHintStore } from "./baseline/run-hints";

/** How long a redo waits for orphaned RUNNING tasks to settle before it gives up (the importer's reaper frees them after 10 min). */
const REDO_PATIENCE_MS = 15 * 60_000;
const MAX_REDOS = 2;

export interface ImportObs extends Observation {
  session: SessionState;
  op: OpSnapshot | null;
  /** earlyStateless: stateless apps still to deploy / already deployed / failed. */
  wave: { candidates: Array<{ appId: string; name: string }>; deployed: number; failed: number; active: number } | null;
  /** earlyBuild: the apps whose image is still to be built, per target server. `null` = not an earlyBuild run (or the port cannot build). */
  build: { total: number; pending: Array<{ appId: string; name: string; server: string }> } | null;
  /** Apps of the settled op whose push-to-deploy is still ON (to be switched off). `null` = not observed (op running, or the port cannot say). */
  autoDeployOn: string[] | null;
}

interface Comp {
  applyStartedAt?: string | null;
  applyDone?: boolean;
  adopted?: boolean;
  redos?: number;
  redoOpen?: boolean;
  redoAt?: string;
  /** earlyStateless: the apps the early wave may have deployed (written before the first deploy). */
  earlyAppIds?: string[];
  /** The apps this run switched push-to-deploy off for (written BEFORE the switch; the release restores them after the PONR). */
  autoDeployHeld?: string[];
  /** earlyBuild: the apps whose image build finished (or that have nothing to build). */
  prebuilt?: string[];
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
    @Optional() @Inject(RUN_HINTS) private readonly hintStore?: RunHintStore,
  ) {}

  private hints(run: { id: string; promotedFromId: string | null }): Promise<RunHint[]> {
    return this.hintStore ? this.hintStore.list(run.id, run.promotedFromId).catch(() => []) : Promise.resolve([]);
  }

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
    const live = !!op && !op.rolledBack;
    const hints = live ? await this.hints(run) : [];
    const wave = live && run.options.deployWaves === "earlyStateless" ? await this.waveState(ctx, op!, hints) : null;
    const settledOp = live && !hasActive(op!) && !hasBad(op!);
    const build = settledOp && run.options.deployWaves === "earlyBuild" && this.port.prebuild ? this.buildState(ctx, op!) : null;
    const autoDeployOn = settledOp ? await this.autoDeployOn(ctx, op!) : null;
    const tasks = op ? itemTasks(op) : [];
    const settled = tasks.filter((t) => !["PENDING", "RUNNING", "AWAITING_CUTOVER"].includes(t.status)).length;
    return { session, op, wave, build, autoDeployOn, progress: { done: settled, total: tasks.length, unit: "item" } };
  }

  /** The op's apps whose push-to-deploy is still on. Null when the port cannot read it (nothing to enforce then). */
  private async autoDeployOn(ctx: StepContext, op: OpSnapshot): Promise<string[] | null> {
    if (!this.port.autoDeployState || !this.port.setAutoDeploy) return null;
    const on: string[] = [];
    for (const t of appTasksOf(op)) if ((await this.port.autoDeployState(ctx.actor.userId, t.resourceId!)) === true) on.push(t.resourceId!);
    return on;
  }

  /** earlyBuild: every app of the op whose image build is not recorded yet, with the target server each builds on. */
  private buildState(ctx: StepContext, op: OpSnapshot): NonNullable<ImportObs["build"]> {
    const done = new Set(compOf(ctx).prebuilt ?? []);
    const apps = appTasksOf(op);
    return {
      total: apps.length,
      pending: apps.filter((t) => !done.has(t.resourceId!)).map((t) => ({ appId: t.resourceId!, name: t.name ?? t.itemRef ?? "", server: targetOfTask(ctx.targetFor, t) })),
    };
  }

  private async waveState(ctx: StepContext, op: OpSnapshot, hints: readonly RunHint[]): Promise<NonNullable<ImportObs["wave"]>> {
    const userId = ctx.actor.userId;
    const sets = workerSetsOfOp(ctx.run, op, hints); // a worker never starts before the cutover, whatever it depends on
    const stateless = new Set(op.planItems.filter((p) => p.kind === "app" && p.dependsOn.length === 0 && !sets.held.has(p.itemRef) && !sets.excluded.has(p.itemRef)).map((p) => p.itemRef));
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
    if (obs.autoDeployOn) {
      const n = obs.autoDeployOn.length;
      checks.push({ id: "import.auto-deploy", status: n ? "fail" : "pass", code: n ? "import.auto-deploy-pending" : "import.auto-deploy-held", params: { count: n }, evidence: "hub-verified" });
    }
    if (obs.build) {
      const left = obs.build.pending.length;
      checks.push({ id: "import.early-build", status: left ? "fail" : "pass", code: left ? "import.early-build-pending" : "import.early-build-done", params: { built: obs.build.total - left, total: obs.build.total }, evidence: "hub-verified" });
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
    if (await this.adoptOrphan(ctx)) return { outcome: "continue", pollAfterMs: 1000 };

    const op = obs.op;
    if (op && !op.rolledBack) {
      const active = hasActive(op);
      const orphan = active && (ctx.trigger === "recover" || comp.adopted === true);
      const failed = !active && hasBad(op);
      if (comp.redoOpen === true || orphan || (failed && ctx.trigger === "retry")) return this.redo(ctx, obs, op);
      if (active) return { outcome: "continue", pollAfterMs: 2000 };
      if (failed) return { outcome: "fail", code: "import.tasks-failed", params: { failed: itemTasks(op).filter((t) => ["FAILED", "FAILED_VERIFY", "CANCELLED"].includes(t.status)).length }, retryable: true };
      if (obs.autoDeployOn?.length) return this.holdAutoDeploy(ctx, obs.autoDeployOn);
      const built = await this.earlyBuild(ctx, obs);
      if (built) return built;
      return this.earlyWave(ctx, obs);
    }
    return this.applyNow(ctx);
  }

  /**
   * R17/R64: switch push-to-deploy off for the apps that have it on. The ids are recorded BEFORE the first switch (a crash right
   * after one still tells the release what to restore); an app that was already off is never touched, so it is never switched on.
   */
  private async holdAutoDeploy(ctx: StepContext, on: readonly string[]): Promise<ActResult> {
    const userId = ctx.actor.userId;
    const held = [...new Set([...(compOf(ctx).autoDeployHeld ?? []), ...on])];
    await ctx.recordCompensation({ autoDeployHeld: held });
    for (const id of on) {
      await ctx.assertLease();
      try {
        await this.port.setAutoDeploy!(userId, id, false);
      } catch (e) {
        throw failureOf(e, "import.auto-deploy");
      }
    }
    await ctx.emit({ level: "info", code: "import.auto-deploy-held", params: { count: on.length } });
    return { outcome: "continue", pollAfterMs: 1000 };
  }

  /**
   * R27/C5 (`deployWaves: earlyBuild`): build every image now, nothing started. One chunk per act: up to `deployConcurrency`
   * builds per target server, the servers in parallel (a build blocks until it ends, so a tick is one build long). Returns null
   * when there is nothing (left) to build.
   */
  private async earlyBuild(ctx: StepContext, obs: ImportObs): Promise<ActResult | null> {
    const b = obs.build;
    if (!b || !b.pending.length || !this.port.prebuild) return null;
    const userId = ctx.actor.userId;
    const slots = deployConcurrencyOf(ctx.run.options);
    const taken = new Map<string, number>();
    const chunk = b.pending.filter((a) => {
      const n = taken.get(a.server) ?? 0;
      taken.set(a.server, n + 1);
      return n < slots;
    });
    const done = [...(compOf(ctx).prebuilt ?? [])];
    const results = await Promise.allSettled(
      chunk.map(async (a) => {
        if (ctx.signal.aborted) return null;
        await ctx.assertLease();
        await this.port.prebuild!(userId, a.appId);
        return a.appId;
      }),
    );
    for (const r of results) if (r.status === "fulfilled" && r.value) done.push(r.value);
    await ctx.recordCompensation({ prebuilt: done });
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "rejected") continue;
      if (r.reason instanceof RunLeaseLostError || r.reason instanceof RunAbortRequestedError) throw r.reason; // control flow, never a failure code
      throw new StepFailure("import.early-build-failed", { name: chunk[i].name }, true);
    }
    return { outcome: "continue", pollAfterMs: 1000 };
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
      // an HTTP answer is a definitive refusal that created no op: forget the marker so a retry never goes looking for one
      // (and never adopts somebody else's import). Any other error may have left an op behind: keep the marker.
      if (e instanceof HttpException) await ctx.recordCompensation({ applyStartedAt: null });
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

  /** When `apply` was started and never recorded, find the op it created (`opsSince`), point the run at it and return its id. */
  private async adoptOrphan(ctx: StepContext): Promise<string | null> {
    const comp = compOf(ctx);
    const run = ctx.run;
    if (!comp.applyStartedAt || comp.applyDone === true) return null;
    const known = new Set<string>([...run.opHistory, ...(run.opId ? [run.opId] : [])]);
    const found = (await this.port.opsSince(ctx.actor.userId, run.targetServerId, new Date(comp.applyStartedAt))).filter((id) => !known.has(id));
    if (!found.length) return null;
    const opId = found[found.length - 1];
    await ctx.patchRun({ opId });
    await ctx.recordCompensation({ applyDone: true, adopted: true });
    await ctx.emit({ level: "warn", code: "import.op-adopted" });
    return opId;
  }

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    const userId = ctx.actor.userId;
    const run = ctx.run;
    if (how === "reverse") return { outcome: "nothing-to-do" };

    // A crash between `apply` and recording the op id left an op the run does not point at: adopt it first, so abort
    // cancels it and cleanup can roll it back (otherwise its PENDING tasks keep the target server blocked forever).
    let opId = run.opId;
    try {
      opId = (await this.adoptOrphan(ctx)) ?? opId;
    } catch (e) {
      return { outcome: "failed", code: failureOf(e, "import.abort").code };
    }
    if (!opId) return { outcome: "nothing-to-do" };

    if (how === "abort") {
      // earlyStateless deployed these apps during IMPORT: they would keep running on Tugra after the abort otherwise
      let early = { stopped: 0, failed: 0, active: 0 };
      try {
        early = await stopRunApps(this.port, userId, run.id, compOf(ctx).earlyAppIds ?? []);
      } catch (e) {
        return { outcome: "failed", code: failureOf(e, "import.abort").code };
      }
      const snap = await this.port.opSnapshot(userId, opId).catch(() => null);
      let cancelled = false;
      if (snap && !snap.rolledBack) {
        try {
          await this.port.cancelOp(userId, opId); // cancels PENDING tasks, revokes the migration token, drops staged artifacts
          cancelled = true;
        } catch (e) {
          return { outcome: "failed", code: failureOf(e, "import.abort").code };
        }
      }
      if (early.active > 0) return { outcome: "failed", code: "import.early-deploy-active", params: { count: early.active } };
      if (early.failed > 0) return { outcome: "failed", code: "import.early-stop-failed", params: { count: early.failed } };
      return { outcome: cancelled || early.stopped > 0 ? "done" : "nothing-to-do" };
    }

    // cleanup: the importer's rollback with the run's own deployments (and, typed, the data-bearing resources)
    const req = compOf(ctx)[CLEANUP_REQUEST_KEY] ?? { includeData: false, dataConfirmNames: [] };
    try {
      await this.port.rollbackOp(userId, opId, {
        runOwnedDeployments: { runId: run.id },
        includeData: req.includeData,
        dataConfirmNames: req.dataConfirmNames,
      });
    } catch (e) {
      if (isConflict(e)) return { outcome: "failed", code: "import.cleanup-op-running" };
      return { outcome: "failed", code: failureOf(e, "import.cleanup").code };
    }
    const after = await this.port.opSnapshot(userId, opId).catch(() => null);
    const kept = after ? itemTasks(after).filter((t) => t.status === "DONE" && !!t.resourceId && (t.resourceType === "application" || t.resourceType === "database")) : [];
    if (kept.length) {
      return { outcome: "manual", manual: kept.slice(0, 50).map((t) => ({ code: "import.cleanup-kept", params: { name: t.name ?? t.itemRef ?? "", kind: t.resourceType ?? "" } })) };
    }
    return { outcome: "done" };
  }
}
