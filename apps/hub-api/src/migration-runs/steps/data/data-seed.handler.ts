import { Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  RunLeaseLostError,
  STEP_HANDLERS,
  hostLoopOf,
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
import { DATA_CODES, DATA_PORT, OBJECT_PORT, type DataPort, type DataSnapshot, type ObjectPort, type ObjectView } from "./data-contract";
import { checkKey, dbsNeedingMeasure, decideLanes, estimateEquals, estimateWindow, hasLiveTransfer, migratorFlags, objectIsActive, seedChecks, windowExtrasOf } from "./data-logic";
import { compOf, gateFrom, loadObjects, loadSnapshot, takeObjectStart, type StepComp } from "./handler-util";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { OBJECT_PLAN_ID, objectPlanChecks } from "./object-plan-check";
import type { LauncherStatus } from "./launcher/migrator-launcher";
import { vxPartRawBytes } from "../../../importer/volume-stream/vx-constants";
import { attestableFindings, carryDecisions, crossCheckChecks } from "./inventory/cross-check";
import { HOST_LOOP_CODES } from "./inventory/host-codes";
import { containerPrefixesOfSnapshot, dataItemsOfHost, planRefsOf, sourceHostsOf } from "./inventory/host-hosts";
import { loopVerdict } from "./inventory/host-protocol";
import { loadHostView, loopByHost, type HostView } from "./inventory/host-view";
import { HOST_REPORT_PORT, type HostReportPort } from "./inventory/inventory-contract";

export interface SeedObs extends Observation {
  snap: DataSnapshot;
  objects: ObjectView[];
  missingObjects: string[];
  launcher: LauncherStatus | null;
  /** The stored reports of the host-loop runner and the host inventory (empty when none arrived). */
  hosts: HostView;
}

/** Loop states after which no migrator of the host can still be running (the host was never reached, or the migrator ended). */
const SETTLED_LOOP_STATES = ["finished", "failed", "died", "unreachable", "no-key", "no-host", "no-items"] as const;

/** Checks that are preconditions of acting at all (the rest are the step's outcome). */
const STRUCTURAL = new Set(["vx-disabled", "agent-same-host"]);

/**
 * DATA_SEED (operator, skippable): the non-disruptive rehearsal. It inspects every in-scope source volume with the
 * migrator's `--dry-run` (sizes, running state, the Postgres image/major/layout, the target's free space), optionally warms
 * the database dumps, seeds attached object migrations (`mc mirror`, run by the target agent) and records the downtime
 * window estimate that feeds the FREEZE approval. Nothing here stops the source or moves a byte of volume data.
 */
@Injectable()
export class DataSeedHandler implements StepHandler<SeedObs>, OnModuleInit {
  readonly key = "DATA_SEED" as const;
  readonly kind = "operator" as const;
  readonly rollback = "UNDOABLE" as const;
  readonly skippable = true;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(DATA_PORT) private readonly data: DataPort,
    @Inject(OBJECT_PORT) private readonly objects: ObjectPort,
    private readonly runner: MigratorRunner,
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
    const items: DryRunItem[] = [
      { code: "data-seed.dry.plan", level: "info", params: { runner: run.options.sourceRunner, warmDbSeed: run.options.warmDbSeed, flags: migratorFlags("inspect", run) } },
    ];
    if (run.options.sourceRunner === "agent" && run.topology !== "swap-proxy") items.push({ code: DATA_CODES.agentNeedsSameHost, level: "block" });
    if (!run.opId) return items; // no import yet: nothing to project from
    const snap = await loadSnapshot(this.data, ctx);
    const est = estimateWindow(snap, ctx.now(), windowExtrasOf(run, snap));
    if (run.options.sourceRunner === "coolify-host-loop") {
      const hosts = sourceHostsOf(run, snap);
      items.push(hosts.length ? { code: HOST_LOOP_CODES.dryPlan, level: "info", params: { hosts: hosts.length, keyDir: hostLoopOf(run.options).keyDir, parallel: hostLoopOf(run.options).parallel } } : { code: HOST_LOOP_CODES.noHosts, level: "block" });
    }
    // the docker-vs-API cross-check, as the dry-run sees it (a run with no inventory yet reports nothing until the host-loop runner needs it)
    const view = await loadHostView(this.reports, run.id);
    for (const c of this.hostChecks(ctx, snap, view)) {
      if (c.status === "pass") continue;
      items.push({ code: c.code, level: c.status === "fail" ? "block" : c.status === "warn" ? "warn" : "unknown", ...(c.subject ? { subject: c.subject } : {}), ...(c.params ? { params: c.params } : {}) });
    }
    for (const [ref, dec] of decideLanes(run, snap)) {
      if (dec.reason === "engine-no-lane") continue;
      items.push({
        code: "data-seed.dry.db-lane",
        level: dec.lane === "blocked" ? "block" : dec.lane === "pending" ? "unknown" : "info",
        subject: ref,
        params: { lane: dec.lane, reason: dec.reason, dumpBytes: dec.dumpBytes, counted: dec.counted },
      });
    }
    for (const v of snap.volumes) {
      if (v.excluded) items.push({ code: DATA_CODES.seedVolumeExcluded, level: "warn", subject: v.itemRef });
      else if (!v.inventory) items.push({ code: DATA_CODES.seedVolumeNotInspected, level: "unknown", subject: v.itemRef });
      else if (!v.inventory.found) items.push({ code: DATA_CODES.seedVolumeMissing, level: "block", subject: v.itemRef });
      else items.push({ code: "data-seed.dry.volume", level: "info", subject: v.itemRef, params: { rawBytes: v.inventory.rawBytes, entries: v.inventory.entries, running: v.inventory.running } });
    }
    for (const c of objectPlanChecks(run, snap, (await loadObjects(this.objects, ctx)).views)) {
      items.push({ code: c.code, level: c.status === "fail" ? "block" : c.status === "warn" ? "warn" : "info", ...(c.params ? { params: c.params } : {}) });
    }
    items.push({ code: DATA_CODES.seedEstimate, level: est.freezeToFlipSec === null ? "unknown" : "info", params: { seconds: est.freezeToFlipSec } });
    return items;
  }

  async observe(ctx: StepContext): Promise<SeedObs> {
    const snap = await loadSnapshot(this.data, ctx);
    const { views, missing } = await loadObjects(this.objects, ctx);
    const launcher = MigratorRunner.available(ctx.run) ? await this.runner.status(ctx.run, compOf(ctx).launch) : null;
    const hosts = await loadHostView(this.reports, ctx.run.id);
    const inspected = snap.volumes.filter((v) => !v.excluded && v.inventory).length;
    const total = snap.volumes.filter((v) => !v.excluded).length;
    return { snap, objects: views, missingObjects: missing, launcher, hosts, progress: { done: inspected, total, unit: "volume" } };
  }

  private checks(ctx: StepContext, obs: SeedObs): GateCheck[] {
    const checks = seedChecks(ctx.run, obs.snap, obs.objects);
    for (const id of obs.missingObjects) checks.push({ id: `object-gone:${id.slice(0, 40)}`, status: "fail", code: DATA_CODES.seedObjectGone, subject: id });
    checks.push(...objectPlanChecks(ctx.run, obs.snap, obs.objects));
    checks.push(...this.hostChecks(ctx, obs.snap, obs.hosts));
    return checks;
  }

  /**
   * The host-loop runner's per-host verdicts and the docker-vs-API inventory cross-check (R2/C6, R6/C19, R8, R14), plus the
   * running-source advisory (C8). Evidence is `host-loop-reported`: measured by the script, carried back by the operator.
   */
  private hostChecks(ctx: StepContext, snap: DataSnapshot, view: HostView): GateCheck[] {
    const run = ctx.run;
    const isLoop = run.options.sourceRunner === "coolify-host-loop";
    const hosts = isLoop ? sourceHostsOf(run, snap) : [];
    const checks: GateCheck[] = [];
    if (isLoop) {
      const loop = loopByHost(view, "DATA_SEED");
      for (const ref of hosts) {
        if (dataItemsOfHost(ref, snap).length === 0) continue;
        const st = loop.get(ref);
        if (!st) continue; // never reported: the volumes' own `not inspected` checks say so
        const v = loopVerdict(st);
        checks.push({
          id: checkKey("host-loop", ref),
          status: v === "ok" ? "pass" : v === "bad" ? "fail" : "unknown",
          code: v === "ok" ? HOST_LOOP_CODES.hostOk : v === "bad" ? HOST_LOOP_CODES.hostFailed : HOST_LOOP_CODES.hostPending,
          subject: ref,
          params: { host: ref, state: st.state, code: st.code },
          evidence: "host-loop-reported",
        });
      }
    }
    checks.push(
      ...crossCheckChecks({
        hosts,
        required: isLoop,
        inventories: view.inventories,
        reach: view.reach,
        planRefs: planRefsOf(snap),
        containerPrefixes: containerPrefixesOfSnapshot(snap),
        unlistedDbPolicy: resolveOwnerInput(run.inputs, "unlistedDbPolicy") ?? "block",
        orphanVolumePolicy: resolveOwnerInput(run.inputs, "orphanVolumePolicy") ?? "block",
        attestations: ctx.step.evidence.attestations,
        currentPartMiB: Math.round(vxPartRawBytes() / (1024 * 1024)),
      }),
    );
    // C8: running sources are the normal case on a live fleet. Without `stopSource` (the migrator stops the one source container of
    // each copy) or a stopped writer, DATA_FINAL would skip them ("volume-skipped-running"): say so now, while it is cheap to fix.
    const controller = resolveOwnerInput(run.inputs, "sourceController") ?? "manual";
    if (!run.options.stopSource && controller === "manual") {
      const running = snap.volumes.filter((v) => !v.excluded && v.inventory?.found && v.inventory.running);
      if (running.length) checks.push({ id: "source-running", status: "warn", code: HOST_LOOP_CODES.sourceRunning, params: { count: running.length, names: running.slice(0, 20).map((v) => v.ownerName ?? v.itemRef) }, evidence: "migrator-reported" });
    }
    return checks;
  }

  /**
   * The structural preconditions, plus every BLOCKING docker-vs-API finding (R2/C6): the engine stores the pre-gate of a parked
   * step, so the panel can only offer an attestation row per finding (`attestable`, with the finding's own subject) when the
   * finding is part of this gate. A finding therefore parks the step BEFORE the migrator is launched, which is also the right
   * order: an unlisted database must be decided before data moves.
   */
  preGate(ctx: StepContext, obs: SeedObs): GateResult {
    const all = this.checks(ctx, obs);
    const findings = all.filter((c) => c.status === "fail" && (c.attestable?.length ?? 0) > 0);
    // object storage in the plan with its data unaccounted for (R33) is settled before anything is launched or moved
    const objectPlan = all.filter((c) => c.id === OBJECT_PLAN_ID && c.status === "fail");
    const gate = gateFrom([...all.filter((c) => STRUCTURAL.has(c.id)), ...objectPlan, ...findings]);
    if (gate.passed || findings.length === 0) return gate;
    const first = findings[0];
    const attest = attestableFindings(findings);
    return { ...gate, wait: { kind: "operator", code: first.code, params: { failing: findings.length, ...(first.params ?? {}) }, attest } };
  }

  postGate(ctx: StepContext, obs: SeedObs): GateResult {
    return gateFrom(this.checks(ctx, obs));
  }

  async act(ctx: StepContext, obs: SeedObs): Promise<ActResult> {
    const run = ctx.run;
    const snap = obs.snap;
    // the downtime estimate feeds the FREEZE approval and the final report; refresh it whenever the facts changed
    const est = estimateWindow(snap, ctx.now(), windowExtrasOf(run, snap));
    if (!estimateEquals(run.windowEstimate, est)) await ctx.patchRun({ windowEstimate: est });

    if (obs.missingObjects.length) return { outcome: "fail", code: DATA_CODES.seedObjectGone, params: { count: obs.missingObjects.length }, retryable: false };

    // R2: under `unlistedDbPolicy: carry` every database container the inventory proved carryable (and no operator settled) is bound to a
    // NEW database plan item BEFORE any data moves, so the normal database lane copies it and the env remap finds its new host. A container
    // that cannot be carried in full never gets here: its gate check failed with the reason and the step is parked on it.
    const carry = carryDecisions({
      inventories: obs.hosts.inventories,
      planRefs: planRefsOf(snap),
      containerPrefixes: containerPrefixesOfSnapshot(snap),
      unlistedDbPolicy: resolveOwnerInput(run.inputs, "unlistedDbPolicy") ?? "block",
      attestations: ctx.step.evidence.attestations,
    });
    if (carry.length) {
      let failed = 0;
      for (const spec of carry) {
        await ctx.assertLease();
        try {
          const res = await this.data.carryUnlistedDb(run, spec, ctx.targetFor(spec.host === "_" ? null : spec.host));
          // an item that already existed while the container is still a finding does not account for it: stop instead of looping
          if (!res.created) {
            failed++;
            continue;
          }
          await ctx.emit({ stepKey: "DATA_SEED", level: "info", code: "data-seed.db-carried", params: { engine: spec.engine, container: spec.container, host: spec.host, name: spec.name } });
        } catch (e) {
          if (e instanceof RunLeaseLostError) throw e;
          failed++;
        }
      }
      if (failed) return { outcome: "fail", code: DATA_CODES.seedCarryFailed, params: { count: failed }, retryable: true };
      return { outcome: "continue", pollAfterMs: 1_000 }; // re-read the world: the carried databases are items now
    }

    // per-database lane: a database whose measured DUMP is over the artifact cap (or whose physical copy cannot run) goes on the
    // streamed dump lane when the owner allowed it. The decision is a pure function of what the migrator measured; this only applies it.
    let switched = 0;
    for (const [ref, dec] of decideLanes(run, snap)) {
      const d = snap.databases.find((x) => x.itemRef === ref);
      if (!d || dec.lane !== "stream" || d.plane === "stream") continue;
      await ctx.assertLease();
      if (!(await this.data.enableStream(run, ref, true))) return { outcome: "fail", code: DATA_CODES.seedDbStreamUnavailable, params: { engine: d.engine }, retryable: true };
      switched++;
      await ctx.emit({ stepKey: "DATA_SEED", level: "info", code: "data-seed.db-stream-enabled", params: { engine: d.engine, reason: dec.reason, dumpBytes: dec.dumpBytes, counted: dec.counted } });
    }
    if (switched > 0) return { outcome: "continue", pollAfterMs: 1_000 }; // re-read the world: the database now has a dump row

    // (b) object seed pass: auto, run by the target agent
    let objectsBusy = false;
    for (const o of obs.objects) {
      if (objectIsActive(o)) {
        objectsBusy = true;
        continue;
      }
      if (o.blockers > 0) continue; // surfaced by the gate; the operator fixes the migration
      const selected = o.buckets.filter((b) => b.selected);
      const needsSeed = selected.length > 0 && selected.some((b) => !["SEEDED", "FINAL", "VERIFIED", "DIFFERS"].includes(b.status));
      if (needsSeed && ["PREFLIGHTED", "SEEDED", "FAILED"].includes(o.status) && (await takeObjectStart(ctx, o.id))) {
        try {
          await ctx.assertLease();
          await this.objects.startSeed(ctx.actor.userId, o.id);
          objectsBusy = true;
        } catch (e) {
          if (e instanceof RunLeaseLostError) throw e;
          return { outcome: "fail", code: DATA_CODES.seedObjectStartRejected, params: { status: o.status }, retryable: true };
        }
      }
    }

    // the host-loop runner: the host inventory comes FIRST (R2/C6: an unlisted database must be seen before any data is moved), and
    // a run whose plan names no source host cannot loop at all
    const isLoop = run.options.sourceRunner === "coolify-host-loop";
    const loopHosts = isLoop ? sourceHostsOf(run, snap) : [];
    if (isLoop) {
      if (loopHosts.length === 0) return { outcome: "fail", code: HOST_LOOP_CODES.noHosts, retryable: false };
      const missing = loopHosts.filter((h) => !obs.hosts.inventories.get(h)?.complete);
      if (missing.length) {
        const failing = [...loopByHost(obs.hosts, "INVENTORY").values()].filter((l) => loopVerdict(l) === "bad").map((l) => l.ref);
        return {
          outcome: "wait",
          wait: { kind: "operator", code: HOST_LOOP_CODES.inventoryRun, params: { hosts: loopHosts.length, missing: missing.length, failing: failing.length, names: failing.slice(0, 20) }, offersCommand: true, commandKind: "inventory" },
        };
      }
    }

    // (a)+(c) migrator work: inspect every volume, then (optionally) warm the database dumps
    const needInspect = snap.volumes.some((v) => !v.excluded && (!v.inventory || !v.disk || v.disk.unknown)) || dbsNeedingMeasure(run, snap, ctx.trigger === "retry").length > 0;
    const needWarm = run.options.warmDbSeed && snap.databases.some((d) => d.plane === "logical" && d.task !== "done");
    if (needInspect || needWarm) {
      const phase = needInspect ? "inspect" : "warm-db";
      const flags = migratorFlags(phase, run, snap);
      if (MigratorRunner.available(run)) {
        const st = obs.launcher;
        if (st?.state === "running") return { outcome: "continue", pollAfterMs: 5_000 };
        if (st?.state === "finished" && compOf(ctx).launch?.phase === phase && st.rc !== 0 && st.rc !== 1 && ctx.trigger !== "retry") {
          return { outcome: "fail", code: DATA_CODES.finalMigratorExit, params: { exit: st.rc, phase }, retryable: true };
        }
        const launched = await this.runner.launch(ctx, phase, snap);
        if (!launched.ok) return { outcome: "fail", code: launched.code, params: launched.params, retryable: launched.retryable };
        await ctx.emit({ stepKey: "DATA_SEED", level: "info", code: "data-seed.migrator-launched", params: { phase } });
        return { outcome: "continue", pollAfterMs: 5_000 };
      }
      const pending = snap.volumes.filter((v) => !v.excluded && !v.inventory).length;
      const attest = attestableFindings(this.hostChecks(ctx, snap, obs.hosts));
      if (isLoop) {
        // one script on the Coolify host runs the migrator on every source host; a host that failed is named so a re-run (which resumes) can fix it
        const loop = loopByHost(obs.hosts, "DATA_SEED");
        const bad = loopHosts.filter((h) => dataItemsOfHost(h, snap).length > 0 && loopVerdict(loop.get(h) ?? null) === "bad");
        // BEFORE the operator can run the script: an abort must know which hosts it may have started a migrator on
        const offered = loopHosts.filter((h) => dataItemsOfHost(h, snap).length > 0);
        const known = (compOf(ctx) as StepComp & { loopHosts?: string[] }).loopHosts ?? [];
        if (offered.some((h) => !known.includes(h))) await ctx.recordCompensation({ loopHosts: [...new Set([...known, ...offered])].sort() });
        return {
          outcome: "wait",
          wait: {
            kind: "operator",
            code: bad.length ? HOST_LOOP_CODES.seedHostFailed : HOST_LOOP_CODES.seedRun,
            params: { phase, flags, pending, hosts: loopHosts.filter((h) => dataItemsOfHost(h, snap).length > 0).length, failing: bad.length, names: bad.slice(0, 20), hubTokenActive: snap.tokenActive },
            offersCommand: true,
            commandKind: "host-loop",
            ...(attest.length ? { attest } : {}),
          },
        };
      }
      return {
        outcome: "wait",
        wait: { kind: "operator", code: DATA_CODES.runMigrator, params: { phase, flags, pending, hubTokenActive: snap.tokenActive }, offersCommand: true, ...(attest.length ? { attest } : {}) },
      };
    }

    if (objectsBusy || hasLiveTransfer(snap)) return { outcome: "continue", pollAfterMs: 10_000 };

    // nothing left to run: either the gate passes now, or something the operator must fix is blocking
    const gate = this.postGate(ctx, obs);
    if (gate.passed) return { outcome: "done" };
    const firstBad = gate.checks.find((c) => c.status === "fail") ?? gate.checks.find((c) => c.status === "unknown");
    const attest = attestableFindings(gate.checks);
    return { outcome: "wait", wait: { kind: "operator", code: firstBad?.code ?? DATA_CODES.seedVolumeNotInspected, params: { failing: gate.checks.filter((c) => c.status === "fail" || c.status === "unknown").length }, ...(attest.length ? { attest } : {}) } };
  }

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort") return { outcome: "nothing-to-do" };
    const run = ctx.run;
    if (!run.opId) return { outcome: "nothing-to-do" };
    let failed = false;
    // stop a launched migrator (same-host), cancel running object migrations, abort live transfers, revoke the token
    if (MigratorRunner.available(run) && compOf(ctx).launch) failed = !(await this.runner.stop(ctx)) || failed;
    try {
      const { views } = await loadObjects(this.objects, ctx);
      for (const o of views) if (objectIsActive(o)) await this.objects.cancel(ctx.actor.userId, o.id);
    } catch {
      failed = true;
    }
    try {
      const snap = await this.data.snapshot(run);
      const live = snap.volumes.filter((v) => ["PENDING", "COPYING", "FAILED"].includes(v.state)).map((v) => v.itemRef);
      if (live.length) await this.data.abortTransfers(run, live);
    } catch {
      failed = true;
    }
    try {
      await this.data.revokeToken(run);
    } catch {
      failed = true;
    }
    if (failed) return { outcome: "failed", code: "data-seed.abort-incomplete" };
    if (run.options.sourceRunner === "coolify-host-loop") {
      // the hub cannot stop a migrator it did not start: with the token revoked it fails at its next hub call, but a container on a
      // source host keeps running until then. Name every host the script was offered for unless its report PROVES the migrator is over
      // (the post is best effort: a host whose report never arrived, or a view that cannot be read, stays named).
      const offered = (compOf(ctx) as StepComp & { loopHosts?: string[] }).loopHosts ?? [];
      if (offered.length) {
        let loop = new Map<string, { state: string }>();
        try {
          loop = loopByHost(await loadHostView(this.reports, run.id), "DATA_SEED");
        } catch {
          loop = new Map();
        }
        const live = offered.filter((h) => {
          const st = loop.get(h);
          return !st || !SETTLED_LOOP_STATES.includes(st.state as never);
        });
        if (live.length) return { outcome: "manual", manual: [{ code: HOST_LOOP_CODES.stopMigrators, params: { hosts: live.slice(0, 20), count: live.length } }] };
      }
    }
    return { outcome: "done" };
  }
}
