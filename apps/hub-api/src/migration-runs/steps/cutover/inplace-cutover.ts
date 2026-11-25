/**
 * CUTOVER of an in-place takeover run (Coolify hub takeover, lane F inside the guided run). The data was never copied and nothing was built,
 * so what is left is taking the ports: the takeover service switches the apps that share data with Coolify's copy, puts Coolify's
 * certificates in place as a short fallback, stops Coolify's proxy and starts Tugra's on :80/:443, checks every domain again, and then
 * works on a NEW Let's Encrypt certificate per domain. This step drives that and keeps the run's swap record (`MigrationRunSwap`) in step
 * with it, so OBSERVE and FINALIZE read the same facts they read for the classic swap.
 *
 * Reversible by design: Coolify's containers, images and volumes are only stopped and started, so "reverse" and "abort" are the same
 * give-back and lose nothing. That is why no point of no return is marked here (it would only add a data-loss acknowledgement to an undo that
 * loses none). Codes + params only.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { GateCheck, GateResult } from "../../core/dto";
import { RunLeaseLostError, StepFailure, makeGate, type ActResult, type CompResult, type CompensateHow, type StepContext } from "../../core/run-contract";
import { INPLACE_RUN_PORT, type InPlaceRunPort, type RunTakeoverState } from "../../../coolify-inplace/inplace-run";
import { approvalValid, chk, iso } from "./run-cutover-logic";
import { CutoverWorld, type SwapRow } from "./cutover-world.service";
import { CUTOVER_FAILURE, INPLACE_CERT_DEADLINE_MS, INPLACE_POLL_MS, INPLACE_VERIFY_DEADLINE_MS, afterSwapFindings, refusalOf } from "../inplace/inplace-run-logic";

/** What this step reads of CUTOVER's observation (the handler's own type extends it). */
export interface InPlaceCutoverObs {
  opId: string | null;
  servers: ReadonlyArray<{ serverId: string; name: string; acmeEmailOk: boolean }>;
  swap: SwapRow | null;
  inPlace?: RunTakeoverState | null;
}

const LIVE_FROM = ["PLANNED", "STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY"] as const;
const UNDO_FROM = ["PLANNED", "STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY", "LIVE", "REVERSING"] as const;
const SWAPPED_STATES: ReadonlySet<string> = new Set(["SWAPPED", "VERIFIED"]);

@Injectable()
export class InPlaceCutover {
  constructor(
    @Inject(INPLACE_RUN_PORT) private readonly port: InPlaceRunPort,
    private readonly world: CutoverWorld,
  ) {}

  async state(ctx: StepContext): Promise<RunTakeoverState | null> {
    try {
      return await this.port.runState(ctx.actor.userId, ctx.run.id);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      if (refusalOf("cutover", e)) return null;
      throw e;
    }
  }

  // ───────────────────────────── gates ─────────────────────────────

  /** Taking the ports needs the owner's VERIFY approval and a takeover that passed its test; a swap that already started resumes without either. */
  preGate(ctx: StepContext, obs: InPlaceCutoverObs): GateResult {
    const st = obs.inPlace ?? null;
    const verify = ctx.stepState("VERIFY");
    const committed = st !== null && st.status !== "PLANNED" && st.status !== "TESTING";
    const checks: GateCheck[] = [chk("cutover.import-op", obs.opId ? "pass" : "fail", "cutover.import-op")];
    if (!committed) {
      checks.push(chk("cutover.verify-passed", verify.status === "PASSED" ? "pass" : "fail", "cutover.verify-not-passed"));
      checks.push(chk("cutover.approval", approvalValid(verify.approval, ctx.now()) ? "pass" : "fail", verify.approval ? "cutover.approval-expired" : "cutover.approval-missing"));
      checks.push(chk("cutover.inplace-tested", st?.status === "TESTING" && st.gate.ok ? "pass" : "fail", "cutover.inplace-not-tested", { evidence: "hub-verified" }));
    }
    // a new certificate needs the server's ACME email: asked for up front, never discovered after Coolify's proxy is stopped
    for (const s of obs.servers.filter((x) => x.serverId === ctx.run.targetServerId)) {
      checks.push(chk("cutover.acme-email", s.acmeEmailOk ? "pass" : "unknown", "cutover.acme-email", { ownerInput: "acmeEmail", evidence: "hub-verified" }));
    }
    return makeGate(checks);
  }

  postGate(obs: InPlaceCutoverObs): GateResult {
    const st = obs.inPlace ?? null;
    if (!st) return makeGate([chk("cutover.swap", "fail", "cutover.swap-not-live")]);
    const checks: GateCheck[] = [chk("cutover.swap", SWAPPED_STATES.has(st.status) ? "pass" : "fail", "cutover.swap-not-live", { evidence: "hub-verified" }), chk("cutover.inplace-verified", st.verified ? "pass" : "fail", "cutover.inplace-not-verified", { evidence: "hub-verified" })];
    for (const i of st.items) {
      if (i.skipped) continue;
      for (const d of i.domains) checks.push(chk("cutover.host", d.finalCheck === "ok" && d.cert === "issued" ? "pass" : "fail", "cutover.host-not-verified", { subject: d.host, params: { check: d.finalCheck, cert: d.cert }, evidence: "hub-verified" }));
    }
    return makeGate(checks);
  }

  // ───────────────────────────── act ─────────────────────────────

