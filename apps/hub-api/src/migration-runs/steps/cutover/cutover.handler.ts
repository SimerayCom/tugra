import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { CutoverService } from "../../../cutover/cutover.service";
import { NetProbe } from "../../../cutover/net-probe";
import type { CutoverView } from "../../../cutover/cutover.dto";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
import type { DryRunItem, GateCheck, GateResult, StepEvidence } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  isMultiTarget,
  makeGate,
  resolveOwnerInput,
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
import { CutoverPlanService } from "./cutover-plan.service";
import { CutoverWorld, type GitWebhookApp, type OpApp, type ServerFacts, type SwapRow } from "./cutover-world.service";
import {
  HTTP01_GAP_ATTEST,
  LEFT_OUT_ATTEST,
  MANUAL_DNS_STALE_MS,
  MANUAL_DNS_ATTEST,
  MANUAL_DNS_DEFER_ATTEST,
  OBJECT_CLEARED_ATTEST,
  ENV_UNREADABLE_VIA,
  computeHolds,
  flipGroups,
  isGapHost,
  manualAwaitingDns,
  manualConfirmationStale,
  manualToDo,
  objectDependants,
  attestationFor,
  type Hold,
  type HoldApp,
  type ObjectsVerification,
} from "./cutover-holds";
import { PRE_EXISTING_REASON, degradedAtSourceHosts, excuseSwapVerify } from "./baseline-hosts";
import { inspectSourceProxy, reverseSwapOnHost, stopSourceProxy, swapHostState, targetPublishesWeb, verifySwapHosts, type SwapVerify } from "./swap-runtime";
import type { SwapHostState } from "./proxy-swap";
import {
  FLIPPED_STATES,
  actionableEntries,
  approvalValid,
  capHosts,
  chk,
  compDate,
  compString,
  compStrings,
  earliestVerified,
  hostIsStateful,
  isFlipped,
  isManualDns,
  iso,
  swapIsStateful,
  timerGate,
  trackedEntries,
  ttlWaitUntil,
  type CutoverRunView,
  type Entry,
} from "./run-cutover-logic";
import { setBounded } from "../../../common/bounded-map";

/** After the flip/swap, how long CUTOVER keeps re-verifying hosts (DNS propagation, certificates) before it fails (retryable). */
export const VERIFY_DEADLINE_MS = 30 * 60 * 1000;
/** After the proxy swap, how long the hosts get to answer through Tugra's proxy. */
export const SWAP_VERIFY_DEADLINE_MS = 5 * 60 * 1000;
const FLIP_POLL_MS = 5_000;
const SWAP_POLL_MS = 10_000;
/** Re-exported: the attestation ids live with the pure hold rules (the web offers them per host). */
export { HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST, MANUAL_DNS_ATTEST, MANUAL_DNS_DEFER_ATTEST, OBJECT_CLEARED_ATTEST };
const OBJECT_KEYS_TTL_MS = 30_000;
/** Per-host gate rows offered at most this many per attestation (the next ones appear as these are released). */
const ROW_CAP = 60;
const MANUAL_DNS_STALE_MINUTES = MANUAL_DNS_STALE_MS / 60_000;
/** How many times the swap takes the box back when Coolify restarts its own proxy between the stop and Tugra's proxy start (C11). */
export const SWAP_GUARD_ATTEMPTS = 2;
/** A manual-DNS check while the step is parked on the operator's checklist is made at most this often. */
const MANUAL_CHECK_EVERY_MS = 20_000;
/** The operator's decision to go on with a plan that changed after the approval was given (see {@link CutoverHandler.preGate}). */
export const PLAN_CHANGED_ATTEST = "cutover.plan-changed";

