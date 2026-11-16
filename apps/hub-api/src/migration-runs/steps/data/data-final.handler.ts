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
import { CAPABILITY_PORT, DATA_CODES, DATA_PORT, OBJECT_PORT, type CapabilityPort, type DataPort, type DataSnapshot, type ObjectPort, type ObjectView } from "./data-contract";
import { finalChecks, hasLiveTransfer, migratorFlags, migratorWorkRemains, objectIsActive } from "./data-logic";
import { compOf, gateFrom, loadObjects, loadSnapshot, releaseIfOurs } from "./handler-util";
import type { LauncherStatus } from "./launcher/migrator-launcher";
import { MigratorRunner } from "./launcher/migrator-runner.service";

export interface FinalObs extends Observation {
  snap: DataSnapshot;
  objects: ObjectView[];
  missingObjects: string[];
  launcher: LauncherStatus | null;
  wrapped: boolean;
  frozen: boolean;
}

const FINAL_OR_BETTER = new Set(["FINAL", "VERIFIED", "DIFFERS"]);

/**
 * DATA_FINAL (operator or automatic): the data move proper, run with the source quiesced by FREEZE.
 *
 * The migrator is run with `--arms all --resync --verify` (`--stop-source` / `--allow-bind` / `--certs` per the run's options):
 * logical database dumps are restored over any warm seed, volumes stream in resumable parts, and the migrator reports the
 * SOURCE side of DB parity. Attached object migrations run their final pass (the hub tells them the writers are frozen: it
 * knows, because FREEZE passed) and are then verified with a diff. The step passes only when EVERY in-scope thing is
 * accounted for; on the way out it wraps up (token revoked, capability released) so nothing stays armed.
 */
