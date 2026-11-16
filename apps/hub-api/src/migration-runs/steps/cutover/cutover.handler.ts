import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { CutoverService } from "../../../cutover/cutover.service";
import { NetProbe } from "../../../cutover/net-probe";
import type { CutoverView } from "../../../cutover/cutover.dto";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
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
import { CutoverStepBase, POLL_MS, rethrowLeaseLost } from "./cutover-step-base";
import { CutoverWorld, type ServerFacts, type SwapRow } from "./cutover-world.service";
import { inspectSourceProxy, reverseSwapOnHost, stopSourceProxy, swapHostState, targetPublishesWeb, verifySwapHosts, type SwapVerify } from "./swap-runtime";
import {
  FLIPPED_STATES,
  actionableEntries,
  approvalValid,
  capHosts,
  chk,
  compDate,
  earliestVerified,
  hasAttestation,
  hostIsStateful,
  isFlipped,
  isManualDns,
  iso,
  timerGate,
  trackedEntries,
  ttlWaitUntil,
  type CutoverRunView,
  type Entry,
} from "./run-cutover-logic";

/** After the flip/swap, how long CUTOVER keeps re-verifying hosts (DNS propagation, certificates) before it fails (retryable). */
export const VERIFY_DEADLINE_MS = 30 * 60 * 1000;
/** After the proxy swap, how long the hosts get to answer through Tugra's proxy. */
export const SWAP_VERIFY_DEADLINE_MS = 5 * 60 * 1000;
const FLIP_POLL_MS = 5_000;
const SWAP_POLL_MS = 10_000;
export const MANUAL_DNS_ATTEST = "cutover.manual-dns-switched";

export interface CutoverObs extends Observation {
  opId: string | null;
  topology: RunSnapshot["topology"];
  entries: Entry[];
  servers: CutoverView["servers"];
  flipRun: CutoverRunView | null;
  /** Applications whose data moved to Tugra (they take writes the source never sees once they serve traffic). */
  dataApps: ReadonlySet<string>;
  facts: ServerFacts | null;
  swap: SwapRow | null;
  /** swap only, and only while LIVE: how each host answers through Tugra's proxy on the box. */
  swapVerify: SwapVerify | null;
}

/**
 * CUTOVER, the point of no return (design 5.4/6).
 *
 *  - two-box: the existing paced Cloudflare flip (`cutover.flip`, confirmToken = the plan hash, `stopOnFail`, never
 *    `autoRevert` for a stateful host). A manual-DNS host waits for the operator's own DNS change and is then verified.
 *  - swap-proxy: the same-host proxy swap, no DNS write: record the source proxy's identity + restart policy first, stop
 *    it (restart policy `no`, never `docker rm`), start Tugra's proxy on :80/:443, verify each host from the hub.
 *
 * `ponrAt` is persisted BEFORE the first command that can route a stateful host to Tugra (a flip write, the stop of the
 * source proxy, the operator being told to change DNS). A run with only stateless hosts sets no PONR and can use autoRevert.
 */
@Injectable()
export class CutoverHandler extends CutoverStepBase implements StepHandler<CutoverObs> {
  readonly key = "CUTOVER" as const;
  readonly kind = "auto" as const;
  readonly rollback = "LOSSY_AFTER_PONR" as const;
  private readonly log = new Logger(CutoverHandler.name);

  constructor(
    @Inject(STEP_HANDLERS) registry: StepHandlerRegistry,
    private readonly cutover: CutoverService,
    readonly world: CutoverWorld,
    private readonly proxyOps: ProxyOpsService,
    readonly net: NetProbe,
  ) {
    super(registry);
  }

  applicable(): boolean {
    return true;
  }

