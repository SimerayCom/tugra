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
import { CAPABILITY_PORT, CHECK_STORE, DATA_CODES, DATA_PORT, OBJECT_PORT, SOURCE_STATS_CHECK, type CapabilityPort, type CheckStore, type DataPort, type DataSnapshot, type ObjectPort, type ObjectView } from "./data-contract";
import { dbRestoredAfterFreeze, finalChecks, hasLiveTransfer, isMigratorDb, migratorFlags, migratorWorkRemains, objectIsActive } from "./data-logic";
import { compOf, gateFrom, loadObjects, loadSnapshot, releaseIfOurs, takeObjectStart } from "./handler-util";
import type { LauncherStatus } from "./launcher/migrator-launcher";
import { controllerOf } from "./freeze.handler";
import { MigratorRunner } from "./launcher/migrator-runner.service";

export interface FinalObs extends Observation {
  snap: DataSnapshot;
  objects: ObjectView[];
  missingObjects: string[];
  launcher: LauncherStatus | null;
  wrapped: boolean;
  frozen: boolean;
  /** When the downtime window opened (a database restored before it is a warm seed, not the final copy). */
  freezeAt: Date | null;
  /** Logical databases whose source-side `--verify` measurement has reached the hub since the freeze. */
  reportedStats: Set<string>;
}

/**
 * How long the data may be complete before the step wraps up without the migrator's source-side `--verify` report. The migrator
 * reports AFTER the last data arm and needs the migration token for it, so the token is not revoked while the report is still
 * due; an operator who ran the migrator without `--verify`, or a migrator that died, must not hold the run forever.
 */
export const VERIFY_REPORT_GRACE_MS = 10 * 60_000;
export const VERIFY_REPORT_POLL_MS = 10_000;

