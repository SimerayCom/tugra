import { Inject, Injectable } from "@nestjs/common";
import { CutoverService } from "../../../cutover/cutover.service";
import type { ApprovalBinding, DryRunItem, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  makeGate,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunSnapshot,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { CutoverStepBase } from "./cutover-step-base";
import { CutoverWorld, type SwapRow } from "./cutover-world.service";
import { chk, earliestVerified, finalizeBindingHash, type Entry } from "./run-cutover-logic";

export interface FinalizeObs extends Observation {
  opId: string | null;
  topology: RunSnapshot["topology"];
  entries: Entry[];
  tokenActive: boolean;
  swap: SwapRow | null;
}

/**
 * FINALIZE: close the migration. Restores each verified host's original TTL (`cutover.finalize`), revokes the op's
 * migration token and stamps the end of the downtime window. With `manualFinalize` it first waits for a typed approval.
 * Benign and irreversible: nothing here can be undone, and nothing here touches traffic.
 */
@Injectable()
export class FinalizeHandler extends CutoverStepBase implements StepHandler<FinalizeObs> {
  readonly key = "FINALIZE" as const;
  readonly kind = "auto" as const;
  readonly rollback = "IRREVERSIBLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) registry: StepHandlerRegistry,
    private readonly cutover: CutoverService,
    private readonly world: CutoverWorld,
  ) {
    super(registry);
  }

  applicable(): boolean {
    return true;
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    return [
      { code: ctx.run.topology === "two-box" ? "finalize.dry.restore-ttl" : "finalize.dry.no-dns", level: "info" },
      { code: "finalize.dry.revoke-token", level: "info" },
      ...(ctx.run.options.manualFinalize ? [{ code: "finalize.dry.manual-approval", level: "info" as const }] : []),
    ];
  }

  async observe(ctx: StepContext): Promise<FinalizeObs> {
    const run = ctx.run;
    const opId = run.opId;
    const base: FinalizeObs = { opId, topology: run.topology, entries: [], tokenActive: false, swap: null };
    if (!opId) return base;
    const [view, tokenActive] = await Promise.all([this.cutover.view(ctx.actor.userId, opId), this.world.migrationTokenActive(opId)]);
    return { ...base, entries: view.entries, tokenActive, swap: run.topology === "swap-proxy" ? await this.world.getSwap(run.id, run.targetServerId) : null };
  }

  async approvalBinding(ctx: StepContext, obs: FinalizeObs): Promise<ApprovalBinding | null> {
    if (!ctx.run.options.manualFinalize) return null;
    const verified = obs.entries.filter((e) => e.state === "VERIFIED").map((e) => e.hostname);
    return {
      inputHash: finalizeBindingHash({ runId: ctx.run.id, opId: obs.opId, verifiedHosts: verified }),
      ponr: false,
      confirm: "run-id",
      ttlSec: null,
      requiresDataRisk: false,
      ackable: [],
      requiredAcks: [],
      review: { hosts: verified.length, topology: obs.topology, tokenActive: obs.tokenActive },
    };
  }

  preGate(ctx: StepContext): GateResult {
    const o = ctx.stepState("OBSERVE").status;
    const c = ctx.stepState("CUTOVER").status;
    return makeGate([
      chk("finalize.cutover-passed", c === "PASSED" || c === "SKIPPED" ? "pass" : "fail", "finalize.cutover-not-passed"),
      chk("finalize.observe-passed", o === "PASSED" || o === "SKIPPED" ? "pass" : "fail", "finalize.observe-not-passed"),
    ]);
  }

  async act(ctx: StepContext, obs: FinalizeObs): Promise<ActResult> {
    const run = ctx.run;
    const opId = obs.opId;
    if (!opId) throw new StepFailure("finalize.import-op");
    // The measured end of the downtime window first (the run column is the engine's, this is the documented way to set it).
    if (!run.freezeEndedAt) {
      const at = run.topology === "swap-proxy" ? (obs.swap?.liveAt ?? null) : earliestVerified(obs.entries);
      if (at) await ctx.patchRun({ freezeEndedAt: at });
    }
    await ctx.assertLease();
    if (run.topology === "two-box") {
      const r = await this.cutover.finalize(ctx.actor.userId, opId, {});
      const restored = r.entries.filter((e) => e.finalizedAt !== null).length;
      await ctx.emit({ stepKey: "FINALIZE", level: "info", code: "finalize.ttl-restored", params: { hosts: restored } });
    }
    const revoked = await this.world.revokeMigrationToken(opId, ctx.actor.userId);
    await ctx.emit({ stepKey: "FINALIZE", level: "info", code: revoked ? "finalize.token-revoked" : "finalize.token-already-revoked" });
    return { outcome: "done" };
  }

  postGate(_ctx: StepContext, obs: FinalizeObs): GateResult {
    if (!obs.opId) return makeGate([chk("finalize.done", "fail", "finalize.import-op")]);
    const pending = obs.entries.filter((e) => e.state === "VERIFIED" && e.finalizedAt === null);
    return makeGate([
      chk("finalize.ttl", obs.topology === "swap-proxy" || pending.length === 0 ? "pass" : "fail", "finalize.ttl-pending", { params: { hosts: pending.length }, evidence: "hub-verified" }),
      chk("finalize.token", obs.tokenActive ? "fail" : "pass", "finalize.token-active", { evidence: "hub-verified" }),
    ]);
  }

  async compensate(_ctx: StepContext, _how: CompensateHow): Promise<CompResult> {
    return { outcome: "nothing-to-do" };
  }
}
