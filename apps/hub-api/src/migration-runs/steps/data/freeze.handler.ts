import { Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import type { ApprovalBinding, DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  RunLeaseLostError,
  STEP_HANDLERS,
  resolveOwnerInput,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunSnapshot,
  type SourceController,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { coolifyRefOf, type CoolifyResourceKind } from "../../../importer/sources/coolify-control";
import {
  CAPABILITY_PORT,
  DATA_CODES,
  DATA_PORT,
  SOURCE_API_PORT,
  SOURCE_HOST_PORT,
  type ApiFailure,
  type CapabilityPort,
  type DataPort,
  type DataSnapshot,
  type DbDataItem,
  type FreezeRecord,
  type RecordedContainer,
  type SourceApiPort,
  type SourceHostPort,
  type SourceItem,
} from "./data-contract";
import { TICK_GAP_CHECK, TICK_GAP_CODES, TICK_GAP_GATE_CHECK, tickGapCovered } from "./tick-gap";
import { agentRunnerHost, estimateEquals, estimateWindowDetail, sha256Hex, tickGapOf, windowExtrasOf, type TickGap, type WindowTerms } from "./data-logic";
import { HOST_LOOP_CODES } from "./inventory/host-codes";
import { containerPrefixesOfSnapshot, planRefsOf, serverRefOfItem, sourceHostsOf } from "./inventory/host-hosts";
import { attestableFindings, crossCheckChecks } from "./inventory/cross-check";
import { emptyHostView, loadHostView, type HostView } from "./inventory/host-view";
import { HOST_REPORT_PORT, type HostReportPort } from "./inventory/inventory-contract";
import { classifyAgentError, compOf, gateFrom, loadSnapshot, releaseIfOurs, type StepComp } from "./handler-util";
import {
  buildSourceInspectScript,
  buildSourceStartScript,
  buildSourceStateScript,
  buildSourceStopScript,
  parseSourceInspect,
  parseStartOutput,
  parseStateOutput,
  parseStopOutput,
} from "./source-control/source-scripts";

export interface StopItem {
  itemRef: string;
  kind: CoolifyResourceKind;
  uuid: string;
  name: string;
  /** The app's custom container name prefix: its container is `<prefix>-<timestamp>`, not `<uuid>-<timestamp>`. */
  containerPrefix?: string;
}

export interface FreezeObs extends Observation {
  snap: DataSnapshot;
  controller: SourceController;
  stop: StopItem[];
  record: FreezeRecord | undefined;
  attested: boolean;
  /** Hub-verified state of what the freeze stopped (null = nothing recorded yet, or it could not be read). */
  states: { total: number; stopped: number; running: number; unknown: number } | null;
  apiAvailable: "ok" | ApiFailure | null;
  /** The downtime estimate from the CURRENT facts (the approval reviews this, not a stale stored value). */
  estimateSec: number | null;
  /** The parts of that estimate (data, builds, starts, health, ACME, bytes through the hub), shown in full in the approval. */
  terms: WindowTerms;
  /** The estimated write gap against the owner's accepted `tickGapAcceptMinutes` (R42/N2). */
  gap: TickGap;
  /** The stored reports of the host-loop runner (freeze outcome per source host); empty unless that runner freezes. */
  hosts: HostView;
}

/** How long an accepted stop may take to show as stopped before the freeze fails (retryable). */
export const STOP_CONFIRM_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_TIMEOUT_MS = 300_000;
/** The operator attestation that stop-list items matching no container may be left as they are (they are not writers). */
export const UNRESOLVED_CHECK = "freeze-containers-unresolved";
/**
 * N2: the explicit attestation that the estimated write gap (the source writers stay stopped for the whole window) is accepted
 * although it is over the owner's `tickGapAcceptMinutes` (default 0: any gap needs it). Append-only feeds (price ticks, metrics)
 * lose what they would have written during that gap.
 */
export { TICK_GAP_CHECK, TICK_GAP_CODES };

/**
 * The Coolify items the freeze stops: apps and services (the writers), plus every database that is copied PHYSICALLY (its data
 * directory is copied as files, which is only consistent when the source database is stopped). A database copied logically keeps
 * running: its dump needs a live server, and with its writers stopped nothing changes under it.
 */
export function buildStopList(snap: Pick<DataSnapshot, "apps" | "services"> & { databases?: ReadonlyArray<Pick<DbDataItem, "itemRef" | "name" | "plane">> }): StopItem[] {
  const out: StopItem[] = [];
  const candidates: ReadonlyArray<Pick<SourceItem, "itemRef" | "name" | "containerPrefix">> = [...snap.apps, ...snap.services, ...(snap.databases ?? []).filter((d) => d.plane === "volume")];
  for (const it of candidates) {
    const ref = coolifyRefOf(it.itemRef);
    if (ref) out.push({ itemRef: it.itemRef, kind: ref.kind, uuid: ref.uuid, name: it.name ?? ref.uuid, ...(it.containerPrefix ? { containerPrefix: it.containerPrefix } : {}) });
  }
  return out.sort((a, b) => (a.itemRef < b.itemRef ? -1 : 1));
}

export const controllerOf = (run: RunSnapshot): SourceController => resolveOwnerInput(run.inputs, "sourceController") ?? "manual";

/**
 * With the `coolify-host-loop` runner the writers are stopped by the loop script on each source host (the `agent` controller's
 * identity-checked docker stop, executed over ssh from the Coolify host instead of by an agent on the host): there is no
 * same-host requirement, and the evidence is `host-loop-reported`.
 */
export const hostLoopFreeze = (run: RunSnapshot): boolean => run.options.sourceRunner === "coolify-host-loop" && controllerOf(run) === "agent";

/** The `freeze` compensation record of a host-loop freeze: the controller and the hosts it was started for; the identities live in the host reports and on each host. */
const HOST_LOOP_CONTROLLER = "host-loop";
interface HostLoopFreezeRecord {
  controller: typeof HOST_LOOP_CONTROLLER;
  hosts?: string[];
}

/** The stop list grouped by the source host that runs each item (`_` = the source did not say, which no host can be told to stop). */
export function stopHostsOf(stop: readonly StopItem[]): { byHost: Map<string, StopItem[]>; unplaced: StopItem[] } {
  const byHost = new Map<string, StopItem[]>();
  const unplaced: StopItem[] = [];
  for (const s of stop) {
    const h = serverRefOfItem(s.itemRef);
    if (h === "_") unplaced.push(s);
    else byHost.set(h, [...(byHost.get(h) ?? []), s]);
  }
  return { byHost, unplaced };
}

/**
 * FREEZE (approval, then operator or automatic): opens the downtime window by stopping the source writers.
 *
 *  - `manual` (default, owner question 8 unanswered): prints the stop list; the evidence is the operator's attestation.
 *  - `api`: stops each Coolify application/service through its API (a token that may write; the import session's token),
 *    then verifies the state back from the API (hub-verified).
 *  - `agent`: same-host only. Discovers the containers, RECORDS their identity (id + name + image), stops exactly those,
 *    and verifies they are down through the agent (hub-verified). Never `docker rm`.
 *
 * The freeze is NOT the point of no return: Tugra has taken no writes, so abort restarts exactly what was stopped.
 */
@Injectable()
export class FreezeHandler implements StepHandler<FreezeObs>, OnModuleInit {
  readonly key = "FREEZE" as const;
  readonly kind = "approval" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(DATA_PORT) private readonly data: DataPort,
    @Inject(SOURCE_API_PORT) private readonly api: SourceApiPort,
    @Inject(SOURCE_HOST_PORT) private readonly host: SourceHostPort,
    @Inject(CAPABILITY_PORT) private readonly caps: CapabilityPort,
    @Optional() @Inject(HOST_REPORT_PORT) private readonly reports?: HostReportPort,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applicable(_run: RunSnapshot): boolean {
    return true;
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    const controller = controllerOf(run);
    const items: DryRunItem[] = [{ code: "freeze.dry.plan", level: "info", params: { controller, scheduled: !!run.options.freezeAt, ttlPolicy: run.options.ttlPolicy } }];
    const viaLoop = hostLoopFreeze(run);
    const runnerHost = agentRunnerHost(run);
    if (controller === "agent" && !viaLoop && !runnerHost.ok) items.push({ code: runnerHost.code, level: "block" });
    if (!run.opId) return items;
    const stop = buildStopList(await loadSnapshot(this.data, ctx));
    items.push({ code: DATA_CODES.freezeStopList, level: stop.length ? "info" : "warn", params: { count: stop.length, names: stop.slice(0, 40).map((s) => s.name) } });
    if (viaLoop) {
      const { byHost, unplaced } = stopHostsOf(stop);
      items.push({ code: HOST_LOOP_CODES.freezeDryPlan, level: "info", params: { hosts: byHost.size, items: stop.length - unplaced.length } });
      if (unplaced.length) items.push({ code: HOST_LOOP_CODES.freezeNoHost, level: "block", params: { count: unplaced.length, names: unplaced.slice(0, 20).map((u) => u.name) } });
    }
    return items;
  }

  // ───────────────────────────── observe ─────────────────────────────

  async observe(ctx: StepContext): Promise<FreezeObs> {
    const run = ctx.run;
    const snap = await loadSnapshot(this.data, ctx);
    const controller = controllerOf(run);
    const record = compOf(ctx).freeze as FreezeRecord | undefined;
    const attested = ctx.step.evidence.attestations.some((a) => a.checkId === "source-quiesced");
    let apiAvailable: FreezeObs["apiAvailable"] = null;
    if (controller === "api") {
      const av = await this.api.available(run);
      apiAvailable = av.ok ? "ok" : av.reason;
    }
    const { estimate, terms } = estimateWindowDetail(snap, ctx.now(), windowExtrasOf(run, snap));
    const gap = tickGapOf(estimate.freezeToFlipSec, resolveOwnerInput(run.inputs, "tickGapAcceptMinutes") ?? 0);
    // the host reports are also read when DATA_SEED was skipped: the docker-vs-API cross-check lives in DATA_SEED, and a skip must not
    // silently reopen "data left behind" (R2), so the freeze judges the same findings itself
    const hosts = hostLoopFreeze(run) || ctx.stepState("DATA_SEED").status === "SKIPPED" ? await loadHostView(this.reports, run.id).catch(() => emptyHostView()) : emptyHostView();
    return { snap, controller, stop: buildStopList(snap), record, attested, apiAvailable, estimateSec: estimate.freezeToFlipSec, terms, gap, hosts, states: record ? await this.readStates(ctx, record) : null };
  }

  /** Re-read what the freeze stopped. Never throws: an unreadable state is `unknown` and therefore not quiesced. */
  private async readStates(ctx: StepContext, rec: FreezeRecord): Promise<FreezeObs["states"]> {
    if (rec.controller === "api" && rec.api) {
      let stopped = 0;
      let running = 0;
      let unknown = 0;
      for (const it of rec.api) {
        const s = await this.api.state(ctx.run, it.kind, it.uuid);
        if (!s.ok) unknown++;
        else if (s.state === "stopped") stopped++;
        else if (s.state === "running") running++;
        else unknown++;
      }
      return { total: rec.api.length, stopped, running, unknown };
    }
    if (rec.controller === "agent" && rec.containers) {
      if (rec.containers.length === 0) return { total: 0, stopped: 0, running: 0, unknown: 0 };
      try {
        const runner = agentRunnerHost(ctx.run);
        if (!runner.ok) return { total: rec.containers.length, stopped: 0, running: 0, unknown: rec.containers.length };
        const res = await this.host.run(runner.serverId, buildSourceStateScript(rec.containers), "migrate", SCRIPT_TIMEOUT_MS);
        const st = parseStateOutput(res.output, rec.containers.map((c) => c.id));
        let stopped = 0;
        let running = 0;
        let unknown = 0;
        for (const c of rec.containers) {
          const v = st.get(c.id);
          if (v === "false" || v === "gone") stopped++;
          else if (v === "true") running++;
          else unknown++;
        }
        return { total: rec.containers.length, stopped, running, unknown };
      } catch {
        return { total: rec.containers.length, stopped: 0, running: 0, unknown: rec.containers.length };
      }
    }
    return null;
  }

  // ───────────────────────────── gates ─────────────────────────────

  private structural(ctx: StepContext, obs: FreezeObs): { checks: GateCheck[]; timer: string | null } {
    const run = ctx.run;
    const checks: GateCheck[] = [];
    let timer: string | null = null;
    const runnerHost = agentRunnerHost(run);
    if (obs.controller === "agent" && !hostLoopFreeze(run) && !runnerHost.ok) checks.push({ id: "agent-same-host", status: "fail", code: runnerHost.code });
    if (obs.controller === "api" && obs.apiAvailable !== "ok") checks.push({ id: "api-available", status: "fail", code: DATA_CODES.freezeApiUnavailable, params: { reason: obs.apiAvailable ?? "unknown" }, ownerInput: "sourceController" });
    const seed = ctx.stepState("DATA_SEED").status;
    if (seed !== "PASSED" && seed !== "SKIPPED") checks.push({ id: "data-seed", status: "fail", code: "freeze.data-seed-not-passed", params: { status: seed } });
    if (seed === "SKIPPED") checks.push(...this.skippedSeedFindings(ctx, obs));
    // the TTL wait: freezing earlier is pointless, the flip cannot happen before the old TTL has expired
    const dns = ctx.stepState("DNS_PREPARE");
    if (run.topology === "two-box" && dns.status !== "SKIPPED") {
      const nb = dns.notBefore;
      if (dns.status === "PASSED" || dns.status === "WAITING_TIMER") {
        if (nb && nb.getTime() > ctx.now().getTime()) {
          if (run.options.ttlPolicy === "wait") {
            timer = nb.toISOString();
            checks.push({ id: "ttl-wait", status: "fail", code: "freeze.ttl-wait", params: { notBefore: timer } });
          } else checks.push({ id: "ttl-wait", status: "warn", code: "freeze.ttl-skipped", params: { notBefore: nb.toISOString() } });
        }
      } else checks.push({ id: "dns-prepared", status: "fail", code: "freeze.dns-not-prepared", params: { status: dns.status } });
    }
    checks.push(...this.tickGapChecks(ctx, obs));
    return { checks, timer };
  }

  /**
   * R42/N2: the source writers stay stopped for the whole window. When the estimated gap is over what the owner accepts
   * (`tickGapAcceptMinutes`, default 0), or cannot be told yet, FREEZE needs the explicit `tick-gap-accepted` attestation: an
   * append-only feed writer (price ticks, metrics) loses what it would have written. Nothing is stopped, so nothing is lost, when
   * the run stops no writer at all.
   */
  private tickGapChecks(ctx: StepContext, obs: FreezeObs): GateCheck[] {
    if (obs.stop.length === 0) return [];
    const g = obs.gap;
    const params = { gapMinutes: g.gapMinutes, acceptedMinutes: g.acceptedMinutes, writers: obs.stop.length };
    if (!g.over) return [{ id: TICK_GAP_GATE_CHECK, status: "pass", code: TICK_GAP_CODES.within, params, evidence: "hub-verified" }];
    if (tickGapCovered(ctx.step.evidence.attestations, g)) return [{ id: TICK_GAP_GATE_CHECK, status: "warn", code: TICK_GAP_CODES.attested, params, evidence: "operator-attested" }];
    return [{ id: TICK_GAP_GATE_CHECK, status: "fail", code: TICK_GAP_CODES.exceeded, params, ownerInput: "tickGapAcceptMinutes", attestable: [TICK_GAP_CHECK], evidence: "hub-verified" }];
  }

  /**
   * R2/C6 after a skipped DATA_SEED: the unlisted-database and orphan-volume findings (and, for the host-loop runner, a missing
   * inventory) are judged HERE, where nothing can be skipped. The attestations of both steps count (the operator may have settled
   * a finding in DATA_SEED before skipping the rest). The loop runner requires an inventory of every host; other runners judge the
   * ones that arrived.
   */
  private skippedSeedFindings(ctx: StepContext, obs: FreezeObs): GateCheck[] {
    const run = ctx.run;
    const isLoop = run.options.sourceRunner === "coolify-host-loop";
    return crossCheckChecks({
      hosts: isLoop ? sourceHostsOf(run, obs.snap) : [],
      required: isLoop,
      inventories: obs.hosts.inventories,
      reach: obs.hosts.reach,
      planRefs: planRefsOf(obs.snap),
      containerPrefixes: containerPrefixesOfSnapshot(obs.snap),
      unlistedDbPolicy: resolveOwnerInput(run.inputs, "unlistedDbPolicy") ?? "block",
      orphanVolumePolicy: resolveOwnerInput(run.inputs, "orphanVolumePolicy") ?? "block",
      attestations: [...ctx.stepState("DATA_SEED").evidence.attestations, ...ctx.step.evidence.attestations],
      currentPartMiB: null,
      findingsOnly: true,
    });
  }

  preGate(ctx: StepContext, obs: FreezeObs): GateResult {
    const { checks, timer } = this.structural(ctx, obs);
    if (timer) return gateFrom(checks, { kind: "timer", notBefore: timer, code: "freeze.ttl-wait" });
    // a finding the owner/operator has not settled parks the step as an operator wait that offers the inventory and the attestations
    const finding = checks.find((c) => c.status !== "pass" && c.status !== "warn" && c.code.startsWith("inventory."));
    // N2: a write gap over the accepted one parks the step the same way, with its own attestation
    const gap = checks.find((c) => c.status === "fail" && c.code === TICK_GAP_CODES.exceeded);
    if (!finding && !gap) return gateFrom(checks);
    const attest = [...attestableFindings(checks), ...(gap ? [TICK_GAP_CHECK] : [])];
    const first = finding ?? gap!;
    return gateFrom(checks, { kind: "operator", code: first.code, params: first.params ?? {}, ...(finding ? { offersCommand: true, commandKind: "inventory" as const } : {}), ...(attest.length ? { attest } : {}) });
  }

  async approvalBinding(ctx: StepContext, obs: FreezeObs): Promise<ApprovalBinding | null> {
    const est = obs.estimateSec;
    const refs = obs.stop.map((s) => s.itemRef).join(",");
    const t = obs.terms;
    return {
      inputHash: sha256Hex(`freeze|${ctx.run.id}|${obs.controller}|${refs}|${est ?? "unknown"}|${obs.gap.acceptedMinutes}`),
      ponr: false,
      confirm: "run-id",
      ttlSec: null,
      requiresDataRisk: false,
      ackable: [],
      requiredAcks: [],
      review: {
        controller: obs.controller,
        apps: obs.snap.apps.length,
        services: obs.snap.services.length,
        stopList: obs.stop.slice(0, 40).map((s) => s.name),
        // R27/C5/R38: the FULL estimate, term by term (every one of them an assumption until the run measures it)
        estimateSec: est,
        estimateDataSec: t.dataSec,
        estimateBuildSec: t.buildSec,
        estimateStartSec: t.startSec,
        estimateHealthSec: t.healthSec,
        estimateAcmeSec: t.acmeSec,
        estimateBytes: t.bytes,
        estimateHubBytes: t.hubBytes,
        // R42/N2: how long the writers stay stopped, against what the owner accepted
        writeGapSec: est,
        tickGapAcceptedSec: obs.gap.acceptedMinutes * 60,
        tickGapNeedsAttestation: obs.gap.over && obs.stop.length > 0,
        keepsStopped: true,
        scheduledFor: ctx.run.options.freezeAt ?? null,
      },
    };
  }

  /** The source is quiesced AND the evidence says how we know. */
  private quiesced(ctx: StepContext, obs: FreezeObs): { ok: boolean; remaining: number } {
    if (hostLoopFreeze(ctx.run)) return this.hostLoopQuiesced(obs);
    if (!obs.record) return { ok: false, remaining: obs.stop.length };
    if (obs.controller === "manual") {
      // the operator's word, or the migrator will stop the source writers itself (`--stop-source`, reported at DATA_FINAL)
      return { ok: obs.attested || ctx.run.options.stopSource, remaining: obs.attested || ctx.run.options.stopSource ? 0 : obs.stop.length };
    }
    if (!obs.states) return { ok: false, remaining: obs.stop.length };
    return { ok: obs.states.running === 0 && obs.states.unknown === 0, remaining: obs.states.running + obs.states.unknown };
  }

  /** Host-loop freeze: quiesced when EVERY source host that has stop-list items reported that its recorded containers are stopped. */
  private hostLoopQuiesced(obs: FreezeObs): { ok: boolean; remaining: number } {
    const { byHost, unplaced } = stopHostsOf(obs.stop);
    let remaining = unplaced.length;
    for (const host of byHost.keys()) if (obs.hosts.freeze.get(host)?.state !== "stopped") remaining++;
    return { ok: remaining === 0, remaining };
  }

  postGate(ctx: StepContext, obs: FreezeObs): GateResult {
    if (hostLoopFreeze(ctx.run)) return this.hostLoopGate(obs);
    const q = this.quiesced(ctx, obs);
    const unresolved = obs.record?.unresolved?.length ?? 0;
    const evidence = obs.controller === "manual" ? (obs.attested ? "operator-attested" : "migrator-reported") : unresolved ? "operator-attested" : "hub-verified";
    const checks: GateCheck[] = [{ id: "source-quiesced", status: q.ok ? "pass" : obs.record ? "fail" : "unknown", code: q.ok ? DATA_CODES.freezeQuiesced : DATA_CODES.freezeStillRunning, params: { remaining: q.remaining, controller: obs.controller }, evidence }];
    // the part of the stop list the hub could not resolve to a container was accepted by the operator, and stays visible
    if (unresolved) checks.push({ id: "containers-unresolved", status: "warn", code: DATA_CODES.freezeContainerUnresolved, params: { count: unresolved, names: obs.record!.unresolved!.slice(0, 20) }, evidence: "operator-attested" });
    return gateFrom(checks);
  }

  private hostLoopGate(obs: FreezeObs): GateResult {
    const q = this.hostLoopQuiesced(obs);
    const checks: GateCheck[] = [
      { id: "source-quiesced", status: q.ok ? "pass" : obs.record ? "fail" : "unknown", code: q.ok ? DATA_CODES.freezeQuiesced : DATA_CODES.freezeStillRunning, params: { remaining: q.remaining, controller: "host-loop" }, evidence: "host-loop-reported" },
    ];
    const unresolved: string[] = [];
    for (const [host, rep] of obs.hosts.freeze) {
      if (rep.state === "stop-failed" || (rep.state === "error" && rep.payload.errorCode !== "unresolved-items")) checks.push({ id: `freeze-host:${host.slice(0, 60)}`, status: "fail", code: HOST_LOOP_CODES.freezeHostFailed, subject: host, params: { host, state: rep.state, code: rep.payload.errorCode ?? "stop-failed" }, evidence: "host-loop-reported" });
      unresolved.push(...rep.payload.unresolved);
    }
    // a stop-list item no container matched was accepted by the operator and stays visible
    if (q.ok && unresolved.length) checks.push({ id: "containers-unresolved", status: "warn", code: DATA_CODES.freezeContainerUnresolved, params: { count: unresolved.length, names: unresolved.slice(0, 20) }, evidence: "operator-attested" });
    return gateFrom(checks);
  }

  // ───────────────────────────── act ─────────────────────────────

  async act(ctx: StepContext, obs: FreezeObs): Promise<ActResult> {
    const run = ctx.run;
    if (!ctx.approval) return { outcome: "fail", code: "freeze.approval-missing", retryable: true };
    // N2: the approval is not enough when the write gap is over what the owner accepts: the attestation is the explicit word
    const gapAttested = tickGapCovered(ctx.step.evidence.attestations, obs.gap);
    if (obs.stop.length > 0 && obs.gap.over && !gapAttested) return { outcome: "fail", code: "freeze.tick-gap-not-accepted", params: { gapMinutes: obs.gap.gapMinutes, acceptedMinutes: obs.gap.acceptedMinutes }, retryable: true };
    const freezeAt = run.options.freezeAt ? new Date(run.options.freezeAt) : null;
    if (freezeAt && freezeAt.getTime() > ctx.now().getTime()) {
      return { outcome: "wait", wait: { kind: "timer", notBefore: freezeAt.toISOString(), code: DATA_CODES.freezeScheduled } };
    }
    await ctx.patchRun({ freezeStartedAt: ctx.now() }); // first call wins: the downtime window opens now
    const est = estimateWindowDetail(obs.snap, ctx.now(), windowExtrasOf(run, obs.snap)).estimate;
    if (!estimateEquals(run.windowEstimate, est)) await ctx.patchRun({ windowEstimate: est }); // the report compares it with the measured window
    if (obs.stop.length > 0 && obs.gap.over && !(compOf(ctx) as StepComp & { tickGapNoted?: boolean }).tickGapNoted) {
      await ctx.recordCompensation({ tickGapNoted: true });
      await ctx.emit({ stepKey: "FREEZE", level: "warn", code: TICK_GAP_CODES.attested, params: { gapMinutes: obs.gap.gapMinutes, acceptedMinutes: obs.gap.acceptedMinutes, writers: obs.stop.length } });
    }

    switch (obs.controller) {
      case "manual":
        return this.actManual(ctx, obs);
      case "api":
        return this.actApi(ctx, obs);
      case "agent":
        return hostLoopFreeze(run) ? this.actHostLoop(ctx, obs) : this.actAgent(ctx, obs);
    }
  }

  /**
   * The loop script on the Coolify host stops the writers of every source host (identity-checked, recorded on the host before the
   * first stop) and reports back. The hub tracks per-host outcomes; a stop-list item no container matched waits for the operator's
   * attestation, exactly like the same-host agent controller.
   */
  private async actHostLoop(ctx: StepContext, obs: FreezeObs): Promise<ActResult> {
    const { byHost, unplaced } = stopHostsOf(obs.stop);
    if (unplaced.length) return { outcome: "fail", code: HOST_LOOP_CODES.freezeNoHost, params: { count: unplaced.length, names: unplaced.slice(0, 20).map((u) => u.name) }, retryable: false };
    if (!obs.record) await ctx.recordCompensation({ freeze: { controller: HOST_LOOP_CONTROLLER, hosts: [...byHost.keys()] } });
    if (byHost.size === 0 || this.hostLoopQuiesced(obs).ok) return { outcome: "done" };
    const names = new Map(obs.stop.map((s) => [s.itemRef, s.name]));
    const blocked = [...obs.hosts.freeze.values()].filter((r) => r.state === "error" && r.payload.errorCode === "unresolved-items");
    const accepted = ctx.step.evidence.attestations.some((a) => a.checkId === UNRESOLVED_CHECK);
    if (blocked.length && !accepted) {
      const unresolved = blocked.flatMap((b) => b.payload.unresolved);
      await ctx.emit({ stepKey: "FREEZE", level: "warn", code: DATA_CODES.freezeContainerUnresolved, params: { count: unresolved.length, names: unresolved.slice(0, 20).map((u) => names.get(u) ?? u) } });
      return {
        outcome: "wait",
        wait: { kind: "operator", code: DATA_CODES.freezeContainerUnresolved, params: { count: unresolved.length, of: obs.stop.length, names: unresolved.slice(0, 20).map((u) => names.get(u) ?? u) }, attest: [UNRESOLVED_CHECK], offersCommand: true, commandKind: "host-loop" },
      };
    }
    const pending = [...byHost.keys()].filter((h) => obs.hosts.freeze.get(h)?.state !== "stopped");
    const failing = pending.filter((h) => ["stop-failed", "error"].includes(obs.hosts.freeze.get(h)?.state ?? ""));
    return {
      outcome: "wait",
      wait: { kind: "operator", code: HOST_LOOP_CODES.freezeRun, params: { hosts: byHost.size, pending: pending.length, failing: failing.length, names: failing.slice(0, 20), items: obs.stop.length }, offersCommand: true, commandKind: "host-loop" },
    };
  }

  private async actManual(ctx: StepContext, obs: FreezeObs): Promise<ActResult> {
    if (!obs.record) await ctx.recordCompensation({ freeze: { controller: "manual" } satisfies FreezeRecord });
    if (obs.attested || ctx.run.options.stopSource) return { outcome: "done" };
    return {
      outcome: "wait",
      wait: { kind: "operator", code: DATA_CODES.freezeManual, params: { count: obs.stop.length, names: obs.stop.slice(0, 40).map((s) => s.name) }, attest: ["source-quiesced"] },
    };
  }

  private async actApi(ctx: StepContext, obs: FreezeObs): Promise<ActResult> {
    const run = ctx.run;
    if (obs.apiAvailable !== "ok") return { outcome: "fail", code: DATA_CODES.freezeApiUnavailable, params: { reason: obs.apiAvailable ?? "unknown" }, retryable: true };
    if (obs.stop.length === 0) {
      await ctx.recordCompensation({ freeze: { controller: "api", api: [] } satisfies FreezeRecord });
      return { outcome: "done" };
    }
    let record = obs.record;
    if (!record) {
      // record only what is running NOW: a resource the owner had stopped on purpose is never started again by an abort
      const running: NonNullable<FreezeRecord["api"]> = [];
      for (const s of obs.stop) {
        await ctx.assertLease();
        const cur = await this.api.state(run, s.kind, s.uuid);
        if (!cur.ok) return { outcome: "fail", code: DATA_CODES.freezeApiFailed, params: { reason: cur.reason, itemRef: s.itemRef }, retryable: cur.reason !== "forbidden" && cur.reason !== "unauthorized" };
        if (cur.state !== "stopped") running.push({ kind: s.kind, uuid: s.uuid, itemRef: s.itemRef });
      }
      record = { controller: "api", api: running };
      await ctx.recordCompensation({ freeze: record }); // BEFORE the first stop: a crash can still restart them
      if (running.length === 0) return { outcome: "done" };
    }
    if (obs.states && obs.states.running === 0 && obs.states.unknown === 0) return { outcome: "done" };
    // an explicit retry opens a fresh confirmation window (and sends the stops again): otherwise the first timeout is final
    const startedAt = ctx.trigger === "retry" ? undefined : compOf(ctx).stopRequestedAt;
    if (startedAt && ctx.now().getTime() - new Date(startedAt).getTime() > STOP_CONFIRM_TIMEOUT_MS) {
      return { outcome: "fail", code: DATA_CODES.freezeStillRunning, params: { remaining: (obs.states?.running ?? 0) + (obs.states?.unknown ?? 0) }, retryable: true };
    }
    for (const it of record.api ?? []) {
      await ctx.assertLease();
      const cur = await this.api.state(run, it.kind, it.uuid);
      if (cur.ok && cur.state === "stopped") continue;
      // idempotent on Coolify 4.7 (an already-stopped database/service answers 400, which the client maps to success); sent without docker cleanup
      const res = await this.api.stop(run, it.kind, it.uuid);
      if (!res.ok) return { outcome: "fail", code: DATA_CODES.freezeApiFailed, params: { reason: res.reason, itemRef: it.itemRef }, retryable: res.reason !== "forbidden" && res.reason !== "unauthorized" };
    }
    if (!startedAt) await ctx.recordCompensation({ stopRequestedAt: ctx.now().toISOString() });
    return { outcome: "continue", pollAfterMs: 5_000 }; // the next tick verifies the state back from the API
  }

  private async actAgent(ctx: StepContext, obs: FreezeObs): Promise<ActResult> {
    const run = ctx.run;
    const runner = agentRunnerHost(run);
    if (!runner.ok) return { outcome: "fail", code: runner.code, retryable: false };
    const granted = await this.caps.ensureMigrate(ctx.actor.userId, runner.serverId);
    if (!granted.ok) return { outcome: "fail", code: granted.reason === "forbidden" ? DATA_CODES.capabilityDenied : DATA_CODES.capabilityMissingTarget, retryable: false };
    if (granted.added) await ctx.recordCompensation({ capAdded: true });
    try {
      let record = obs.record;
      if (!record) {
        // 1. discover + record identity (only what is RUNNING now: a container that was already stopped is never started again)
        const targets = obs.stop.map((s) => ({ itemRef: s.itemRef, ...(s.containerPrefix ? { containerPrefix: s.containerPrefix } : {}) }));
        const res = await this.host.run(runner.serverId, buildSourceInspectScript(targets), "migrate", SCRIPT_TIMEOUT_MS);
        const found = parseSourceInspect(res.output, targets);
        const running: RecordedContainer[] = found.filter((c) => c.state === "running").map((c) => ({ id: c.id, name: c.name, image: c.image, ports: c.ports, itemRef: c.itemRef }));
        const unresolved = obs.stop.filter((s) => !found.some((c) => c.itemRef === s.itemRef));
        if (unresolved.length) {
          // fail closed: a stop-list item no container matched may still be writing under a name this matcher does not know.
          // Nothing is stopped or recorded until the operator, who can look at the host, accepts exactly that (an attestation).
          const accepted = ctx.step.evidence.attestations.some((a) => a.checkId === UNRESOLVED_CHECK);
          await ctx.emit({ stepKey: "FREEZE", level: "warn", code: DATA_CODES.freezeContainerUnresolved, params: { count: unresolved.length, names: unresolved.slice(0, 20).map((u) => u.name) } });
          if (!accepted) {
            return { outcome: "wait", wait: { kind: "operator", code: DATA_CODES.freezeContainerUnresolved, params: { count: unresolved.length, of: obs.stop.length, names: unresolved.slice(0, 20).map((u) => u.name) }, attest: [UNRESOLVED_CHECK] } };
          }
        }
        record = { controller: "agent", containers: running, ...(unresolved.length ? { unresolved: unresolved.slice(0, 200).map((u) => u.name) } : {}) };
        await ctx.recordCompensation({ freeze: record }); // BEFORE the first stop
      }
      const containers = record.containers ?? [];
      if (containers.length === 0) return { outcome: "done" };
      if (obs.states && obs.states.running === 0 && obs.states.unknown === 0) return { outcome: "done" };
      await ctx.assertLease();
      const stop = await this.host.run(runner.serverId, buildSourceStopScript(containers), "migrate", SCRIPT_TIMEOUT_MS);
      const outcomes = parseStopOutput(stop.output, containers.map((c) => c.id));
      const bad = containers.filter((c) => {
        const o = outcomes.get(c.id);
        return o !== "stopped" && o !== "gone";
      });
      if (bad.length) {
        const mismatch = bad.some((c) => outcomes.get(c.id) === "mismatch");
        return { outcome: "fail", code: mismatch ? DATA_CODES.freezeContainerMismatch : DATA_CODES.freezeAgentFailed, params: { count: bad.length, names: bad.slice(0, 10).map((c) => c.name) }, retryable: true };
      }
      await ctx.emit({ stepKey: "FREEZE", level: "info", code: "freeze.agent-stopped", params: { count: containers.length } });
      return { outcome: "done" };
    } catch (e) {
      if (e instanceof RunLeaseLostError) throw e;
      const kind = classifyAgentError(e);
      return { outcome: "fail", code: kind === "offline" ? DATA_CODES.agentOffline : kind === "forbidden" ? DATA_CODES.capabilityDenied : DATA_CODES.freezeAgentFailed, params: { reason: kind }, retryable: true };
    }
  }

  // ───────────────────────────── compensate ─────────────────────────────

  /** The source hosts of a host-loop freeze that may still hold writers this run stopped (see `compensate`). */
  private async hostsToUnfreeze(ctx: StepContext, rec: HostLoopFreezeRecord): Promise<string[]> {
    const named = new Set<string>(rec.hosts ?? []);
    try {
      const { byHost } = stopHostsOf(buildStopList(await this.data.snapshot(ctx.run)));
      for (const h of byHost.keys()) named.add(h);
    } catch {
      // the record already names the hosts the freeze was started for
    }
    let view: HostView | null = null;
    try {
      view = await loadHostView(this.reports, ctx.run.id);
    } catch {
      view = null; // unreadable: every host the freeze was started for stays named
    }
    if (view) for (const h of view.freeze.keys()) named.add(h);
    const out: string[] = [];
    for (const h of [...named].sort()) {
      const rep = view?.freeze.get(h);
      if (!rep) out.push(h); // no report (or none readable): the script may well have stopped containers
      else if (rep.state === "restarted") continue;
      else if (rep.payload.recorded.length > 0 || rep.payload.outcome === null) out.push(h);
    }
    return out;
  }

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort") return { outcome: "nothing-to-do" };
    const rec = compOf(ctx).freeze as FreezeRecord | undefined;
    if (!rec) return { outcome: "nothing-to-do" };
    const run = ctx.run;
    if ((rec.controller as string) === HOST_LOOP_CONTROLLER) {
      // The hub cannot start a container on a source host itself: name the hosts that may still have writers stopped by this run, so
      // the operator runs the tokenless unfreeze script (it starts exactly the recorded, identity-checked containers). A host is
      // named unless its report PROVES it needs nothing (restarted, or a finished script that recorded nothing to stop): a report
      // that never arrived (the post is best effort), a read that failed or a half report all leave the host named.
      const hosts = await this.hostsToUnfreeze(ctx, rec as unknown as HostLoopFreezeRecord);
      return hosts.length ? { outcome: "manual", manual: [{ code: HOST_LOOP_CODES.freezeUnfreeze, params: { hosts: hosts.slice(0, 20), count: hosts.length } }] } : { outcome: "nothing-to-do" };
    }
    if (rec.controller === "manual") {
      return { outcome: "manual", manual: [{ code: DATA_CODES.freezeRestartManual, params: { controller: "manual" } }] };
    }
    if (rec.controller === "api") {
      const failed: string[] = [];
      for (const it of rec.api ?? []) {
        // an application "start" is a Coolify deploy (it queues a rebuild); an already-running database/service answers 400, which the client maps to success
        const res = await this.api.start(run, it.kind, it.uuid);
        if (!res.ok) failed.push(it.itemRef);
      }
      return failed.length ? { outcome: "failed", code: DATA_CODES.freezeRestartFailed, params: { count: failed.length, items: failed.slice(0, 20) } } : { outcome: "done" };
    }
    const containers = rec.containers ?? [];
    if (containers.length === 0) return { outcome: "nothing-to-do" };
    const runner = agentRunnerHost(run);
    if (!runner.ok) return { outcome: "failed", code: runner.code };
    try {
      const granted = await this.caps.ensureMigrate(ctx.actor.userId, runner.serverId);
      if (!granted.ok) return { outcome: "failed", code: DATA_CODES.capabilityDenied };
      if (granted.added) await ctx.recordCompensation({ capAdded: true });
      let res: { exitCode: number; output: string };
      try {
        res = await this.host.run(runner.serverId, buildSourceStartScript(containers), "migrate", SCRIPT_TIMEOUT_MS);
      } finally {
        await releaseIfOurs(ctx, this.caps, granted.added); // least privilege: the grant ends with the restart
      }
      const out = parseStartOutput(res.output, containers.map((c) => c.id));
      const failed = containers.filter((c) => out.get(c.id) === "failed");
      const manual = containers.filter((c) => out.get(c.id) === "gone" || out.get(c.id) === "mismatch" || !out.has(c.id));
      if (failed.length) return { outcome: "failed", code: DATA_CODES.freezeRestartFailed, params: { count: failed.length, names: failed.slice(0, 10).map((c) => c.name) } };
      if (manual.length) return { outcome: "manual", manual: [{ code: DATA_CODES.freezeRestartManual, params: { controller: "agent", names: manual.slice(0, 20).map((c) => c.name) } }] };
      return { outcome: "done" };
    } catch {
      return { outcome: "failed", code: DATA_CODES.freezeRestartFailed };
    }
  }
}
