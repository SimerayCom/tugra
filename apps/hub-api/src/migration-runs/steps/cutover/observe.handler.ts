import { Inject, Injectable } from "@nestjs/common";
import { CutoverService } from "../../../cutover/cutover.service";
import { NetProbe } from "../../../cutover/net-probe";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
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
import { verifySwapHosts, type SwapVerify } from "./swap-runtime";
import { actionableEntries, capHosts, chk, compDate, earliestVerified, iso, type Entry } from "./run-cutover-logic";

/** How often the observe window re-verifies the hosts (and re-arms its timer). */
export const OBSERVE_CHECK_EVERY_MS = 5 * 60 * 1000;

export interface ObserveObs extends Observation {
  opId: string | null;
  topology: RunSnapshot["topology"];
  entries: Entry[];
  /** When the window opened (null = not yet), from the step's own compensation. */
  startedAt: Date | null;
  /** Crash/OOM episodes of the run's containers since the window opened. */
  crashes: number;
  swap: SwapRow | null;
  swapVerify: SwapVerify | null;
}

/** A VERIFIED host that still answers through the target with a valid certificate and a router (`needsDeploy` is the cutover probe's "router gone / unreachable" flag). */
export function hostHealthy(e: Entry): boolean {
  return e.state === "VERIFIED" && !e.needsDeploy && (e.certState === "ready" || e.challenge === "http01") && (e.dnsObserved === "target" || e.dnsObserved === "proxied" || e.dnsMode === "manual");
}

/**
 * OBSERVE: stay on watch after the point of no return for `observeMinutes` (default 30, 0 = skipped). Re-verifies the
 * hosts (cutover check / dark-free swap probe) every few minutes and watches the run's containers for crash and OOM
 * events. A violation fails the step (retryable: a retry opens a fresh window); the engine never reverses on its own.
 */
@Injectable()
export class ObserveHandler extends CutoverStepBase implements StepHandler<ObserveObs> {
  readonly key = "OBSERVE" as const;
  readonly kind = "timer" as const;
  readonly rollback = "LOSSY_AFTER_PONR" as const;

  constructor(
    @Inject(STEP_HANDLERS) registry: StepHandlerRegistry,
    private readonly cutover: CutoverService,
    readonly world: CutoverWorld,
    readonly net: NetProbe,
  ) {
    super(registry);
  }

  applicable(run: RunSnapshot): boolean {
    return run.options.observeMinutes > 0;
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    return [{ code: "observe.dry.window", level: "info", params: { minutes: ctx.run.options.observeMinutes } }];
  }

  async observe(ctx: StepContext): Promise<ObserveObs> {
    const run = ctx.run;
    const opId = run.opId;
    const startedAt = compDate(ctx.step.compensation, "observeStartedAt");
    const base: ObserveObs = { opId, topology: run.topology, entries: [], startedAt, crashes: 0, swap: null, swapVerify: null };
    if (!opId) return base;
    const view = await this.cutover.view(ctx.actor.userId, opId);
    const obs: ObserveObs = { ...base, entries: view.entries };
    if (startedAt) obs.crashes = await this.world.crashEventsSince(run.targetServerId, await this.world.opContainerNames(opId), startedAt);
    if (run.topology === "swap-proxy") {
      obs.swap = await this.world.getSwap(run.id, run.targetServerId);
      const facts = await this.world.serverFacts(run.targetServerId);
      if (startedAt && facts && obs.swap?.state === "LIVE") obs.swapVerify = await verifySwapHosts(this, facts, actionableEntries(view.entries).map((e) => e.hostname), run.options.healthPath ?? "/");
    }
    return obs;
  }

  preGate(ctx: StepContext): GateResult {
    const c = ctx.stepState("CUTOVER").status;
    return makeGate([chk("observe.cutover-passed", c === "PASSED" || c === "SKIPPED" ? "pass" : "fail", "observe.cutover-not-passed")]);
  }

