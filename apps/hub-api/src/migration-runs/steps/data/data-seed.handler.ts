import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  RunLeaseLostError,
  STEP_HANDLERS,
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
import { dbsNeedingMeasure, decideLanes, estimateEquals, estimateWindow, hasLiveTransfer, migratorFlags, objectIsActive, seedChecks } from "./data-logic";
import { compOf, gateFrom, loadObjects, loadSnapshot, takeObjectStart } from "./handler-util";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import type { LauncherStatus } from "./launcher/migrator-launcher";

export interface SeedObs extends Observation {
  snap: DataSnapshot;
  objects: ObjectView[];
  missingObjects: string[];
  launcher: LauncherStatus | null;
}

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
    const est = estimateWindow(snap, ctx.now());
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
      else items.push({ code: "data-seed.dry.volume", level: "info", subject: v.itemRef, params: { rawBytes: v.inventory.rawBytes, entries: v.inventory.entries } });
    }
    items.push({ code: DATA_CODES.seedEstimate, level: est.freezeToFlipSec === null ? "unknown" : "info", params: { seconds: est.freezeToFlipSec } });
    return items;
  }

  async observe(ctx: StepContext): Promise<SeedObs> {
    const snap = await loadSnapshot(this.data, ctx);
    const { views, missing } = await loadObjects(this.objects, ctx);
    const launcher = MigratorRunner.available(ctx.run) ? await this.runner.status(ctx.run, compOf(ctx).launch) : null;
    const inspected = snap.volumes.filter((v) => !v.excluded && v.inventory).length;
    const total = snap.volumes.filter((v) => !v.excluded).length;
    return { snap, objects: views, missingObjects: missing, launcher, progress: { done: inspected, total, unit: "volume" } };
  }

  private checks(ctx: StepContext, obs: SeedObs): GateCheck[] {
    const checks = seedChecks(ctx.run, obs.snap, obs.objects);
    for (const id of obs.missingObjects) checks.push({ id: `object-gone:${id.slice(0, 40)}`, status: "fail", code: DATA_CODES.seedObjectGone, subject: id });
    return checks;
  }

  preGate(ctx: StepContext, obs: SeedObs): GateResult {
    return gateFrom(this.checks(ctx, obs).filter((c) => STRUCTURAL.has(c.id)));
  }

  postGate(ctx: StepContext, obs: SeedObs): GateResult {
    return gateFrom(this.checks(ctx, obs));
  }

  async act(ctx: StepContext, obs: SeedObs): Promise<ActResult> {
    const run = ctx.run;
    const snap = obs.snap;
    // the downtime estimate feeds the FREEZE approval and the final report; refresh it whenever the facts changed
    const est = estimateWindow(snap, ctx.now());
    if (!estimateEquals(run.windowEstimate, est)) await ctx.patchRun({ windowEstimate: est });

    if (obs.missingObjects.length) return { outcome: "fail", code: DATA_CODES.seedObjectGone, params: { count: obs.missingObjects.length }, retryable: false };

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
      return {
        outcome: "wait",
        wait: { kind: "operator", code: DATA_CODES.runMigrator, params: { phase, flags, pending: snap.volumes.filter((v) => !v.excluded && !v.inventory).length, hubTokenActive: snap.tokenActive }, offersCommand: true },
      };
    }

    if (objectsBusy || hasLiveTransfer(snap)) return { outcome: "continue", pollAfterMs: 10_000 };

    // nothing left to run: either the gate passes now, or something the operator must fix is blocking
    const gate = this.postGate(ctx, obs);
    if (gate.passed) return { outcome: "done" };
    const firstBad = gate.checks.find((c) => c.status === "fail") ?? gate.checks.find((c) => c.status === "unknown");
    return { outcome: "wait", wait: { kind: "operator", code: firstBad?.code ?? DATA_CODES.seedVolumeNotInspected, params: { failing: gate.checks.filter((c) => c.status === "fail" || c.status === "unknown").length } } };
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
    return failed ? { outcome: "failed", code: "data-seed.abort-incomplete" } : { outcome: "done" };
  }
}
