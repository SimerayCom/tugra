/**
 * The in-place side of DEPLOY_DARK and VERIFY (Coolify hub takeover, lane F inside the guided run). CUTOVER's in-place side lives with
 * the cutover handlers (`../cutover/inplace-cutover.ts`) because it also keeps the run's swap record.
 *
 * A run marked `inPlace` does not copy data and does not build. DEPLOY_DARK reads what Coolify runs on the box, adopts the images it
 * already built, starts Tugra's proxy with no published port and checks every domain by Host header against what Coolify answers. VERIFY
 * shows that test to the owner as a review and binds the approval to it. The takeover service does the work (as the run's actor, who must
 * be a team owner); these only drive it and judge what it says. Codes + params only.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import { RunLeaseLostError, StepFailure, makeGate, type CompResult, type CompensateHow, type StepContext } from "../../core/run-contract";
import { INPLACE_RUN_PORT, type InPlaceRunPort, type RunTakeoverState } from "../../../coolify-inplace/inplace-run";
import { inPlaceSuite, refusalOf } from "./inplace-run-logic";
import type { SuiteCheck } from "../data/verify/verify-suite";

/** Poll interval while the test is still being prepared. */
export const INPLACE_TEST_POLL_MS = 10_000;

@Injectable()
export class InPlaceRunSteps {
  constructor(@Inject(INPLACE_RUN_PORT) private readonly port: InPlaceRunPort) {}

  /** The takeover that carries the run (null before it was planned, or when this actor cannot see it). Never throws a refusal. */
  async state(ctx: StepContext): Promise<RunTakeoverState | null> {
    try {
      return await this.port.runState(ctx.actor.userId, ctx.run.id);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      if (refusalOf("deploy-dark", e)) return null;
      throw e;
    }
  }

  // ───────────────────────────── DEPLOY_DARK ─────────────────────────────

  dryRun(): DryRunItem[] {
    return [{ code: "deploy-dark.inplace-plan", level: "info" }];
  }

  /** The agent must be there; the owner role and the server's state are the takeover service's own checks, shown as its refusal. */
  preGate(ctx: StepContext, agentOnline: boolean): GateResult {
    const checks: GateCheck[] = [{ id: "deploy-dark.agent", status: agentOnline ? "pass" : "fail", code: agentOnline ? "deploy-dark.agent-online" : "deploy-dark.agent-offline", evidence: "hub-verified" }];
    if (!ctx.run.opId) checks.push({ id: "deploy-dark.import-op", status: "fail", code: "cutover.import-op" });
    return makeGate(checks, { wait: { kind: "operator", code: agentOnline ? "cutover.import-op" : "deploy-dark.agent-offline" } });
  }

  /** The takeover was tested and every check that runs alongside passed: the ports may be taken from here. */
  postGate(state: RunTakeoverState | null): GateResult {
    if (!state) return makeGate([{ id: "deploy-dark.inplace-tested", status: "fail", code: "deploy-dark.inplace-not-tested", evidence: "hub-verified" }]);
    const tested = state.status === "TESTING" && state.gate.ok && state.pending === 0 && state.failureCode === null;
    const checks: GateCheck[] = [{ id: "deploy-dark.inplace-tested", status: tested ? "pass" : "fail", code: tested ? "deploy-dark.inplace-testing" : "deploy-dark.inplace-not-tested", params: { status: state.status }, evidence: "hub-verified" }];
    return makeGate(checks);
  }

  /**
   * Plan and test the takeover (the service does both, and re-testing is safe). A refusal of the service is the step's failure with its own
   * code; a domain that does not answer like Coolify (after the takeover's own waiting for the app and re-testing), or a probe that could not run,
   * is a failure the owner can retry after fixing it. While an app is still starting or a domain is inside its test window the step waits (`continue`).
   */
  async act(ctx: StepContext): Promise<{ outcome: "done" } | { outcome: "continue"; pollAfterMs: number }> {
    const run = ctx.run;
    if (!run.opId) throw new StepFailure("cutover.import-op", {}, false);
    // written before the effect: an abort (or a crash) later knows there is a takeover to give back
    await ctx.recordCompensation({ inPlace: true });
    await ctx.assertLease();
    let state: RunTakeoverState;
    try {
      state = await this.port.runPrepare(ctx.actor.userId, { runId: run.id, serverId: run.targetServerId, opId: run.opId, rebuild: run.options.rebuild ?? [] });
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      const r = refusalOf("deploy-dark", e);
      if (!r) throw e;
      throw new StepFailure(r.code, r.params, r.retryable);
    }
    if (state.failureCode === "probe_unavailable") throw new StepFailure("deploy-dark.inplace-probe-unavailable", {}, true);
    if (state.pending > 0) return { outcome: "continue", pollAfterMs: INPLACE_TEST_POLL_MS };
    const gate = state.gate;
    if (!gate.ok) {
      if (gate.code === "no_items") throw new StepFailure("deploy-dark.inplace-no-apps", {}, false);
      if (gate.code === "test_failed") {
        // the domain that did not pass, with the app's name and why (what each side answered is on the takeover's item: the run page shows it)
        const item = state.items.find((i) => i.itemRef === gate.itemRef);
        const check = item?.domains.find((d) => d.host === gate.host)?.check;
        throw new StepFailure("deploy-dark.inplace-test-failed", { host: gate.host ?? "", app: item?.name ?? "", item: gate.itemRef ?? "", reason: check?.reason ?? "" }, true);
      }
      return { outcome: "continue", pollAfterMs: INPLACE_TEST_POLL_MS };
    }
    return { outcome: "done" };
  }

  /** Undo what the dark test did (Tugra's proxy stops, its copies stop, Coolify serves as before). Nothing of Coolify's was removed, so there is no more to restore. */
  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how === "cleanup") return { outcome: "nothing-to-do" };
    let state: RunTakeoverState | null;
    try {
      state = await this.port.runGiveBack(ctx.actor.userId, ctx.run.id);
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      return { outcome: "failed", code: "deploy-dark.inplace-give-back-failed" };
    }
    if (!state) return { outcome: "nothing-to-do" };
    return state.status === "GIVEN_BACK" ? { outcome: "done" } : { outcome: "failed", code: "deploy-dark.inplace-give-back-failed", params: { status: state.status } };
  }

  // ───────────────────────────── VERIFY ─────────────────────────────

  /** What the owner reviews and the hash their approval is bound to: the checks of the test, and the takeover they belong to. */
  review(state: RunTakeoverState | null): { suite: SuiteCheck[]; hosts: string[]; planHash: string | null } {
    const hosts = state ? state.items.filter((i) => !i.skipped).flatMap((i) => i.domains.map((d) => d.host)) : [];
    return { suite: inPlaceSuite(state), hosts: [...new Set(hosts)].sort(), planHash: state ? `inplace:${state.id}` : null };
  }
}