  async act(ctx: StepContext, obs: ObserveObs): Promise<ActResult> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const opId = obs.opId;
    if (!opId) throw new StepFailure("observe.import-op");
    const now = ctx.now();
    const minutes = run.options.observeMinutes;
    let startedAt = obs.startedAt;
    if (!startedAt || ctx.trigger === "retry") {
      // A retry after a violation opens a fresh window.
      startedAt = now;
      await ctx.recordCompensation({ observeStartedAt: iso(now) });
      if (!run.freezeEndedAt) {
        const at = run.topology === "swap-proxy" ? (obs.swap?.liveAt ?? null) : earliestVerified(obs.entries);
        if (at) await ctx.patchRun({ freezeEndedAt: at });
      }
      await ctx.emit({ stepKey: "OBSERVE", level: "info", code: "observe.started", params: { minutes } });
    }
    const windowEnd = new Date(startedAt.getTime() + minutes * 60_000);

    // Re-verify (a fresh read after the check, not the tick-start observation).
    let entries = obs.entries;
    let swapVerify = obs.swapVerify;
    if (run.topology === "two-box") {
      const verified = entries.filter((e) => e.state === "VERIFIED").map((e) => e.hostname);
      if (verified.length) entries = (await this.cutover.check(userId, opId, { hostnames: verified, ...(run.options.healthPath ? { healthPath: run.options.healthPath } : {}) })).entries;
    } else {
      const facts = await this.world.serverFacts(run.targetServerId);
      if (facts) swapVerify = await verifySwapHosts(this, facts, actionableEntries(entries).map((e) => e.hostname), run.options.healthPath ?? "/");
    }
    const crashes = await this.world.crashEventsSince(run.targetServerId, await this.world.opContainerNames(opId), startedAt);
    if (crashes > 0) throw new StepFailure("observe.crash-detected", { events: crashes }, true);
    const bad = run.topology === "two-box" ? entries.filter((e) => e.state !== "BLOCKED" && e.state !== "EXCLUDED" && e.state !== "ROLLED_BACK" && !hostHealthy(e)).map((e) => e.hostname) : Object.entries(swapVerify ?? {}).filter(([, v]) => !v.ok).map(([h]) => h);
    if (bad.length > 0) throw new StepFailure("observe.host-unhealthy", { hosts: capHosts(bad) }, true);

    if (now >= windowEnd) return { outcome: "done" };
    const next = new Date(Math.min(windowEnd.getTime(), now.getTime() + OBSERVE_CHECK_EVERY_MS));
    return { outcome: "wait", wait: { kind: "timer", notBefore: iso(next), code: "observe.window-open", params: { windowEndsAt: iso(windowEnd), minutes } } };
  }

  postGate(ctx: StepContext, obs: ObserveObs): GateResult {
    if (!obs.startedAt) return makeGate([chk("observe.window", "fail", "observe.window-not-started")]);
    const end = obs.startedAt.getTime() + ctx.run.options.observeMinutes * 60_000;
    const checks: GateCheck[] = [chk("observe.window", ctx.now().getTime() >= end ? "pass" : "fail", "observe.window-open", { params: { windowEndsAt: iso(new Date(end)) } })];
    checks.push(chk("observe.crashes", obs.crashes === 0 ? "pass" : "fail", "observe.crash-detected", { params: { events: obs.crashes }, evidence: "hub-verified" }));
    if (obs.topology === "two-box") {
      const bad = obs.entries.filter((e) => e.state !== "BLOCKED" && e.state !== "EXCLUDED" && e.state !== "ROLLED_BACK" && !hostHealthy(e));
      checks.push(chk("observe.hosts", bad.length === 0 ? "pass" : "fail", "observe.host-unhealthy", { params: { hosts: capHosts(bad.map((e) => e.hostname)) }, evidence: "hub-verified" }));
    } else {
      const bad = Object.entries(obs.swapVerify ?? {}).filter(([, v]) => !v.ok);
      const unknown = obs.swap?.state === "LIVE" && obs.swapVerify === null;
      checks.push(chk("observe.hosts", unknown ? "unknown" : bad.length === 0 ? "pass" : "fail", "observe.host-unhealthy", { params: { hosts: capHosts(bad.map(([h]) => h)) }, evidence: "hub-verified" }));
    }
    return makeGate(checks);
  }

  /** Watching changes nothing: the CUTOVER step owns the reverse. */
  async compensate(_ctx: StepContext, _how: CompensateHow): Promise<CompResult> {
    return { outcome: "nothing-to-do" };
  }
}