  // ───────────────────────────── dry run ─────────────────────────────

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    const items: DryRunItem[] = [{ code: "cutover.dry.mode", level: "info", params: { topology: run.topology } }];
    if (run.opId) {
      const apps = await this.world.opApps(run.opId);
      const data = apps.filter((a) => a.hasData).length;
      items.push({ code: data > 0 ? "cutover.dry.ponr-will-be-set" : "cutover.dry.no-ponr", level: "info", params: { statefulApps: data, apps: apps.length } });
    }
    if (run.topology === "swap-proxy") {
      const ident = await inspectSourceProxy(this.world, run.targetServerId);
      items.push(ident.ok ? { code: "cutover.dry.swap-identity-ok", level: "info", params: { image: ident.snapshot.image, restart: ident.snapshot.restartPolicy } } : { code: `cutover.dry.swap-${ident.code === "unreadable" ? "inspect-failed" : "identity-mismatch"}`, level: ident.code === "unreadable" ? "unknown" : "block", params: { reason: ident.code } });
    } else {
      items.push({ code: "cutover.dry.flip", level: "info", params: { batchSize: run.options.batchSize, intervalSec: run.options.intervalSec } });
    }
    return items;
  }

  // ───────────────────────────── observe ─────────────────────────────

  async observe(ctx: StepContext): Promise<CutoverObs> {
    const run = ctx.run;
    const opId = run.opId;
    const base: CutoverObs = { opId, topology: run.topology, entries: [], servers: [], flipRun: null, dataApps: new Set(), facts: null, swap: null, swapVerify: null };
    if (!opId) return base;
    const [view, apps, facts] = await Promise.all([this.cutover.view(ctx.actor.userId, opId), this.world.opApps(opId), this.world.serverFacts(run.targetServerId)]);
    const obs: CutoverObs = { ...base, entries: view.entries, servers: view.servers, flipRun: view.run, dataApps: new Set(apps.filter((a) => a.hasData).map((a) => a.appId)), facts };
    if (run.topology === "swap-proxy") {
      obs.swap = await this.world.getSwap(run.id, run.targetServerId);
      if (obs.swap?.state === "LIVE" && facts) obs.swapVerify = await verifySwapHosts(this, facts, actionableEntries(view.entries).map((e) => e.hostname), run.options.healthPath ?? "/");
    }
    // The measured end of the downtime window is a fact about the world: the first moment a host answers through Tugra.
    // Stamped where it is observed (the step usually passes on its post gate without another `act`); first write wins.
    if (!run.freezeEndedAt) {
      const at = run.topology === "swap-proxy" ? (obs.swapVerify && Object.values(obs.swapVerify).length > 0 && Object.values(obs.swapVerify).every((v) => v.ok) ? ctx.now() : null) : earliestVerified(view.entries);
      if (at) await ctx.patchRun({ freezeEndedAt: at });
    }
    return obs;
  }

  // ───────────────────────────── gates ─────────────────────────────

  /** The step already committed something (a flip, a swap, the PONR): it must resume, not be re-gated by a clock that ran out. */
  private committed(ctx: StepContext, obs: CutoverObs): boolean {
    return ctx.run.ponrAt !== null || obs.flipRun !== null || obs.entries.some(isFlipped) || (obs.swap !== null && obs.swap.state !== "PLANNED");
  }

  preGate(ctx: StepContext, obs: CutoverObs): GateResult {
    const run = ctx.run;
    const verify = ctx.stepState("VERIFY");
    const committed = this.committed(ctx, obs);
    const checks: GateCheck[] = [chk("cutover.import-op", obs.opId ? "pass" : "fail", "cutover.import-op")];
    if (!committed) {
      checks.push(chk("cutover.verify-passed", verify.status === "PASSED" ? "pass" : "fail", "cutover.verify-not-passed"));
      const valid = approvalValid(verify.approval, ctx.now());
      checks.push(chk("cutover.approval", valid ? "pass" : "fail", verify.approval ? "cutover.approval-expired" : "cutover.approval-missing"));
    }
    const movers = actionableEntries(obs.entries).filter((e) => run.topology === "swap-proxy" || e.state === "READY" || isFlipped(e));
    const stateful = movers.filter((e) => hostIsStateful(e, obs.dataApps));
    if (stateful.length > 0 && !committed) {
      checks.push(chk("cutover.data-risk", verify.approval?.acceptDataRisk === true ? "pass" : "fail", "cutover.data-risk-not-accepted", { params: { hosts: capHosts(stateful.map((e) => e.hostname)) } }));
    }
    const server = obs.servers.find((s) => s.serverId === run.targetServerId);
    if (server) checks.push(chk("cutover.acme-email", server.acmeEmailOk ? "pass" : "unknown", "cutover.acme-email", { ownerInput: "acmeEmail", evidence: "hub-verified" }));
    if (run.topology === "two-box") {
      checks.push(chk("cutover.hosts-ready", obs.entries.some((e) => e.state === "READY" || isFlipped(e)) || actionableEntries(obs.entries).length === 0 ? "pass" : "fail", "cutover.no-ready-hosts"));
      if (!committed && run.options.ttlPolicy !== "skip-ack") {
        const until = ttlWaitUntil(obs.entries);
        const waiting = until !== null && until.getTime() > ctx.now().getTime();
        checks.push(chk("cutover.ttl-wait", waiting ? "fail" : "pass", "cutover.ttl-wait", waiting ? { params: { until: iso(until!) } } : {}));
        return timerGate(checks, ["cutover.ttl-wait"], waiting ? until : null, "cutover.ttl-wait");
      }
    } else if (!committed) {
      checks.push(chk("cutover.swap-server", obs.facts ? "pass" : "fail", "cutover.swap-server-missing"));
    }
    return makeGate(checks);
  }

  // ───────────────────────────── act ─────────────────────────────

  async act(ctx: StepContext, obs: CutoverObs): Promise<ActResult> {
    if (!obs.opId) throw new StepFailure("cutover.import-op");
    const earliest = earliestVerified(obs.entries);
    if (earliest && !ctx.run.freezeEndedAt) await ctx.patchRun({ freezeEndedAt: earliest });
    return ctx.run.topology === "swap-proxy" ? this.actSwap(ctx, obs) : this.actTwoBox(ctx, obs);
  }

  private async actTwoBox(ctx: StepContext, obs: CutoverObs): Promise<ActResult> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const opId = obs.opId!;
    const now = ctx.now();
    const retry = ctx.trigger === "retry";
    const entries = obs.entries;

    const conflicts = entries.filter((e) => e.state === "CONFLICT");
    if (conflicts.length) throw new StepFailure("cutover.host-conflict", { hosts: capHosts(conflicts.map((e) => e.hostname)) }, false);
    if (obs.flipRun?.status === "running") return { outcome: "continue", pollAfterMs: FLIP_POLL_MS };
    const unfinished = entries.some((e) => e.state === "READY" || e.state === "SWITCHED" || e.state === "VERIFY_FAILED");
    if (obs.flipRun && (obs.flipRun.status === "halted" || obs.flipRun.status === "cancelled") && !retry && unfinished) {
      throw new StepFailure("cutover.flip-halted", { status: obs.flipRun.status, ...(obs.flipRun.lastError ? { detail: obs.flipRun.lastError.slice(0, 200) } : {}) }, true);
    }

    const ready = entries.filter((e) => e.state === "READY");
    const flippable = ready.filter((e) => !isManualDns(e));
    if (flippable.length > 0) {
      const plan = await this.cutover.flipPlan(userId, opId, {});
      const live = new Set(plan.entries.map((e) => e.hostname));
      const planned = flippable.filter((e) => live.has(e.hostname));
      if (plan.blocked.length > 0) await ctx.emit({ stepKey: "CUTOVER", level: "warn", code: "cutover.hosts-blocked", params: { hosts: capHosts(plan.blocked.map((b) => b.hostname)) } });
      if (planned.length > 0) {
        const stateful = planned.some((e) => hostIsStateful(e, obs.dataApps));
        // The PONR is durable BEFORE the first provider write that can route a stateful host to Tugra.
        if (stateful) await ctx.markPonr();
        await ctx.assertLease();
        await ctx.recordCompensation({ flipStartedAt: iso(now) });
        try {
          const r = await this.cutover.flip(userId, opId, {
            confirmToken: plan.planHash,
            batchSize: run.options.batchSize,
            intervalSec: run.options.intervalSec,
            stopOnFail: true,
            // Only a run with no stateful host may auto-revert a failed flip (its revert loses no data).
            autoRevert: !stateful,
            acceptDataRisk: ctx.stepState("VERIFY").approval?.acceptDataRisk === true,
            acceptHttp01Gap: run.options.acceptHttp01Gap,
            skipTtlWait: run.options.ttlPolicy === "skip-ack",
          });
          await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.flip-started", params: { hosts: r.queued, stateful } });
        } catch (e) {
          if (e instanceof ConflictException) {
            this.log.warn(`run ${run.id}: flip refused: ${e.message}`);
            throw new StepFailure("cutover.flip-refused", {}, true);
          }
          throw e;
        }
        return { outcome: "continue", pollAfterMs: FLIP_POLL_MS };
      }
    }

    const switched = entries.filter((e) => e.state === "SWITCHED" || e.state === "VERIFY_FAILED");
    if (switched.length > 0) {
      const since = compDate(ctx.step.compensation, "flipStartedAt") ?? now;
      if (now.getTime() - since.getTime() > VERIFY_DEADLINE_MS) throw new StepFailure("cutover.host-not-verified", { hosts: capHosts(switched.map((e) => e.hostname)), minutes: Math.round(VERIFY_DEADLINE_MS / 60_000) }, true);
      await this.cutover.check(userId, opId, { hostnames: switched.map((e) => e.hostname) });
      return { outcome: "continue", pollAfterMs: POLL_MS };
    }

    const manual = ready.filter(isManualDns);
    if (manual.length > 0) {
      // The operator's own DNS change is the command that routes the host to Tugra: PONR first when any of them is stateful.
      if (manual.some((e) => hostIsStateful(e, obs.dataApps))) await ctx.markPonr();
      if (!hasAttestation(ctx.step.evidence, MANUAL_DNS_ATTEST)) {
        return { outcome: "wait", wait: { kind: "operator", code: "cutover.manual-dns", params: { hosts: capHosts(manual.map((e) => e.hostname)) }, attest: [MANUAL_DNS_ATTEST] } };
      }
      const since = compDate(ctx.step.compensation, "manualCheckStartedAt");
      if (!since) await ctx.recordCompensation({ manualCheckStartedAt: iso(now) });
      if (since && now.getTime() - since.getTime() > VERIFY_DEADLINE_MS) throw new StepFailure("cutover.host-not-verified", { hosts: capHosts(manual.map((e) => e.hostname)), minutes: Math.round(VERIFY_DEADLINE_MS / 60_000) }, true);
      await this.cutover.check(userId, opId, { hostnames: manual.map((e) => e.hostname) });
      return { outcome: "continue", pollAfterMs: POLL_MS };
    }
    return { outcome: "done" };
  }

  private async actSwap(ctx: StepContext, obs: CutoverObs): Promise<ActResult> {
    const run = ctx.run;
    const serverId = run.targetServerId;
    const userId = ctx.actor.userId;
    const hosts = actionableEntries(obs.entries);
    const stateful = hosts.some((e) => hostIsStateful(e, obs.dataApps));
    if (hosts.length === 0) return { outcome: "done" };

    let swap = obs.swap;
    if (!swap) {
      // 1. identity first; nothing is stopped unless it is exactly the source's proxy. Recorded BEFORE any change.
      const ident = await inspectSourceProxy(this.world, serverId);
      if (!ident.ok) throw new StepFailure(ident.code === "unreadable" ? "cutover.swap-inspect-failed" : "cutover.swap-identity-mismatch", { reason: ident.code }, ident.code === "unreadable");
      swap = await this.world.createSwap(run.id, serverId, ident.snapshot, obs.facts?.proxyBind ?? "none");
      await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-planned", params: { image: ident.snapshot.image, restart: ident.snapshot.restartPolicy, hosts: hosts.length } });
    }
    if (swap.state === "REVERSING" || swap.state === "REVERSED") throw new StepFailure("cutover.swap-reversed", {}, false);

    if (swap.state === "PLANNED") {
      // 2. the PONR is durable before the source proxy is touched; 3. the state moves first, then the command.
      if (stateful) await ctx.markPonr();
      await ctx.assertLease();
      await this.world.setSwapState(run.id, serverId, ["PLANNED"], "STOPPING_SOURCE_PROXY");
      swap = { ...swap, state: "STOPPING_SOURCE_PROXY" };
    }
    if (swap.state === "STOPPING_SOURCE_PROXY") {
      await ctx.assertLease();
      const st = await stopSourceProxy(this.world, serverId, swap.coolifyProxy.containerId);
      if (!st) throw new StepFailure("cutover.swap-stop-failed", {}, true);
      if (st.updateFailed) throw new StepFailure("cutover.swap-restart-policy-failed", {}, true);
      if (st.sourceRunning === true) throw new StepFailure("cutover.swap-source-still-running", {}, true);
      await this.world.setSwapState(run.id, serverId, ["STOPPING_SOURCE_PROXY"], "STARTING_TARGET_PROXY");
      swap = { ...swap, state: "STARTING_TARGET_PROXY" };
      await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-source-stopped" });
    }
    if (swap.state === "STARTING_TARGET_PROXY") {
      await ctx.assertLease();
      await this.world.setProxyBind(serverId, "public");
      try {
        await this.proxyOps.start(userId, serverId);
      } catch (e) {
        rethrowLeaseLost(e);
        this.log.warn(`run ${run.id}: tugra proxy start failed: ${(e as Error).message}`);
        throw new StepFailure("cutover.swap-start-failed", {}, true);
      }
      const st = await swapHostState(this.world, serverId, swap.coolifyProxy.containerId);
      // Coolify may restart its own stopped proxy and win :80/:443 (lab item T1): then Tugra's proxy cannot publish them.
      if (!st || st.target !== "running" || !targetPublishesWeb(st)) throw new StepFailure("cutover.swap-ports-not-published", { target: st?.target ?? "unknown" }, true);
      if (st.sourceRunning === true) throw new StepFailure("cutover.swap-source-restarted", {}, true);
      await this.world.setSwapState(run.id, serverId, ["STARTING_TARGET_PROXY"], "LIVE");
      swap = { ...swap, state: "LIVE", liveAt: ctx.now() };
      await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-live" });
    }
    // swap.state === "LIVE": verify from the hub. A failure never auto-reverses (a stateful host may have taken writes):
    // the run view offers the explicit reverse.
    const facts = obs.facts ?? (await this.world.serverFacts(serverId));
    if (!facts) throw new StepFailure("cutover.swap-server-missing", {}, false);
    const verify = await verifySwapHosts(this, facts, hosts.map((e) => e.hostname), run.options.healthPath ?? "/");
    const bad = Object.entries(verify).filter(([, v]) => !v.ok).map(([h]) => h);
    if (bad.length === 0) {
      // The window of downtime ends here (first moment every host answers through Tugra's proxy).
      if (!run.freezeEndedAt) await ctx.patchRun({ freezeEndedAt: ctx.now() });
      return { outcome: "done" };
    }
    const since = swap.liveAt ?? ctx.now();
    if (ctx.now().getTime() - since.getTime() > SWAP_VERIFY_DEADLINE_MS) throw new StepFailure("cutover.swap-verify-failed", { hosts: capHosts(bad), minutes: Math.round(SWAP_VERIFY_DEADLINE_MS / 60_000) }, true);
    return { outcome: "continue", pollAfterMs: SWAP_POLL_MS };
  }

  // ───────────────────────────── post gate ─────────────────────────────

  postGate(ctx: StepContext, obs: CutoverObs): GateResult {
    if (!obs.opId) return makeGate([chk("cutover.hosts-verified", "fail", "cutover.import-op")]);
    if (ctx.run.topology === "swap-proxy") return this.swapPostGate(obs);
    const checks: GateCheck[] = [];
    for (const e of obs.entries) {
      if (e.state === "EXCLUDED" || e.state === "ROLLED_BACK") continue;
      if (e.state === "VERIFIED") checks.push(chk("cutover.host", "pass", "cutover.host-verified", { subject: e.hostname, evidence: "hub-verified" }));
      else if (e.state === "BLOCKED") checks.push(chk("cutover.host", "warn", "cutover.host-not-cut-over", { subject: e.hostname, params: { reason: e.blockReason ?? "blocked" } }));
      else checks.push(chk("cutover.host", "fail", FLIPPED_STATES.includes(e.state as (typeof FLIPPED_STATES)[number]) || e.state === "CONFLICT" ? "cutover.host-not-verified" : "cutover.host-not-switched", { subject: e.hostname, params: { state: e.state } }));
    }
    return makeGate(checks);
  }

  private swapPostGate(obs: CutoverObs): GateResult {
    const hosts = actionableEntries(obs.entries);
    if (hosts.length === 0) return makeGate([chk("cutover.swap", "pass", "cutover.swap-nothing-to-move")]);
    const checks: GateCheck[] = [chk("cutover.swap", obs.swap?.state === "LIVE" ? "pass" : "fail", "cutover.swap-not-live", { evidence: "hub-verified" })];
    for (const e of hosts) {
      const v = obs.swapVerify?.[e.hostname];
      checks.push(v?.ok ? chk("cutover.host", "pass", "cutover.host-verified", { subject: e.hostname, evidence: "hub-verified" }) : chk("cutover.host", v ? "fail" : "unknown", "cutover.host-not-verified", { subject: e.hostname, params: { reason: v?.reason ?? "unknown" } }));
    }
    return makeGate(checks);
  }

  // ───────────────────────────── compensate ─────────────────────────────

  /**
   * abort (pre-PONR) and reverse (post-PONR) undo the same thing; they differ only in what they may touch: an abort never
   * reverts a host that carries data (the PONR would have been set), a reverse always can (behind the data-loss acknowledgement).
   */
  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how === "cleanup") return { outcome: "nothing-to-do" };
    return ctx.run.topology === "swap-proxy" ? this.reverseSwap(ctx, how) : this.revertFlip(ctx, how);
  }

  private async reverseSwap(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    const run = ctx.run;
    const serverId = run.targetServerId;
    const swap = await this.world.getSwap(run.id, serverId);
    if (!swap || swap.state === "PLANNED" || swap.state === "REVERSED") return { outcome: "nothing-to-do" };
    await ctx.assertLease();
    await this.world.setSwapState(run.id, serverId, ["STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY", "LIVE", "REVERSING"], "REVERSING");
    const st = await reverseSwapOnHost(this.world, serverId, swap.coolifyProxy);
    if (!st) return { outcome: "failed", code: "cutover.swap-reverse-failed" };
    if (st.sourceRunning !== true) return { outcome: "failed", code: "cutover.swap-reverse-source-not-running", params: { source: String(st.sourceRunning) } };
    const bind = swap.tugraProxyBindBefore;
    await this.world.setProxyBind(serverId, bind === "loopback" || bind === "public" ? bind : "none");
    await this.world.setSwapState(run.id, serverId, ["REVERSING"], "REVERSED");
    await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-reversed" });
    // Nothing syncs backwards: whatever Tugra wrote after the swap stays on Tugra until the operator carries it over.
    return { outcome: "done", ...(how === "reverse" ? { manual: [{ code: "cutover.reverse-sync-guidance" }] } : {}) };
  }

  private async revertFlip(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const opId = run.opId;
    if (!opId) return { outcome: "nothing-to-do" };
    await this.cutover.cancel(userId, opId).catch((e) => rethrowLeaseLost(e));
    const view = await this.cutover.view(userId, opId);
    const apps = await this.world.opApps(opId);
    const dataApps = new Set(apps.filter((a) => a.hasData).map((a) => a.appId));
    if (view.entries.some((e) => e.state === "SWITCHING")) return { outcome: "failed", code: "cutover.flip-in-progress" };
    const flipped = view.entries.filter((e) => e.state === "SWITCHED" || e.state === "VERIFIED" || e.state === "VERIFY_FAILED");
    if (how === "abort" && flipped.some((e) => hostIsStateful(e, dataApps))) return { outcome: "failed", code: "cutover.abort-data-host-flipped", params: { hosts: capHosts(flipped.filter((e) => hostIsStateful(e, dataApps)).map((e) => e.hostname)) } };
    const providerHosts = flipped.filter((e) => !isManualDns(e));
    if (providerHosts.length > 0) {
      await ctx.assertLease();
      await this.cutover.revert(userId, opId, { hostnames: providerHosts.map((e) => e.hostname), force: false, acknowledgeDataLoss: true });
    }
    const after = trackedEntries((await this.cutover.view(userId, opId)).entries);
    const manual: Array<{ code: string; params?: Record<string, string[]> }> = [];
    const conflicts = after.filter((e) => e.state === "CONFLICT" || e.state === "REVERTING");
    if (conflicts.length) manual.push({ code: "cutover.revert-conflict", params: { hosts: capHosts(conflicts.map((e) => e.hostname)) } });
    const manualHosts = flipped.filter(isManualDns);
    if (manualHosts.length) manual.push({ code: "cutover.reverse-manual-dns", params: { hosts: capHosts(manualHosts.map((e) => e.hostname)) } });
    if (how === "reverse") manual.push({ code: "cutover.reverse-sync-guidance" });
    if (flipped.length === 0 && manual.length === 0) return { outcome: "nothing-to-do" };
    return manual.length > 0 ? { outcome: "manual", manual } : { outcome: "done" };
  }
}