/** The operator attestation (on this step) that the object store's writers are stopped. */
export const WRITERS_FROZEN_CHECK = "objects-writers-frozen";

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
    @Inject(CHECK_STORE) private readonly checks_: CheckStore,
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
    const freeze = ctx.run.freezeStartedAt;
    const total = snap.databases.filter((d) => d.plane === "logical").length + snap.volumes.filter((v) => !v.excluded).length;
    const done = snap.databases.filter((d) => d.plane === "logical" && dbRestoredAfterFreeze(d, freeze)).length + snap.volumes.filter((v) => !v.excluded && v.state === "DONE").length;
    const reportedStats = await this.reportedStats(ctx, snap);
    return {
      snap,
      objects: views,
      missingObjects: missing,
      launcher,
      wrapped: compOf(ctx).wrapped === true,
      frozen: ctx.stepState("FREEZE").status === "PASSED",
      freezeAt: freeze,
      reportedStats,
      progress: { done, total, unit: "item" },
    };
  }

  /** The databases whose source-side measurement arrived after the freeze opened (an earlier report belongs to an earlier pass). */
  private async reportedStats(ctx: StepContext, snap: DataSnapshot): Promise<Set<string>> {
    const out = new Set<string>();
    if (!snap.databases.some(isMigratorDb)) return out;
    const since = ctx.run.freezeStartedAt?.getTime() ?? 0;
    for (const r of await this.checks_.list(ctx.run.id, "VERIFY")) if (r.checkId === SOURCE_STATS_CHECK && r.at.getTime() >= since) out.add(r.subject);
    return out;
  }

  private checks(obs: FinalObs): GateCheck[] {
    const checks = finalChecks(obs.snap, obs.objects, obs.freezeAt);
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
    let objectsHeld = false;
    const writersFrozen = this.writersFrozen(ctx);
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
        const differs = selected.some((b) => b.status === "DIFFERS");
        if (differs) {
          // the diff found a difference: never loop the same verification, the operator decides (retry re-runs the final pass)
          if (ctx.trigger === "retry" && ["SEEDED", "FINAL", "FAILED", "DONE"].includes(o.status)) {
            if (!writersFrozen) {
              objectsHeld = true;
              continue;
            }
            if (!(await takeObjectStart(ctx, o.id))) continue;
            await this.objects.startFinal(ctx.actor.userId, o.id);
            objectsBusy = true;
          }
        } else if (selected.some((b) => b.status === "FINAL")) {
          await this.objects.verify(ctx.actor.userId, o.id);
          objectsBusy = true;
        } else if (selected.some((b) => !FINAL_OR_BETTER.has(b.status))) {
          if (!["SEEDED", "FINAL", "FAILED", "DONE"].includes(o.status)) continue; // the seed pass has not finished: DATA_SEED's business
          if (!writersFrozen) {
            objectsHeld = true; // the hub has no evidence the object writers are stopped: it never tells the object service they are
            continue;
          }
          if (!(await takeObjectStart(ctx, o.id))) continue; // budget spent: the gate reports it, a human presses retry
          await this.objects.startFinal(ctx.actor.userId, o.id);
          objectsBusy = true;
        }
      } catch (e) {
        if (e instanceof RunLeaseLostError) throw e;
        return { outcome: "fail", code: DATA_CODES.seedObjectStartRejected, params: { status: o.status, phase: "final" }, retryable: true };
      }
    }

    // the migrator: databases (dump + restore) and volumes (streamed parts)
    if (migratorWorkRemains(snap, obs.freezeAt)) {
      const flags = migratorFlags("final", run, snap);
      if (MigratorRunner.available(run)) {
        const st = obs.launcher;
        if (st?.state === "running") return { outcome: "continue", pollAfterMs: 10_000 };
        if (st?.state === "finished" && compOf(ctx).launch?.phase === "final" && ![0, 1].includes(st.rc) && ctx.trigger !== "retry") {
          return { outcome: "fail", code: DATA_CODES.finalMigratorExit, params: { exit: st.rc, code: st.result?.code ?? null }, retryable: true };
        }
        const launched = await this.runner.launch(ctx, "final", snap);
        if (!launched.ok) return { outcome: "fail", code: launched.code, params: launched.params, retryable: launched.retryable };
        if (compOf(ctx).dataCompleteAt) await ctx.recordCompensation({ dataCompleteAt: null }); // a new pass: its own report is due
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
          params: { phase: "final", flags, pending: snap.databases.filter((d) => d.plane === "logical" && !dbRestoredAfterFreeze(d, obs.freezeAt)).length + snap.volumes.filter((v) => !v.excluded && v.state !== "DONE").length, failing, hubTokenActive: snap.tokenActive },
          offersCommand: true,
          ...(objectsHeld ? { attest: [WRITERS_FROZEN_CHECK] } : {}),
        },
      };
    }

    if (objectsBusy || hasLiveTransfer(snap)) return { outcome: "continue", pollAfterMs: 10_000 };

    if (objectsHeld) {
      return { outcome: "wait", wait: { kind: "operator", code: DATA_CODES.finalObjectsWritersNotFrozen, params: { controller: controllerOf(run) }, attest: [WRITERS_FROZEN_CHECK] } };
    }

    if (!this.dataComplete(obs)) {
      const bad = this.checks(obs).find((c) => c.status === "fail") ?? this.checks(obs).find((c) => c.status === "unknown");
      return { outcome: "wait", wait: { kind: "operator", code: bad?.code ?? DATA_CODES.finalVolumeNotDone, params: { failing: this.checks(obs).filter((c) => c.status !== "pass" && c.status !== "warn").length } } };
    }

    // the migrator reports the source side of DB parity AFTER its last data arm, with the same token: do not revoke it under it
    const hold = await this.awaitVerifyReport(ctx, obs);
    if (hold) return hold;

    // wrap up: nothing may stay armed once the data is in
    await ctx.assertLease();
    await this.data.revokeToken(run);
    await releaseIfOurs(ctx, this.caps, false);
    await ctx.recordCompensation({ wrapped: true });
    await ctx.emit({ stepKey: "DATA_FINAL", level: "info", code: "data-final.wrapped-up" });
    return { outcome: "done" };
  }

  /**
   * True when the hub may tell the object service the source writers are frozen: a controller that stops them (api / agent) was
   * verified by FREEZE, an attested manual freeze is the operator's word. A manual freeze that only relies on the migrator's
   * `--stop-source` proves nothing about the object store's writers (the migrator stops only the containers that mount the
   * volumes it copies), so there the operator has to attest it for this step.
   */
  private writersFrozen(ctx: StepContext): boolean {
    if (controllerOf(ctx.run) !== "manual" || !ctx.run.options.stopSource) return true;
    return ctx.stepState("FREEZE").evidence.attestations.some((a) => a.checkId === "source-quiesced") || ctx.step.evidence.attestations.some((a) => a.checkId === WRITERS_FROZEN_CHECK);
  }

  /**
   * Hold the wrap-up (token revocation) while the migrator's `--verify` report is still due: its container is still running
   * (same-host), or, for an operator-run migrator, a logical database has no source-side measurement since the freeze. Bounded by
   * {@link VERIFY_REPORT_GRACE_MS} from the moment the data was complete, so a run without `--verify` or a dead migrator cannot
   * hold the step; VERIFY then reports the missing measurement as `not-reported` (unknown, acknowledgeable).
   */
  private async awaitVerifyReport(ctx: StepContext, obs: FinalObs): Promise<ActResult | null> {
    const run = ctx.run;
    const launched = !!compOf(ctx).launch;
    let due: boolean;
    if (MigratorRunner.available(run) && launched) due = obs.launcher === null || obs.launcher.state === "running";
    else if (MigratorRunner.available(run)) due = false; // nothing was launched by the hub: no report to wait for
    else due = obs.snap.databases.some((d) => isMigratorDb(d) && !obs.reportedStats.has(d.itemRef));
    if (!due) return null;
    const since = compOf(ctx).dataCompleteAt;
    if (!since) {
      await ctx.recordCompensation({ dataCompleteAt: ctx.now().toISOString() });
      await ctx.emit({ stepKey: "DATA_FINAL", level: "info", code: DATA_CODES.finalAwaitVerifyReport });
      return { outcome: "continue", pollAfterMs: VERIFY_REPORT_POLL_MS };
    }
    if (ctx.now().getTime() - new Date(since).getTime() < VERIFY_REPORT_GRACE_MS) return { outcome: "continue", pollAfterMs: VERIFY_REPORT_POLL_MS };
    await ctx.emit({ stepKey: "DATA_FINAL", level: "warn", code: DATA_CODES.finalVerifyReportMissing });
    return null;
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