/** One record of the manual-DNS checklist as the operator types it at the DNS provider. */
const recordLine = (c: { name: string; type: string; content: string; ttl: number }): string => `${c.name} ${c.type} ${c.content} ttl=${c.ttl}`.slice(0, 300);

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
  /** Before anything is committed: the plan (flip plan hash / swap plan hash + stateful hosts) as it is right now, null when it cannot be computed. */
  plan: string | null;
  /** The plan the stored VERIFY approval is pinned to (first seen with that approval), null when nothing is pinned yet. */
  planPin: string | null;
  /** The apps of the op (hosts flip per app server; services are apps too). */
  apps: OpApp[];
  /** appId -> env NAMES that point at an object store (names only). */
  objectKeys: Map<string, string[]>;
  /** Policy `mirror` only: what the attached object migrations say (null = nothing attached or not read). */
  objects: ObjectsVerification | null;
  /** The per-host holds (object storage, stopped services, HTTP-01 gap, deferred manual DNS), keyed by hostname. */
  holds: Map<string, Hold>;
  /** Hosts that depend on object storage, with the names that say so (`env-unreadable` when the app's env could not be read). */
  dependants: Map<string, string[]>;
  /** Apps whose env could not be read: their object-store dependency is unknown (they are judged dependants, never silently clear). */
  envUnreadable: string[];
  /** Manual-DNS hosts the operator still has to act on: the exact records to enter, per host (empty while the step is not parked on the checklist). */
  manualRecords: Map<string, string[]>;
  /** After the cutover: the git apps behind VERIFIED hosts, for the webhook repoint guidance (R64). */
  webhooks: GitWebhookApp[];
  /** swap only, once LIVE: how the two proxies look on the box right now. */
  swapHost: SwapHostState | null;
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
    private readonly plans: CutoverPlanService,
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
      // A swap moves one box's ingress: a run that spans several target servers needs one run (and one swap) per box.
      if (isMultiTarget(run)) items.push({ code: "cutover.dry.swap-multi-target", level: "block", params: { servers: ctx.targetServerIds.length } });
      const ident = await inspectSourceProxy(this.world, run.targetServerId);
      if (!ident.ok && ident.code === "control-plane") items.push({ code: "cutover.dry.swap-control-plane-host", level: "block" });
      else items.push(ident.ok ? { code: "cutover.dry.swap-identity-ok", level: "info", params: { image: ident.snapshot.image, restart: ident.snapshot.restartPolicy } } : { code: `cutover.dry.swap-${ident.code === "unreadable" ? "inspect-failed" : "identity-mismatch"}`, level: ident.code === "unreadable" ? "unknown" : "block", params: { reason: ident.code } });
    } else {
      items.push({ code: "cutover.dry.flip", level: "info", params: { batchSize: run.options.batchSize, intervalSec: run.options.intervalSec } });
      if (isMultiTarget(run)) items.push({ code: "cutover.dry.flip-per-server", level: "info", params: { servers: ctx.targetServerIds.length } });
      if (run.opId) await this.dryRunHolds(ctx, run.opId, items);
    }
    return items;
  }

  /** Read-only: which hosts depend on object storage and what the policy does with them, how many git webhooks need repointing. */
  private async dryRunHolds(ctx: StepContext, opId: string, items: DryRunItem[]): Promise<void> {
    const apps = await this.world.opApps(opId);
    const policy = resolveOwnerInput(ctx.run.inputs, "minioPolicy") ?? "hold";
    if (policy !== "external") {
      const env = await this.world.appObjectEnv(apps.map((a) => a.appId));
      const stores = apps.filter((a) => a.objectStore === true).map((a) => a.appId);
      const names = apps.filter((a) => env.keys.has(a.appId) || stores.includes(a.appId)).map((a) => a.appId);
      if (names.length > 0) items.push({ code: "cutover.dry.object-dependants", level: policy === "hold" ? "warn" : "info", params: { apps: names.length, policy } });
      if (env.unreadable.length > 0) items.push({ code: "cutover.dry.object-env-unreadable", level: "warn", params: { apps: env.unreadable.length } });
    }
    const git = await this.world.gitWebhookApps(apps.map((a) => a.appId));
    if (git.length > 0) items.push({ code: "cutover.dry.webhooks", level: "info", params: { apps: git.length } });
  }

  // ───────────────────────────── observe ─────────────────────────────

  async observe(ctx: StepContext): Promise<CutoverObs> {
    const run = ctx.run;
    const opId = run.opId;
    const base: CutoverObs = { opId, topology: run.topology, entries: [], servers: [], flipRun: null, dataApps: new Set(), facts: null, swap: null, swapVerify: null, plan: null, planPin: null, apps: [], objectKeys: new Map(), objects: null, holds: new Map(), dependants: new Map(), envUnreadable: [], manualRecords: new Map(), webhooks: [], swapHost: null };
    if (!opId) return base;
    const [view0, apps, facts] = await Promise.all([this.cutover.view(ctx.actor.userId, opId), this.world.opApps(opId), this.world.serverFacts(run.targetServerId)]);
    let view = view0;
    // Manual-DNS hosts the operator confirmed are verified against the resolvers while the step is parked on the checklist
    // (no provider write, no traffic: it only reads DNS and the target and moves the host's state when it really switched).
    if (run.topology === "two-box" && !ctx.signal.aborted) view = await this.verifyConfirmedManual(ctx, opId, view);
    const obs: CutoverObs = { ...base, entries: view.entries, servers: view.servers, flipRun: view.run, dataApps: new Set(apps.filter((a) => a.hasData).map((a) => a.appId)), facts, apps };
    await this.observeHolds(ctx, obs);
    await this.observeManualRecords(ctx, obs);
    if (run.topology === "two-box" && view.entries.some((e) => e.state === "VERIFIED")) {
      const verifiedApps = new Set(view.entries.filter((e) => e.state === "VERIFIED").map((e) => e.applicationId));
      obs.webhooks = await this.world.gitWebhookApps([...verifiedApps]);
      await this.emitWebhookGuidance(ctx, obs);
    }
    if (run.topology === "swap-proxy") {
      obs.swap = await this.world.getSwap(run.id, run.targetServerId);
      if (obs.swap?.state === "LIVE" && facts) {
        // R52: a host whose app was already unhealthy at the source is reported as pre-existing, not as a new failure
        obs.swapVerify = excuseSwapVerify(await verifySwapHosts(this, facts, actionableEntries(view.entries).map((e) => e.hostname), run.options.healthPath ?? "/"), run.sourceBaseline, view.entries, apps);
        obs.swapHost = await swapHostState(this.world, run.targetServerId, obs.swap.coolifyProxy.containerId);
      }
    }
    // The approved plan is enforced while nothing is committed yet (a committed step resumes; its flip carries its own plan hash).
    if (!this.committed(ctx, obs)) await this.pinPlan(ctx, obs);
    // The measured end of the downtime window is a fact about the world: the first moment a host answers through Tugra.
    // Stamped where it is observed (the step usually passes on its post gate without another `act`); first write wins.
    if (!run.freezeEndedAt) {
      const at = run.topology === "swap-proxy" ? (obs.swapVerify && Object.values(obs.swapVerify).length > 0 && Object.values(obs.swapVerify).every((v) => v.ok) ? ctx.now() : null) : earliestVerified(view.entries);
      if (at) await ctx.patchRun({ freezeEndedAt: at });
    }
    return obs;
  }

  private readonly lastManualCheck = new Map<string, number>();

  /** Verify the manual-DNS hosts whose confirmation is fresh (throttled): returns the refreshed view when it checked. */
  private async verifyConfirmedManual(ctx: StepContext, opId: string, view: CutoverView): Promise<CutoverView> {
    const manual = view.entries.filter((e) => e.state === "READY" && isManualDns(e));
    const hosts = manualAwaitingDns(manual, ctx.step.evidence, ctx.now());
    if (hosts.length === 0) return view;
    const last = this.lastManualCheck.get(ctx.run.id) ?? 0;
    if (ctx.now().getTime() - last < MANUAL_CHECK_EVERY_MS) return view;
    setBounded(this.lastManualCheck, ctx.run.id, ctx.now().getTime(), 500);
    try {
      return await this.cutover.check(ctx.actor.userId, opId, { hostnames: hosts.slice(0, 200), ...(ctx.run.options.healthPath ? { healthPath: ctx.run.options.healthPath } : {}) }, { degradedAtSource: await degradedAtSourceHosts(this.world, opId, ctx.run.sourceBaseline, view.entries) });
    } catch (e) {
      rethrowLeaseLost(e);
      this.log.warn(`run ${ctx.run.id}: manual DNS check failed: ${(e as Error).message}`);
      return view;
    }
  }

  /**
   * The object storage dependants and every per-host hold, from what the world says right now. A swap moves the whole box, so
   * it has no per-host holds: it only reads the dependants and the object verification (they gate the swap as a whole).
   */
  private async observeHolds(ctx: StepContext, obs: CutoverObs): Promise<void> {
    const run = ctx.run;
    if (obs.entries.length === 0) return;
    const policy = resolveOwnerInput(run.inputs, "minioPolicy") ?? "hold";
    if (policy !== "external") {
      const env = await this.objectKeysOf(ctx, obs.apps);
      // An app whose env could not be read has an UNKNOWN object-store dependency: it is judged a dependant (and named), never silently clear.
      obs.objectKeys = new Map(env.keys);
      for (const id of env.unreadable) if (!obs.objectKeys.has(id)) obs.objectKeys.set(id, [ENV_UNREADABLE_VIA]);
      obs.envUnreadable = env.unreadable;
    }
    if (policy === "mirror") {
      const ids = ["DATA_SEED", "DATA_FINAL"].flatMap((k) => ctx.stepState(k as "DATA_SEED" | "DATA_FINAL").evidence.attachments.filter((a) => a.kind === "object-migration").map((a) => a.resourceId));
      obs.objects = await this.world.objectsVerification(run.teamId, [...new Set(ids)]);
    }
    const holdApps = this.holdApps(obs.apps);
    obs.dependants = policy === "external" ? new Map() : objectDependants(obs.entries, holdApps, obs.objectKeys);
    if (run.topology !== "two-box") return;
    obs.holds = computeHolds({ entries: obs.entries, apps: holdApps, objectKeys: obs.objectKeys, policy, objects: obs.objects, cutoverEvidence: ctx.step.evidence, tlsEvidence: ctx.stepState("TLS_PREISSUE").evidence, acceptHttp01Gap: run.options.acceptHttp01Gap });
  }

  private readonly recordCache = new Map<string, { at: number; key: string; records: Map<string, string[]> }>();

  /**
   * While the step can only wait on the manual-DNS checklist: the exact records to enter at the DNS provider, per host (from the
   * flip plan), so each host's row carries its own records. Reused for a minute; a plan that cannot be read leaves the rows without
   * records (the wait still lists the hosts), it never fails the step.
   */
  private async observeManualRecords(ctx: StepContext, obs: CutoverObs): Promise<void> {
    if (ctx.run.topology !== "two-box" || !obs.opId || !this.flipIdle(obs)) return;
    const todo = manualToDo(this.manualReady(obs), ctx.step.evidence, ctx.now()).map((m) => m.hostname).sort().slice(0, 200);
    if (todo.length === 0) return;
    const key = todo.join(",");
    const hit = this.recordCache.get(ctx.run.id);
    if (hit && hit.key === key && ctx.now().getTime() - hit.at < 60_000) {
      obs.manualRecords = hit.records;
      return;
    }
    try {
      const plan = await this.cutover.flipPlan(ctx.actor.userId, obs.opId, { hostnames: key });
      const records = new Map<string, string[]>();
      for (const c of plan.copyPaste) records.set(c.hostname, [...(records.get(c.hostname) ?? []), recordLine(c)]);
      setBounded(this.recordCache, ctx.run.id, { at: ctx.now().getTime(), key, records }, 200);
      obs.manualRecords = records;
    } catch (e) {
      rethrowLeaseLost(e);
      this.log.warn(`run ${ctx.run.id}: manual DNS records could not be read: ${(e as Error).message}`);
    }
  }

  /** The manual-DNS hosts that are ready and not held for another reason (the checklist's hosts). */
  private manualReady(obs: CutoverObs): Entry[] {
    return obs.entries.filter((e) => e.state === "READY" && isManualDns(e) && !obs.holds.has(e.hostname));
  }

  /** Nothing is flipping, verifying or left to flip at the provider: only held hosts and the manual checklist remain. */
  private flipIdle(obs: CutoverObs): boolean {
    if (obs.flipRun?.status === "running") return false;
    if (obs.entries.some((e) => e.state === "SWITCHING" || e.state === "SWITCHED" || e.state === "VERIFY_FAILED")) return false;
    return !obs.entries.some((e) => e.state === "READY" && !isManualDns(e) && !obs.holds.has(e.hostname));
  }

  private readonly keyCache = new Map<string, { at: number; ids: string; env: { keys: Map<string, string[]>; unreadable: string[] } }>();

  /** The object-store env names of the op's apps: the env is decrypted to list its keys, so the answer is reused for 30 s (an env edit mid-run is picked up on the next window). */
  private async objectKeysOf(ctx: StepContext, apps: readonly OpApp[]): Promise<{ keys: Map<string, string[]>; unreadable: string[] }> {
    const ids = apps.map((a) => a.appId).sort().join(",");
    const hit = this.keyCache.get(ctx.run.id);
    if (hit && hit.ids === ids && ctx.now().getTime() - hit.at < OBJECT_KEYS_TTL_MS) return hit.env;
    const env = await this.world.appObjectEnv(apps.map((a) => a.appId));
    setBounded(this.keyCache, ctx.run.id, { at: ctx.now().getTime(), ids, env }, 200);
    return env;
  }

  private holdApps(apps: readonly OpApp[]): Map<string, HoldApp> {
    return new Map(apps.map((a) => [a.appId, { appId: a.appId, kind: a.kind ?? "app", status: a.status ?? null, objectStore: a.objectStore === true }]));
  }

  /**
   * The human approved a plan (VERIFY binds the plan hash into its approval). The flip recomputes its own hash from the live
   * state, so on its own it can never notice a change since the approval. The plan is therefore pinned the first time this
   * step sees a given approval and compared on every later observation until the PONR: a DNS record, host set, stateful-host
   * set or source proxy that changed in between holds the step for an explicit operator decision. An operator attestation
   * newer than the pin accepts the plan as it is now (a new pin).
   */
  private async pinPlan(ctx: StepContext, obs: CutoverObs): Promise<void> {
    const approval = ctx.stepState("VERIFY").approval;
    if (!approval || !approvalValid(approval, ctx.now())) return;
    let plan: string | null = null;
    try {
      plan = (await this.plans.planHash({ id: ctx.run.id, opId: ctx.run.opId, actorId: ctx.run.actorId, topology: ctx.run.topology, targetServerId: ctx.run.targetServerId, serverMap: ctx.run.serverMap }))?.planHash ?? null;
    } catch (e) {
      rethrowLeaseLost(e);
      this.log.warn(`run ${ctx.run.id}: plan could not be computed: ${(e as Error).message}`);
    }
    obs.plan = plan;
    const comp = ctx.step.compensation;
    const pin = compString(comp, "planPin");
    if (pin && compString(comp, "planPinFor") === approval.at) {
      const pinnedAt = Date.parse(compString(comp, "planPinAt") ?? "");
      const accepted = ctx.step.evidence.attestations.some((a) => a.checkId === PLAN_CHANGED_ATTEST && Date.parse(a.at) > pinnedAt);
      if (!accepted) {
        obs.planPin = pin;
        return;
      }
    }
    if (!plan) return;
    await ctx.recordCompensation({ planPin: plan, planPinFor: approval.at, planPinAt: iso(ctx.now()) });
    obs.planPin = plan;
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
      // No pin and no plan: nothing could be compared (the act decides, e.g. an unreadable source proxy fails there with its own code).
      if (obs.planPin !== null || obs.plan !== null) {
        const same = obs.plan !== null && obs.plan === obs.planPin;
        checks.push(chk("cutover.plan-unchanged", same || obs.planPin === null ? "pass" : obs.plan === null ? "unknown" : "fail", obs.plan === null ? "cutover.plan-unavailable" : "cutover.plan-changed"));
      }
    }
    // A host that stays on the source (a `skip` hold) moves no data to Tugra's traffic: it is not part of the data-risk question.
    const movers = (run.topology === "swap-proxy" ? trackedEntries(obs.entries) : actionableEntries(obs.entries)).filter((e) => run.topology === "swap-proxy" || ((e.state === "READY" || isFlipped(e)) && obs.holds.get(e.hostname)?.kind !== "skip"));
    const stateful = movers.filter((e) => hostIsStateful(e, obs.dataApps));
    if (stateful.length > 0 && !committed) {
      checks.push(chk("cutover.data-risk", verify.approval?.acceptDataRisk === true ? "pass" : "fail", "cutover.data-risk-not-accepted", { params: { hosts: capHosts(stateful.map((e) => e.hostname)) } }));
    }
    // Every target server's ACME email (a multi-target run flips per server, so each one must be able to issue certificates).
    const serversChecked = run.topology === "swap-proxy" ? obs.servers.filter((s) => s.serverId === run.targetServerId) : obs.servers;
    for (const server of serversChecked) {
      checks.push(chk("cutover.acme-email", server.acmeEmailOk ? "pass" : "unknown", "cutover.acme-email", { ownerInput: "acmeEmail", evidence: "hub-verified", ...(serversChecked.length > 1 ? { subject: server.name } : {}) }));
    }
    if (run.topology === "two-box") {
      checks.push(chk("cutover.hosts-ready", obs.entries.some((e) => e.state === "READY" || isFlipped(e)) || actionableEntries(obs.entries).length === 0 ? "pass" : "fail", "cutover.no-ready-hosts"));
      const held = this.holdChecks(obs);
      checks.push(...held.checks, ...this.releaseRows(ctx, obs));
      if (!committed && run.options.ttlPolicy !== "skip-ack") {
        const until = ttlWaitUntil(obs.entries);
        const waiting = until !== null && until.getTime() > ctx.now().getTime();
        checks.push(chk("cutover.ttl-wait", waiting ? "fail" : "pass", "cutover.ttl-wait", waiting ? { params: { until: iso(until!) } } : {}));
        if (waiting) return this.planWait(checks) ?? timerGate(checks, ["cutover.ttl-wait"], until, "cutover.ttl-wait");
      }
      // The hosts-pending wait names what releases the held hosts; it is offered only when nothing else blocks the step.
      const othersBlock = checks.some((c) => (c.status === "fail" || c.status === "unknown") && c.id !== "cutover.hosts-pending");
      if (held.wait && !othersBlock) return makeGate(checks, { wait: held.wait });
    } else if (!committed) {
      checks.push(chk("cutover.swap-server", obs.facts ? "pass" : "fail", "cutover.swap-server-missing"));
      if (isMultiTarget(run)) checks.push(chk("cutover.swap-multi-target", "fail", "cutover.swap-multi-target", { params: { servers: ctx.targetServerIds.length } }));
      checks.push(...this.swapObjectChecks(ctx, obs));
    }
    return this.planWait(checks) ?? makeGate(checks);
  }

  /**
   * A same-host swap moves the WHOLE box's ingress, so a host that depends on object storage cannot stay behind: with policy
   * `hold` (the default) or `mirror` without verified buckets the swap is refused, naming the input that unblocks it.
   */
  private swapObjectChecks(ctx: StepContext, obs: CutoverObs): GateCheck[] {
    const policy = resolveOwnerInput(ctx.run.inputs, "minioPolicy") ?? "hold";
    if (policy === "external") return [];
    const apps = this.holdApps(obs.apps);
    const keys = obs.objectKeys;
    const dependants = objectDependants(trackedEntries(obs.entries), apps, keys);
    if (dependants.size === 0) return [];
    const hosts = capHosts([...dependants.keys()].sort());
    if (policy === "hold") return [chk("cutover.object-dependants", "fail", "cutover.swap-object-hold", { params: { hosts }, ownerInput: "minioPolicy" })];
    return [chk("cutover.object-dependants", obs.objects && obs.objects.attached > 0 && obs.objects.selectedBuckets > 0 && obs.objects.verified === obs.objects.selectedBuckets && obs.objects.problems === 0 ? "pass" : "fail", "cutover.objects-unverified", { params: { hosts }, evidence: "hub-verified" })];
  }

  /**
   * The per-host holds as gate checks (two-box). Hosts that stay out for good (`skip`) are warnings; hosts that wait (`pending`)
   * are warnings too while anything else can still move, and only when NOTHING else can move do they fail and park the step
   * with the attestations that release them. A held host therefore never stalls the others.
   */
  private holdChecks(obs: CutoverObs): { checks: GateCheck[]; wait: Extract<GateResult["wait"], { kind: "operator" }> | null } {
    const checks: GateCheck[] = [];
    const by = (reason: Hold["reason"]): string[] => [...obs.holds.values()].filter((h) => h.reason === reason).map((h) => h.hostname).sort();
    const objectHold = by("object-store-hold");
    if (objectHold.length > 0) checks.push(chk("cutover.object-dependants", "warn", "cutover.object-hold", { params: { hosts: capHosts(objectHold), count: objectHold.length }, ownerInput: "minioPolicy" }));
    const unreadable = [...obs.dependants].filter(([, via]) => via.includes(ENV_UNREADABLE_VIA)).map(([h]) => h).sort();
    if (unreadable.length > 0) checks.push(chk("cutover.object-env-unreadable", "warn", "cutover.object-env-unreadable", { params: { hosts: capHosts(unreadable), count: unreadable.length }, ownerInput: "minioPolicy" }));
    const leftOut = by("host-left-out");
    if (leftOut.length > 0) checks.push(chk("cutover.hosts-left-out", "warn", "cutover.hosts-left-out", { params: { hosts: capHosts(leftOut), count: leftOut.length } }));
    const deferred = by("manual-dns-deferred");
    if (deferred.length > 0) checks.push(chk("cutover.manual-dns-deferred-hosts", "warn", "cutover.manual-dns-deferred", { params: { hosts: capHosts(deferred), count: deferred.length } }));
    const pending = { objects: by("objects-unverified"), services: by("service-not-running"), gap: by("http01-gap-not-accepted") };
    const anyPending = pending.objects.length + pending.services.length + pending.gap.length > 0;
    if (!anyPending) return { checks, wait: null };
    const hasWork = this.hasWork(obs);
    const status = hasWork ? "warn" : "fail";
    if (pending.objects.length > 0) checks.push(chk("cutover.hosts-pending", status, "cutover.objects-unverified", { subject: "objects", params: { hosts: capHosts(pending.objects), count: pending.objects.length }, evidence: "hub-verified" }));
    if (pending.services.length > 0) checks.push(chk("cutover.hosts-pending", status, "cutover.service-not-running", { subject: "services", params: { hosts: capHosts(pending.services), count: pending.services.length }, evidence: "hub-verified" }));
    if (pending.gap.length > 0) checks.push(chk("cutover.hosts-pending", status, "cutover.http01-gap-pending", { subject: "gap", params: { hosts: capHosts(pending.gap), count: pending.gap.length } }));
    if (hasWork) return { checks, wait: null };
    // Every pending host can be released per host: its condition cleared, the gap accepted, or the host left out of the run.
    const attest = [...(pending.objects.length > 0 ? [OBJECT_CLEARED_ATTEST] : []), ...(pending.gap.length > 0 ? [HTTP01_GAP_ATTEST] : []), LEFT_OUT_ATTEST];
    return {
      checks,
      wait: { kind: "operator", code: "cutover.hosts-pending", params: { hosts: capHosts([...pending.objects, ...pending.services, ...pending.gap]), objects: capHosts(pending.objects), services: capHosts(pending.services), gap: capHosts(pending.gap) }, ...(attest.length > 0 ? { attest } : {}) },
    };
  }

  /**
   * One gate row per host a per-host attestation can release, so the operator's rows carry the hostname (the web derives an
   * attestation's subject from the gate check whose id is the attestation id; without a subject the hub ignores a per-host
   * decision). Offered only when nothing is left to flip, i.e. when the step can actually be waiting for them: the pending holds
   * (object data, stopped service, HTTP-01 gap: confirm, accept, or leave the host out) and the manual-DNS checklist (confirm
   * with the exact records, or leave the host on the source for now). Every id here is also in the wait's `attest` list.
   */
  private releaseRows(ctx: StepContext, obs: CutoverObs): GateCheck[] {
    if (!this.flipIdle(obs)) return [];
    const rows: GateCheck[] = [];
    const pending = [...obs.holds.values()].filter((h) => h.kind === "pending").sort((a, b) => a.hostname.localeCompare(b.hostname));
    for (const h of pending.filter((x) => x.reason === "objects-unverified").slice(0, ROW_CAP)) rows.push(chk(OBJECT_CLEARED_ATTEST, "warn", "cutover.release-object-cleared", { subject: h.hostname, params: { host: h.hostname } }));
    for (const h of pending.filter((x) => x.reason === "http01-gap-not-accepted").slice(0, ROW_CAP)) rows.push(chk(HTTP01_GAP_ATTEST, "warn", "cutover.release-http01-gap", { subject: h.hostname, params: { host: h.hostname } }));
    for (const h of pending.slice(0, ROW_CAP)) rows.push(chk(LEFT_OUT_ATTEST, "warn", "cutover.release-left-out", { subject: h.hostname, params: { host: h.hostname } }));
    const todo = manualToDo(this.manualReady(obs), ctx.step.evidence, ctx.now()).sort((a, b) => a.hostname.localeCompare(b.hostname));
    if (todo.length > 0) {
      const seen = new Map(obs.entries.map((e) => [e.hostname, e.dnsObserved]));
      rows.push(chk(MANUAL_DNS_ATTEST, "warn", "cutover.release-manual-dns-all", { params: { count: todo.length } }));
      for (const m of todo.slice(0, ROW_CAP)) {
        rows.push(chk(MANUAL_DNS_ATTEST, "warn", "cutover.release-manual-dns", { subject: m.hostname, params: { host: m.hostname, records: obs.manualRecords.get(m.hostname) ?? [], observed: seen.get(m.hostname) ?? "unknown" } }));
        rows.push(chk(MANUAL_DNS_DEFER_ATTEST, "warn", "cutover.release-manual-dns-defer", { subject: m.hostname, params: { host: m.hostname } }));
      }
    }
    return rows;
  }

  /** Is there something for `act` to do besides waiting on held hosts: a host to flip, to verify, or a manual-DNS checklist? */
  private hasWork(obs: CutoverObs): boolean {
    if (obs.flipRun?.status === "running") return true;
    if (obs.entries.some((e) => e.state === "SWITCHING" || e.state === "SWITCHED" || e.state === "VERIFY_FAILED")) return true;
    return obs.entries.some((e) => e.state === "READY" && !obs.holds.has(e.hostname));
  }

  /** When the plan check is the only thing blocking, the wait names it so the operator can accept the changed plan (an attestation). */
  private planWait(checks: GateCheck[]): GateResult | null {
    const blocking = checks.filter((c) => c.status === "fail" || c.status === "unknown");
    if (blocking.length === 0 || !blocking.every((c) => c.id === "cutover.plan-unchanged") || blocking[0].code !== "cutover.plan-changed") return null;
    return makeGate(checks, { wait: { kind: "operator", code: "cutover.plan-changed", attest: [PLAN_CHANGED_ATTEST] } });
  }

  // ───────────────────────────── act ─────────────────────────────

  async act(ctx: StepContext, obs: CutoverObs): Promise<ActResult> {
    if (!obs.opId) throw new StepFailure("cutover.import-op");
    const earliest = earliestVerified(obs.entries);
    if (earliest && !ctx.run.freezeEndedAt) await ctx.patchRun({ freezeEndedAt: earliest });
    return ctx.run.topology === "swap-proxy" ? this.actSwap(ctx, obs) : this.actTwoBox(ctx, obs);
  }

  /**
   * Where the verification deadline is measured from. A retry after a deadline failure opens a FRESH window (recorded once,
   * on the retry tick): the clock that already ran out would otherwise fail the retry before it re-verified anything.
   */
  private async verifyWindowStart(ctx: StepContext, base: Date): Promise<Date> {
    if (ctx.trigger === "retry") {
      const at = ctx.now();
      await ctx.recordCompensation({ verifyRetryAt: iso(at) });
      return at;
    }
    const retryAt = compDate(ctx.step.compensation, "verifyRetryAt");
    return retryAt && retryAt.getTime() > base.getTime() ? retryAt : base;
  }

  /** The Tugra server a host's app runs on (the default target for an app the world does not know). */
  private serverOf(ctx: StepContext, obs: CutoverObs): (e: Entry) => string {
    const byApp = new Map(obs.apps.map((a) => [a.appId, a.serverId ?? ""]));
    return (e) => byApp.get(e.applicationId) || ctx.run.targetServerId;
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

    // 1. What a flip left SWITCHED is verified before the next server group starts: a failing group never lets the next one begin.
    const switched = entries.filter((e) => e.state === "SWITCHED" || e.state === "VERIFY_FAILED");
    if (switched.length > 0) {
      const since = await this.verifyWindowStart(ctx, compDate(ctx.step.compensation, "flipStartedAt") ?? now);
      if (now.getTime() - since.getTime() > VERIFY_DEADLINE_MS) throw new StepFailure("cutover.host-not-verified", { hosts: capHosts(switched.map((e) => e.hostname)), minutes: Math.round(VERIFY_DEADLINE_MS / 60_000) }, true);
      await this.cutover.check(userId, opId, { hostnames: switched.map((e) => e.hostname) }, { degradedAtSource: await degradedAtSourceHosts(this.world, opId, ctx.run.sourceBaseline, entries) });
      return { outcome: "continue", pollAfterMs: POLL_MS };
    }

    // 2. The next flip group: one target server (and tier) at a time. Held hosts and manual-DNS hosts are not part of it.
    const ready = entries.filter((e) => e.state === "READY");
    const flippable = ready.filter((e) => !isManualDns(e) && !obs.holds.has(e.hostname));
    if (flippable.length > 0) {
      const started = await this.flipNextGroup(ctx, obs, flippable);
      if (started) return { outcome: "continue", pollAfterMs: FLIP_POLL_MS };
    }

    // 3. Manual DNS, after every provider host moved: a per-host checklist that never holds the others back.
    const manual = ready.filter((e) => isManualDns(e) && !obs.holds.has(e.hostname));
    if (manual.length > 0) return this.manualChecklist(ctx, obs, manual);

    return { outcome: "done" };
  }

  /**
   * Flip the first group of provider hosts that has anything to flip. The group is one target server (and, for object-storage
   * dependants, the later tier), planned and confirmed with exactly its own hostnames, so a failure halts only that group.
   * The PONR is persisted ONCE, before the first provider write of the first group that carries data. Returns false when no
   * group had a host the plan would write (every one was blocked at plan time).
   */
  private async flipNextGroup(ctx: StepContext, obs: CutoverObs, flippable: readonly Entry[]): Promise<boolean> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const opId = obs.opId!;
    const now = ctx.now();
    const groups = flipGroups(flippable, this.serverOf(ctx, obs), obs.dependants, ctx.targetServerIds);
    const names = new Map(obs.servers.map((s) => [s.serverId, s.name]));
    for (const group of groups) {
      const hostnames = group.hosts.slice(0, 200);
      const plan = await this.cutover.flipPlan(userId, opId, { hostnames: hostnames.join(",") });
      const live = new Set(plan.entries.map((e) => e.hostname));
      const planned = flippable.filter((e) => hostnames.includes(e.hostname) && live.has(e.hostname));
      if (plan.blocked.length > 0) await ctx.emit({ stepKey: "CUTOVER", level: "warn", code: "cutover.hosts-blocked", params: { hosts: capHosts(plan.blocked.map((b) => b.hostname)) } });
      if (planned.length === 0) continue;
      const stateful = planned.some((e) => hostIsStateful(e, obs.dataApps));
      // The PONR is durable BEFORE the first provider write that can route a stateful host to Tugra (a later group finds it set).
      if (stateful) await ctx.markPonr();
      await ctx.assertLease();
      await ctx.recordCompensation({ flipStartedAt: iso(now) });
      try {
        const r = await this.cutover.flip(userId, opId, {
          confirmToken: plan.planHash,
          hostnames,
          batchSize: run.options.batchSize,
          intervalSec: run.options.intervalSec,
          stopOnFail: true,
          // Only a group with no stateful host may auto-revert a failed flip (its revert loses no data).
          autoRevert: !stateful,
          acceptDataRisk: ctx.stepState("VERIFY").approval?.acceptDataRisk === true,
          // Every host of the group either has its certificate or had the gap accepted (the others are held), so the gap is accepted for the group.
          acceptHttp01Gap: run.options.acceptHttp01Gap || planned.some(isGapHost),
          skipTtlWait: run.options.ttlPolicy === "skip-ack",
        });
        await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.flip-started", params: { hosts: r.queued, stateful, server: names.get(group.serverId) ?? group.serverId } });
      } catch (e) {
        if (e instanceof ConflictException) {
          this.log.warn(`run ${run.id}: flip refused: ${e.message}`);
          throw new StepFailure("cutover.flip-refused", {}, true);
        }
        throw e;
      }
      return true;
    }
    return false;
  }

  /**
   * The manual-DNS tail (C10, R55/R57): the hosts whose DNS only the customer can change. Each host has its own checklist line
   * (the exact records, what the resolvers show) and its own confirmation; the hub verifies a confirmed host against the
   * resolvers while the step is parked (see `observe`), a host that never showed the change is asked about again after 30
   * minutes instead of failing the step, and a host the customer cannot do yet is deferred (reported as not cut over).
   */
  private async manualChecklist(ctx: StepContext, obs: CutoverObs, manual: readonly Entry[]): Promise<ActResult> {
    const userId = ctx.actor.userId;
    const opId = obs.opId!;
    const now = ctx.now();
    // The operator's own DNS change is the command that routes the host to Tugra: PONR first when any of them is stateful.
    if (manual.some((e) => hostIsStateful(e, obs.dataApps))) await ctx.markPonr();
    const todo = manualToDo(manual, ctx.step.evidence, now);
    const stale = todo.filter((m) => m.confirmedAt !== null && manualConfirmationStale(m.confirmedAt, now)).map((m) => m.hostname);
    if (stale.length > 0) {
      const asked = compStrings(ctx.step.compensation, "manualStaleAsked");
      const fresh = stale.filter((h) => !asked.includes(`${h}|${attestationFor(ctx.step.evidence, MANUAL_DNS_ATTEST, h, true)?.toISOString()}`));
      if (fresh.length > 0) {
        await ctx.recordCompensation({ manualStaleAsked: [...asked, ...fresh.map((h) => `${h}|${attestationFor(ctx.step.evidence, MANUAL_DNS_ATTEST, h, true)?.toISOString()}`)].slice(-400) });
        await ctx.emit({ stepKey: "CUTOVER", level: "warn", code: "cutover.manual-dns-not-seen", params: { hosts: capHosts(fresh), minutes: Math.round(MANUAL_DNS_STALE_MINUTES) } });
      }
    }
    if (todo.length === 0) {
      // Every manual host is confirmed and fresh: verify them against the resolvers now (the parked step does it on its own too).
      await this.cutover.check(userId, opId, { hostnames: manual.map((e) => e.hostname).slice(0, 200) }, { degradedAtSource: await degradedAtSourceHosts(this.world, opId, ctx.run.sourceBaseline, obs.entries) });
      return { outcome: "continue", pollAfterMs: POLL_MS };
    }
    const hosts = todo.map((m) => m.hostname);
    const plan = await this.cutover.flipPlan(userId, opId, { hostnames: hosts.slice(0, 200).join(",") });
    const records = plan.copyPaste.slice(0, 200).map(recordLine);
    const observed = manual.filter((e) => hosts.includes(e.hostname)).slice(0, 200).map((e) => `${e.hostname}=${e.dnsObserved}`.slice(0, 300));
    return {
      outcome: "wait",
      wait: {
        kind: "operator",
        code: "cutover.manual-dns",
        params: { hosts: capHosts(hosts, 200), records, observed, pending: hosts.length, total: manual.length },
        // Hosts held for another reason are released from this same wait (per host), so the checklist never hides their decision.
        attest: [MANUAL_DNS_ATTEST, MANUAL_DNS_DEFER_ATTEST, ...this.releaseAttests(obs)],
      },
    };
  }

  /** The per-host attestations that release the hosts that are waiting on a decision (pending holds), for a wait that is not the holds' own. */
  private releaseAttests(obs: CutoverObs): string[] {
    const pending = [...obs.holds.values()].filter((h) => h.kind === "pending");
    if (pending.length === 0) return [];
    return [...(pending.some((h) => h.reason === "objects-unverified") ? [OBJECT_CLEARED_ATTEST] : []), ...(pending.some((h) => h.reason === "http01-gap-not-accepted") ? [HTTP01_GAP_ATTEST] : []), LEFT_OUT_ATTEST];
  }

  private readonly webhookGuided = new Set<string>();

  /**
   * Once per run, as soon as every host that can move has moved (nothing left to flip or verify): where each git app's webhook
   * points now (the guidance is a gate warning per app too). Said from `observe`, because the step usually passes on its post
   * gate without another `act`; the stored marker keeps it to once across ticks and hub restarts.
   */
  private async emitWebhookGuidance(ctx: StepContext, obs: CutoverObs): Promise<void> {
    if (obs.webhooks.length === 0 || ctx.dryRun || this.webhookGuided.has(ctx.run.id) || compString(ctx.step.compensation, "webhooksAt")) return;
    if (obs.entries.some((e) => e.state === "SWITCHING" || e.state === "SWITCHED" || e.state === "VERIFY_FAILED") || obs.flipRun?.status === "running") return;
    if (obs.entries.some((e) => e.state === "READY" && !obs.holds.has(e.hostname))) return;
    this.webhookGuided.add(ctx.run.id);
    await ctx.recordCompensation({ webhooksAt: iso(ctx.now()) });
    const base = this.world.hubPublicUrl();
    const shared = obs.webhooks.filter((w) => w.kind === "github-app" && w.sourceId);
    const sources = [...new Set(shared.map((w) => `${base ?? ""}/webhooks/github/${w.sourceId}`))];
    const repos = [...new Set(obs.webhooks.map((w) => w.repo).filter((r): r is string => !!r))];
    const params = { apps: obs.webhooks.length, shared: shared.length, own: obs.webhooks.length - shared.length, repos: capHosts(repos, 200) };
    // Apps on a GitHub App source share ONE webhook per source (the event names its URL); every other git app has its own deploy webhook.
    if (sources.length > 0) await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.webhooks-repoint", params: { ...params, sources: capHosts(sources, 50) } });
    else await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.webhooks-repoint-apps", params });
  }

  private async actSwap(ctx: StepContext, obs: CutoverObs): Promise<ActResult> {
    const run = ctx.run;
    const serverId = run.targetServerId;
    const userId = ctx.actor.userId;
    const hosts = actionableEntries(obs.entries);
    // The swap moves the whole box's ingress: a host parked as BLOCKED is served by Tugra's proxy as well, so it counts for the PONR.
    const stateful = swapIsStateful(obs.entries, obs.dataApps);
    if (hosts.length === 0) return { outcome: "done" };
    // One swap moves ONE box. A run that spans several target servers needs one run per box (nothing was touched yet).
    if (isMultiTarget(run) && !obs.swap) throw new StepFailure("cutover.swap-multi-target", { servers: ctx.targetServerIds.length }, false);

    let swap = obs.swap;
    if (!swap) {
      // 1. identity first; nothing is stopped unless it is exactly the source's proxy. Recorded BEFORE any change.
      const ident = await inspectSourceProxy(this.world, serverId);
      // The control plane's own box is refused outright (C11): stopping its proxy cuts every host it manages off its panel and API.
      if (!ident.ok && ident.code === "control-plane") throw new StepFailure("cutover.swap-control-plane-host", {}, false);
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
      let start = await this.startTargetProxy(ctx, serverId, swap.coolifyProxy.containerId);
      // Coolify may restart its own stopped proxy between the stop and Tugra's start and win :80/:443 (lab item T1). Stopping the
      // control plane is not an option (it manages other hosts), so the box is taken back: the source proxy is stopped again
      // (its restart policy is already `no`) and Tugra's proxy started again, a bounded number of times. Two proxies cannot both
      // publish :80, so the race shows up in two ways: Tugra's start succeeded next to a running source, or Tugra's start itself
      // FAILED (port already allocated) while the source proxy is running. Both are the same race, so both take the box back.
      for (let attempt = 1; attempt <= SWAP_GUARD_ATTEMPTS && start.state?.sourceRunning === true; attempt++) {
        await ctx.recordCompensation({ swapGuardAttempts: attempt });
        await ctx.assertLease();
        await ctx.emit({ stepKey: "CUTOVER", level: "warn", code: "cutover.swap-source-restop", params: { attempt } });
        const again = await stopSourceProxy(this.world, serverId, swap.coolifyProxy.containerId);
        if (!again) throw new StepFailure("cutover.swap-stop-failed", {}, true);
        if (again.updateFailed) throw new StepFailure("cutover.swap-restart-policy-failed", {}, true);
        start = await this.startTargetProxy(ctx, serverId, swap.coolifyProxy.containerId);
      }
      // A start that failed while the source proxy is NOT the one holding the ports is a genuine failure (retryable: the next tick starts again).
      if (start.failed) throw new StepFailure(start.state?.sourceRunning === true ? "cutover.swap-source-restarted" : "cutover.swap-start-failed", {}, true);
      const st = start.state;
      if (!st || st.target !== "running" || !targetPublishesWeb(st)) throw new StepFailure("cutover.swap-ports-not-published", { target: st?.target ?? "unknown" }, true);
      if (st.sourceRunning === true) throw new StepFailure("cutover.swap-source-restarted", {}, true);
      await this.world.setSwapState(run.id, serverId, ["STARTING_TARGET_PROXY"], "LIVE");
      swap = { ...swap, state: "LIVE", liveAt: ctx.now() };
      await ctx.emit({ stepKey: "CUTOVER", level: "info", code: "cutover.swap-live" });
    }
    // swap.state === "LIVE": Coolify's own health job may bring its proxy back later; the box is taken back the same bounded way.
    const host = obs.swapHost ?? (await swapHostState(this.world, serverId, swap.coolifyProxy.containerId));
    if (host && host.sourceRunning === true) {
      const used = ctx.trigger === "retry" ? 0 : typeof ctx.step.compensation?.swapGuardLive === "number" ? (ctx.step.compensation.swapGuardLive as number) : 0;
      if (used >= SWAP_GUARD_ATTEMPTS) throw new StepFailure("cutover.swap-source-restarted", {}, true);
      await ctx.recordCompensation({ swapGuardLive: used + 1 });
      await ctx.assertLease();
      await ctx.emit({ stepKey: "CUTOVER", level: "warn", code: "cutover.swap-source-restop", params: { attempt: used + 1 } });
      const again = await stopSourceProxy(this.world, serverId, swap.coolifyProxy.containerId);
      if (!again) throw new StepFailure("cutover.swap-stop-failed", {}, true);
      if (again.updateFailed) throw new StepFailure("cutover.swap-restart-policy-failed", {}, true);
      const restarted = await this.startTargetProxy(ctx, serverId, swap.coolifyProxy.containerId);
      if (restarted.failed && restarted.state?.sourceRunning !== true) throw new StepFailure("cutover.swap-start-failed", {}, true);
      return { outcome: "continue", pollAfterMs: SWAP_POLL_MS };
    }
    // Verify from the hub. A failure never auto-reverses (a stateful host may have taken writes): the run view offers the explicit reverse.
    const facts = obs.facts ?? (await this.world.serverFacts(serverId));
    if (!facts) throw new StepFailure("cutover.swap-server-missing", {}, false);
    const verify = excuseSwapVerify(await verifySwapHosts(this, facts, hosts.map((e) => e.hostname), run.options.healthPath ?? "/"), run.sourceBaseline, obs.entries, obs.apps) ?? {};
    const bad = Object.entries(verify).filter(([, v]) => !v.ok).map(([h]) => h);
    if (bad.length === 0) {
      // The window of downtime ends here (first moment every host answers through Tugra's proxy).
      if (!run.freezeEndedAt) await ctx.patchRun({ freezeEndedAt: ctx.now() });
      return { outcome: "done" };
    }
    const since = await this.verifyWindowStart(ctx, swap.liveAt ?? ctx.now());
    if (ctx.now().getTime() - since.getTime() > SWAP_VERIFY_DEADLINE_MS) throw new StepFailure("cutover.swap-verify-failed", { hosts: capHosts(bad), minutes: Math.round(SWAP_VERIFY_DEADLINE_MS / 60_000) }, true);
    return { outcome: "continue", pollAfterMs: SWAP_POLL_MS };
  }

  /**
   * Start Tugra's proxy on the box and read both proxies' state (never swallows a lost lease). A failed start is NOT thrown: it
   * is returned with the state read afterwards, because a start that fails while Coolify's proxy holds :80/:443 is the race the
   * caller takes the box back from, and only the caller can tell that apart from a genuine failure.
   */
  private async startTargetProxy(ctx: StepContext, serverId: string, sourceContainerId: string): Promise<{ failed: boolean; state: SwapHostState | null }> {
    let failed = false;
    try {
      await this.proxyOps.start(ctx.actor.userId, serverId);
    } catch (e) {
      rethrowLeaseLost(e);
      this.log.warn(`run ${ctx.run.id}: tugra proxy start failed: ${(e as Error).message}`);
      failed = true;
    }
    return { failed, state: await swapHostState(this.world, serverId, sourceContainerId) };
  }

  // ───────────────────────────── post gate ─────────────────────────────

  postGate(ctx: StepContext, obs: CutoverObs): GateResult {
    if (!obs.opId) return makeGate([chk("cutover.hosts-verified", "fail", "cutover.import-op")]);
    if (ctx.run.topology === "swap-proxy") return this.swapPostGate(obs);
    const checks: GateCheck[] = [];
    for (const e of obs.entries) {
      if (e.state === "EXCLUDED" || e.state === "ROLLED_BACK") continue;
      const hold = obs.holds.get(e.hostname);
      if (e.state === "VERIFIED") checks.push(chk("cutover.host", "pass", "cutover.host-verified", { subject: e.hostname, evidence: "hub-verified" }));
      else if (hold?.kind === "skip") checks.push(chk("cutover.host", "warn", "cutover.host-not-cut-over", { subject: e.hostname, params: { reason: hold.reason } }));
      else if (e.state === "BLOCKED") checks.push(chk("cutover.host", "warn", "cutover.host-not-cut-over", { subject: e.hostname, params: { reason: e.blockReason ?? "blocked" } }));
      else checks.push(chk("cutover.host", "fail", FLIPPED_STATES.includes(e.state as (typeof FLIPPED_STATES)[number]) || e.state === "CONFLICT" ? "cutover.host-not-verified" : "cutover.host-not-switched", { subject: e.hostname, params: { state: e.state, ...(hold ? { reason: hold.reason } : {}) } }));
    }
    // After the cutover each git app's webhook has to be repointed by hand (R64): one warning per app, never a failure.
    const base = this.world.hubPublicUrl() ?? "";
    for (const w of obs.webhooks.slice(0, 100)) {
      if (w.kind === "github-app" && w.sourceId) checks.push(chk("cutover.webhook", "warn", "cutover.webhook-repoint", { subject: w.name, params: { repo: w.repo ?? "", autoDeploy: w.autoDeploy, url: `${base}/webhooks/github/${w.sourceId}` } }));
      else checks.push(chk("cutover.webhook", "warn", "cutover.webhook-repoint-app", { subject: w.name, params: { repo: w.repo ?? "", autoDeploy: w.autoDeploy } }));
    }
    return makeGate(checks);
  }

  private swapPostGate(obs: CutoverObs): GateResult {
    const hosts = actionableEntries(obs.entries);
    if (hosts.length === 0) return makeGate([chk("cutover.swap", "pass", "cutover.swap-nothing-to-move")]);
    const checks: GateCheck[] = [chk("cutover.swap", obs.swap?.state === "LIVE" ? "pass" : "fail", "cutover.swap-not-live", { evidence: "hub-verified" })];
    // Coolify's own proxy must not be running next to Tugra's once the swap is live.
    if (obs.swap?.state === "LIVE" && obs.swapHost) checks.push(chk("cutover.swap-source-quiet", obs.swapHost.sourceRunning === true ? "fail" : "pass", "cutover.swap-source-restarted", { evidence: "hub-verified" }));
    for (const e of hosts) {
      const v = obs.swapVerify?.[e.hostname];
      if (v?.ok && v.reason === PRE_EXISTING_REASON) {
        checks.push(chk("cutover.host", "warn", "cutover.host-pre-existing", { subject: e.hostname, evidence: "source-api-reported" }));
        continue;
      }
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