  async act(ctx: StepContext, obs: InPlaceCutoverObs): Promise<ActResult> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    let st = obs.inPlace ?? null;
    if (!st) throw new StepFailure("cutover.inplace-not-tested", {}, false);

    if (st.status === "PLANNED" || st.status === "TESTING") {
      if (st.status !== "TESTING" || !st.gate.ok) throw new StepFailure("cutover.inplace-not-tested", {}, false);
      await ctx.recordCompensation({ inPlaceSwapAt: iso(ctx.now()) });
      await ctx.assertLease();
      // the run's swap record first, then the takeover's swap: a crash in between leaves a record the reverse knows about
      let swap = obs.swap ?? (await this.world.createSwap(run.id, run.targetServerId, st.proxy, st.bindBefore));
      if (swap.state === "PLANNED") {
        await this.world.setSwapState(run.id, run.targetServerId, ["PLANNED"], "STOPPING_SOURCE_PROXY");
        swap = { ...swap, state: "STOPPING_SOURCE_PROXY" };
      }
      if (!run.freezeStartedAt) await ctx.patchRun({ freezeStartedAt: ctx.now() });
      await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-planned", params: { image: st.proxy.image, restart: st.proxy.restartPolicy, hosts: st.items.filter((i) => !i.skipped).reduce((n, i) => n + i.domains.length, 0) } });
      try {
        st = await this.port.runSwap(userId, run.id);
      } catch (e) {
        if (e instanceof RunLeaseLostError) throw e;
        const r = refusalOf("cutover", e);
        if (!r) throw e;
        throw new StepFailure(r.code, r.params, r.retryable);
      }
      if (SWAPPED_STATES.has(st.status)) {
        await this.world.setSwapState(run.id, run.targetServerId, LIVE_FROM, "LIVE");
        await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-live" });
      }
    }

    if (st.status === "SWAPPING" || st.status === "GIVING_BACK") throw new StepFailure("cutover.inplace-swap-interrupted", { status: st.status }, false);
    if (st.status === "GIVEN_BACK") throw new StepFailure("cutover.inplace-reversed", {}, false);
    if (st.status === "FAILED") {
      await this.world.setSwapState(run.id, run.targetServerId, UNDO_FROM, "REVERSED").catch(() => undefined);
      throw new StepFailure(st.failureCode ? CUTOVER_FAILURE[st.failureCode] : "cutover.inplace-swap-interrupted", {}, false);
    }

    // SWAPPED or VERIFIED: re-check every domain and work on the new certificates (a few per call)
    if (st.status === "SWAPPED") {
      await ctx.assertLease();
      try {
        st = await this.port.runVerify(userId, run.id);
      } catch (e) {
        if (e instanceof RunLeaseLostError) throw e;
        const r = refusalOf("cutover", e);
        // the sweeper (or another call) is working on it: look again on the next tick
        if (r && r.code === "cutover.inplace-refused" && r.params.reason === "takeover-busy") return { outcome: "continue", pollAfterMs: INPLACE_POLL_MS };
        if (!r) throw e;
        throw new StepFailure(r.code, r.params, r.retryable);
      }
    }
    const found = afterSwapFindings(st);
    if (found.checkFailed.length === 0 && !run.freezeEndedAt) await ctx.patchRun({ freezeEndedAt: ctx.now() });
    if (st.verified) return { outcome: "done" };

    const since = Date.parse(typeof ctx.step.compensation?.inPlaceSwapAt === "string" ? (ctx.step.compensation.inPlaceSwapAt as string) : "") || ctx.now().getTime();
    const age = ctx.now().getTime() - since;
    if (found.checkFailed.length > 0 && age > INPLACE_VERIFY_DEADLINE_MS) throw new StepFailure("cutover.inplace-host-not-verified", { hosts: found.checkFailed.slice(0, 20), minutes: Math.round(INPLACE_VERIFY_DEADLINE_MS / 60_000) }, true);
    if (st.failureCode && st.failureCode !== "fallback_overdue") throw new StepFailure(CUTOVER_FAILURE[st.failureCode], {}, true);
    // attempts used up (or the deadline passed): Coolify's certificate stays on those domains and the owner decides; never a quiet stop
    if ((!st.certWorkLeft && found.noCert.length > 0) || age > INPLACE_CERT_DEADLINE_MS) throw new StepFailure("cutover.inplace-certs-pending", { domains: found.noCert.slice(0, 20) }, true);
    return { outcome: "continue", pollAfterMs: INPLACE_POLL_MS };
  }

  // ───────────────────────────── compensate ─────────────────────────────

  /** Abort and reverse are the same give-back: Tugra's proxy and copies stop, Coolify's containers and proxy start as they were. Idempotent. */
  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how === "cleanup") return { outcome: "nothing-to-do" };
    const run = ctx.run;
    let st: RunTakeoverState | null;
    try {
      await ctx.assertLease();
      st = await this.port.runGiveBack(ctx.actor.userId, run.id);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      return { outcome: "failed", code: "cutover.inplace-give-back-failed" };
    }
    if (!st) return { outcome: "nothing-to-do" };
    if (st.status !== "GIVEN_BACK") return { outcome: "failed", code: "cutover.inplace-give-back-failed", params: { status: st.status } };
    await this.world.setSwapState(run.id, run.targetServerId, UNDO_FROM, "REVERSED").catch(() => undefined);
    await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-reversed" });
    return { outcome: "done" };
  }
}
