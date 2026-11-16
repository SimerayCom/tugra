/**
 * Step 7, REMAP_ENV (P7 lane A, rollback UNDOABLE): rewrite each migrated app's env so it points at its new Tugra
 * database instead of the old Coolify host, with the importer's preview/apply/undo.
 *
 * Auto-approved when the preview has no manual keys (the apply is bound to the reviewed preview's hash, so nothing can
 * drift between review and write); otherwise ATTENDED: the operator acknowledges that the listed keys must be remapped by
 * hand. The apply records its own undo snapshot before it writes, so abort restores the previous env.
 */
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { ApprovalBinding, DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  makeGate,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { applyAcks, hashOf } from "../../core/run-logic";
import { IMPORT_STEPS_PORT, type ImportStepsPort, type RemapSummary } from "./import-ports";
import { failureOf, isConflict } from "./step-utils";

const MANUAL_ACK = "remap.needs-manual";

export interface RemapObs extends Observation {
  /** The run has no op, or the op provisioned nothing: there is nothing to remap. */
  nothing: boolean;
  /** A remap has been applied (and not undone). */
  pending: boolean;
  plan: RemapSummary | null;
}

interface Comp {
  remapStarted?: boolean;
  remapPartial?: boolean;
  remapPlanHash?: string;
}
const compOf = (ctx: StepContext): Comp => (ctx.step.compensation ?? {}) as Comp;

@Injectable()
export class RemapEnvStep implements StepHandler<RemapObs>, OnModuleInit {
  readonly key = "REMAP_ENV" as const;
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

  async observe(ctx: StepContext): Promise<RemapObs> {
    const opId = ctx.run.opId;
    if (!opId) return { nothing: true, pending: false, plan: null };
    const userId = ctx.actor.userId;
    const pending = await this.port.remapPending(userId, opId);
    if (pending) return { nothing: false, pending: true, plan: null };
    try {
      return { nothing: false, pending: false, plan: await this.port.remapPlan(userId, opId) };
    } catch (e) {
      // "the import provisioned no resources to migrate": nothing to remap
      if (isConflict(e)) return { nothing: true, pending: false, plan: null };
      throw e;
    }
  }

  async dryRun(): Promise<DryRunItem[]> {
    return [{ code: "remap-env.projected-after-import", level: "info" }];
  }

  private needsManual(obs: RemapObs): boolean {
    return !!obs.plan && obs.plan.needsManualKeys > 0;
  }

  /** Ack-aware checks. `soft` demotes an unacked ackable problem to a warning (the approval gate parks it). */
  private checks(ctx: StepContext, obs: RemapObs, soft: boolean): GateCheck[] {
    const ev = { evidence: "hub-verified" as const };
    if (obs.nothing) return [{ id: "remap-env.nothing", status: "pass", code: "remap-env.nothing-to-do", ...ev }];
    if (obs.pending) {
      const partial = compOf(ctx).remapPartial === true;
      return [{ id: "remap-env.applied", status: partial ? "fail" : "pass", code: partial ? "remap-env.partial" : "remap-env.applied", ...ev }];
    }
    const plan = obs.plan!;
    const out: GateCheck[] = [];
    if (plan.appsToWrite === 0) out.push({ id: "remap-env.nothing", status: "pass", code: "remap-env.nothing-to-do", ...ev });
    else out.push({ id: "remap-env.plan", status: "fail", code: "remap-env.pending-apply", params: { apps: plan.appsToWrite }, ...ev });
    if (plan.needsManualKeys > 0) {
      out.push({ id: MANUAL_ACK, status: "fail", code: "remap-env.needs-manual", params: { apps: plan.needsManualApps, keys: plan.needsManualKeys }, ackable: true, ...ev });
    }
    const acked = applyAcks(out, ctx.approval?.acks ?? []);
    return soft ? acked.map((c) => (c.ackable && !c.acked && c.status === "fail" ? { ...c, status: "warn" as const } : c)) : acked;
  }

  async approvalBinding(_ctx: StepContext, obs: RemapObs): Promise<ApprovalBinding | null> {
    void _ctx;
    if (obs.nothing || obs.pending || !this.needsManual(obs)) return null;
    const plan = obs.plan!;
    return {
      inputHash: hashOf({ plan: plan.planHash, keys: plan.needsManualKeys, apps: plan.needsManualApps }),
      ponr: false,
      confirm: "none",
      ttlSec: null,
      requiresDataRisk: false,
      ackable: [MANUAL_ACK],
      requiredAcks: [MANUAL_ACK],
      review: { apps: plan.needsManualApps, keys: plan.needsManualKeys, rewrites: plan.appsToWrite },
    };
  }

  preGate(ctx: StepContext, obs: RemapObs): GateResult {
    return makeGate(this.checks(ctx, obs, true));
  }

  postGate(ctx: StepContext, obs: RemapObs): GateResult {
    // only an applied remap (or nothing left to do, manual keys acknowledged) passes
    return makeGate(this.checks(ctx, obs, false));
  }

  async act(ctx: StepContext, obs: RemapObs): Promise<ActResult> {
    const userId = ctx.actor.userId;
    const opId = ctx.run.opId;
    if (!opId || obs.nothing) return { outcome: "done" };
    const comp = compOf(ctx);
    if (obs.pending) {
      if (comp.remapPartial !== true) return { outcome: "done" };
      // a previous apply wrote only some apps: put everything back, then apply again from a clean state
      if (!(await this.port.remapUndo(userId, opId))) return { outcome: "fail", code: "remap-env.undo-pending", retryable: true };
      await ctx.recordCompensation({ remapPartial: false });
      return { outcome: "continue", pollAfterMs: 1000 };
    }
    const plan = obs.plan!;
    if (plan.appsToWrite === 0) return { outcome: "done" };
    await ctx.recordCompensation({ remapStarted: true, remapPlanHash: plan.planHash }); // BEFORE the first write
    let res;
    try {
      res = await this.port.remapApply(userId, opId, plan.planHash);
    } catch (e) {
      if (isConflict(e)) return { outcome: "fail", code: "remap-env.plan-changed", retryable: true };
      throw failureOf(e, "remap-env.apply");
    }
    if (!res.applied) {
      await ctx.recordCompensation({ remapPartial: true });
      return { outcome: "fail", code: "remap-env.partial", params: { failed: res.failed }, retryable: true };
    }
    if (res.linkFailed > 0) await ctx.emit({ level: "warn", code: "remap-env.link-failed", params: { count: res.linkFailed } });
    return { outcome: "done" };
  }

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort") return { outcome: "nothing-to-do" };
    const opId = ctx.run.opId;
    if (!opId || compOf(ctx).remapStarted !== true) return { outcome: "nothing-to-do" };
    const userId = ctx.actor.userId;
    if (!(await this.port.remapPending(userId, opId))) return { outcome: "nothing-to-do" };
    try {
      return (await this.port.remapUndo(userId, opId)) ? { outcome: "done" } : { outcome: "failed", code: "remap-env.undo-pending" };
    } catch (e) {
      return { outcome: "failed", code: failureOf(e, "remap-env.undo").code };
    }
  }
}