@Injectable()
export class DataFinalHandler implements StepHandler<FinalObs>, OnModuleInit {
  readonly key = "DATA_FINAL" as const;
  readonly kind = "operator" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(DATA_PORT) private readonly data: DataPort,
    @Inject(OBJECT_PORT) private readonly objects: ObjectPort,
    @Inject(CAPABILITY_PORT) private readonly caps: CapabilityPort,
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
    const items: DryRunItem[] = [{ code: "data-final.dry.plan", level: "info", params: { runner: run.options.sourceRunner, flags: migratorFlags("final", run), stopSource: run.options.stopSource } }];
    if (run.options.sourceRunner === "agent" && run.topology !== "swap-proxy") items.push({ code: DATA_CODES.agentNeedsSameHost, level: "block" });
    if (!run.opId) return items;
    const snap = await loadSnapshot(this.data, ctx);
    for (const d of snap.databases) items.push({ code: d.plane === "unsupported" ? DATA_CODES.finalDbUnsupported : "data-final.dry.database", level: d.plane === "unsupported" ? "warn" : "info", subject: d.itemRef, params: { engine: d.engine, plane: d.plane } });
    for (const v of snap.volumes) items.push({ code: v.excluded ? DATA_CODES.seedVolumeExcluded : "data-final.dry.volume", level: v.excluded ? "warn" : "info", subject: v.itemRef, params: { rawBytes: v.inventory?.found ? v.inventory.rawBytes : v.rawBytesTotal } });
    return items;
  }

  async observe(ctx: StepContext): Promise<FinalObs> {
    const snap = await loadSnapshot(this.data, ctx);
    const { views, missing } = await loadObjects(this.objects, ctx);
    const launcher = MigratorRunner.available(ctx.run) ? await this.runner.status(ctx.run, compOf(ctx).launch) : null;
    const total = snap.databases.filter((d) => d.plane === "logical").length + snap.volumes.filter((v) => !v.excluded).length;
    const done = snap.databases.filter((d) => d.plane === "logical" && d.task === "done").length + snap.volumes.filter((v) => !v.excluded && v.state === "DONE").length;
    return {
      snap,
      objects: views,
      missingObjects: missing,
      launcher,
      wrapped: compOf(ctx).wrapped === true,
      frozen: ctx.stepState("FREEZE").status === "PASSED",
      progress: { done, total, unit: "item" },
    };
  }

  private checks(obs: FinalObs): GateCheck[] {
    const checks = finalChecks(obs.snap, obs.objects);
    for (const id of obs.missingObjects) checks.push({ id: `object-gone:${id.slice(0, 40)}`, status: "fail", code: DATA_CODES.seedObjectGone, subject: id });
    return checks;
  }

  preGate(ctx: StepContext, obs: FinalObs): GateResult {
    const checks: GateCheck[] = [];
    if (!obs.frozen) checks.push({ id: "frozen", status: "fail", code: "data-final.source-not-frozen" });
    if (ctx.run.options.sourceRunner === "agent" && ctx.run.topology !== "swap-proxy") checks.push({ id: "agent-same-host", status: "fail", code: DATA_CODES.agentNeedsSameHost });
    if (obs.snap.volumes.some((v) => !v.excluded) && !obs.snap.vxEnabled) checks.push({ id: "vx-disabled", status: "fail", code: DATA_CODES.vxDisabled });
    return gateFrom(checks);
  }

  /** The data is accounted for AND the step wrapped up (the wrap-up is what makes the step pass through `act`). */
  postGate(_ctx: StepContext, obs: FinalObs): GateResult {
    const checks = this.checks(obs);
    if (!obs.wrapped) checks.push({ id: "wrapped-up", status: "unknown", code: "data-final.wrap-up-pending" });
    return gateFrom(checks);
  }

  private dataComplete(obs: FinalObs): boolean {
    return gateFrom(this.checks(obs)).passed;
  }

  async act(ctx: StepContext, obs: FinalObs): Promise<ActResult> {
    const run = ctx.run;
    const snap = obs.snap;
    if (obs.missingObjects.length) return { outcome: "fail", code: DATA_CODES.seedObjectGone, params: { count: obs.missingObjects.length }, retryable: false };

    // object migrations: final pass (writers are frozen: FREEZE passed), then the diff
    let objectsBusy = false;
    for (const o of obs.objects) {
      if (objectIsActive(o)) {
        objectsBusy = true;
        continue;
      }
      const selected = o.buckets.filter((b) => b.selected);
      if (selected.length === 0 || o.blockers > 0) continue;
      try {
        await ctx.assertLease();
        if (selected.every((b) => b.status === "VERIFIED")) continue;
        if (selected.some((b) => !FINAL_OR_BETTER.has(b.status))) {
          if (!["SEEDED", "FINAL", "FAILED", "DONE"].includes(o.status)) continue; // the seed pass has not finished: DATA_SEED's business
          await this.objects.startFinal(ctx.actor.userId, o.id);
          objectsBusy = true;
        } else if (selected.some((b) => b.status !== "VERIFIED")) {
          await this.objects.verify(ctx.actor.userId, o.id);
          objectsBusy = true;
        }
      } catch (e) {
        if (e instanceof RunLeaseLostError) throw e;
        return { outcome: "fail", code: DATA_CODES.seedObjectStartRejected, params: { status: o.status, phase: "final" }, retryable: true };
      }
    }

    // the migrator: databases (dump + restore) and volumes (streamed parts)
    if (migratorWorkRemains(snap)) {
      const flags = migratorFlags("final", run, snap);
      if (MigratorRunner.available(run)) {
        const st = obs.launcher;
        if (st?.state === "running") return { outcome: "continue", pollAfterMs: 10_000 };
        if (st?.state === "finished" && compOf(ctx).launch?.phase === "final" && ![0, 1].includes(st.rc)) {
          return { outcome: "fail", code: DATA_CODES.finalMigratorExit, params: { exit: st.rc, code: st.result?.code ?? null }, retryable: true };
        }
        const launched = await this.runner.launch(ctx, "final", snap);
        if (!launched.ok) return { outcome: "fail", code: launched.code, params: launched.params, retryable: launched.retryable };
        await ctx.emit({ stepKey: "DATA_FINAL", level: "info", code: "data-final.migrator-launched" });
        return { outcome: "continue", pollAfterMs: 10_000 };
      }
      if (hasLiveTransfer(snap)) return { outcome: "continue", pollAfterMs: 10_000 }; // an operator-run migrator is streaming right now
      const failing = this.checks(obs).filter((c) => c.status === "fail").length;
      return {
        outcome: "wait",
        wait: {
          kind: "operator",
          code: DATA_CODES.runMigrator,
          params: { phase: "final", flags, pending: snap.databases.filter((d) => d.plane === "logical" && d.task !== "done").length + snap.volumes.filter((v) => !v.excluded && v.state !== "DONE").length, failing, hubTokenActive: snap.tokenActive },
          offersCommand: true,
        },
      };
    }

    if (objectsBusy || hasLiveTransfer(snap)) return { outcome: "continue", pollAfterMs: 10_000 };

    if (!this.dataComplete(obs)) {
      const bad = this.checks(obs).find((c) => c.status === "fail") ?? this.checks(obs).find((c) => c.status === "unknown");
      return { outcome: "wait", wait: { kind: "operator", code: bad?.code ?? DATA_CODES.finalVolumeNotDone, params: { failing: this.checks(obs).filter((c) => c.status !== "pass" && c.status !== "warn").length } } };
    }

    // wrap up: nothing may stay armed once the data is in
    await ctx.assertLease();
    await this.data.revokeToken(run);
    await releaseIfOurs(ctx, this.caps, false);
    await ctx.recordCompensation({ wrapped: true });
    await ctx.emit({ stepKey: "DATA_FINAL", level: "info", code: "data-final.wrapped-up" });
    return { outcome: "done" };
  }

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort") return { outcome: "nothing-to-do" };
    const run = ctx.run;
    if (!run.opId) return { outcome: "nothing-to-do" };
    let failed = false;
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
    if (failed) return { outcome: "failed", code: "data-final.abort-incomplete" };
    // a migrator that stopped source containers itself (`--stop-source`) did not tell the hub which: it restarts them when a
    // copy fails, but after a COMPLETED copy they stay stopped, so the operator must bring them back
    if (run.options.stopSource) return { outcome: "manual", manual: [{ code: DATA_CODES.finalStopSourceManual }] };
    return { outcome: "done" };
  }
}
