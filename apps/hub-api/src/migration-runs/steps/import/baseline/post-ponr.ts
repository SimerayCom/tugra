/**
 * What happens AFTER the point of no return (R26/C13, R17/R64): Tugra is authoritative now, so
 *  - the held workers start (they were built or stopped dark; never run next to the live source),
 *  - the push-to-deploy switches IMPORT turned off are restored (while Coolify was authoritative a push would have deployed
 *    twice), and the operator is told to take the push webhook away from the source (this hub cannot: its token is read-only).
 *
 * `run` is called by OBSERVE when its window opens and by FINALIZE (when the observe window was skipped); every part observes
 * before it acts, so a repeat does nothing and says nothing. It refuses to act on a run that is not past the point of no return,
 * is a dry-run, or is being aborted, rolled back or reversed: an abort never starts a worker.
 * `undo` is the reverse: Coolify is authoritative again, so the workers stop and the switches go back off.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { deployConcurrencyOf, resolveOwnerInput, type StepContext } from "../../../core/run-contract";
import { IMPORT_STEPS_PORT, type ImportStepsPort } from "../import-ports";
import { deployKeyBase, isActiveDeploy, stopRunApps } from "../step-utils";
import { appIdsOf, workerSetsOfOp } from "./op-safety";
import { RUN_HINTS, type RunHintStore } from "./run-hints";

const NOT_ACTING = new Set(["ABORTING", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED"]);

export interface ReleaseReport {
  workersStarted: number;
  workersFailed: number;
  autoDeployRestored: number;
}

/** The apps IMPORT switched push-to-deploy off for (ids recorded in IMPORT's compensation before the switch). */
export const heldAutoDeployIds = (ctx: StepContext): string[] => {
  const v = (ctx.stepState("IMPORT").compensation ?? {}).autoDeployHeld;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

@Injectable()
export class PostPonrRelease {
  constructor(
    @Inject(IMPORT_STEPS_PORT) private readonly port: ImportStepsPort,
    @Optional() @Inject(RUN_HINTS) private readonly hints?: RunHintStore,
  ) {}

  /** Start the held workers and restore push-to-deploy. Idempotent; null when the run may not release yet. */
  async run(ctx: StepContext): Promise<ReleaseReport | null> {
    const run = ctx.run;
    if (ctx.dryRun || !run.ponrAt || !run.opId || NOT_ACTING.has(run.status)) return null;
    const userId = ctx.actor.userId;
    const report: ReleaseReport = { workersStarted: 0, workersFailed: 0, autoDeployRestored: 0 };

    // 1) workers
    if ((resolveOwnerInput(run.inputs, "workerPolicy") ?? "hold-dark") === "hold-dark") {
      const op = await this.port.opSnapshot(userId, run.opId);
      const hints = this.hints ? await this.hints.list(run.id, run.promotedFromId).catch(() => []) : [];
      const { held } = workerSetsOfOp(run, op, hints);
      const ids = appIdsOf(op, held);
      const conc = deployConcurrencyOf(run.options);
      const todo: Array<{ id: string; name: string }> = [];
      for (const id of ids) {
        const s = await this.port.appState(userId, id);
        if (!s.exists) continue;
        const deps = await this.port.deployments(id, deployKeyBase(run.id, id));
        const last = deps[deps.length - 1];
        if (last && (isActiveDeploy(last) || last.status === "SUCCESS")) continue; // started (or starting): never twice
        if (last) {
          report.workersFailed++; // a failed start is the operator's call: no automatic rebuild loop
          continue;
        }
        todo.push({ id, name: s.name ?? id });
      }
      for (let i = 0; i < todo.length; i += conc) {
        await ctx.assertLease();
        const batch = todo.slice(i, i + conc);
        const res = await Promise.allSettled(batch.map((w) => this.port.deploy(userId, w.id, deployKeyBase(run.id, w.id))));
        for (let j = 0; j < res.length; j++) {
          const r = res[j];
          if (r.status === "fulfilled" && r.value && r.value.status !== "FAILED" && r.value.status !== "CANCELLED") report.workersStarted++;
          else {
            report.workersFailed++;
            await ctx.emit({ level: "warn", code: "release.worker-failed", params: { name: batch[j].name } });
          }
        }
      }
      if (report.workersStarted > 0) await ctx.emit({ level: "info", code: "release.workers-started", params: { count: report.workersStarted } });
    }

    // 2) push-to-deploy
    if (this.port.autoDeployState && this.port.setAutoDeploy) {
      for (const id of heldAutoDeployIds(ctx)) {
        if ((await this.port.autoDeployState(userId, id)) !== false) continue;
        await ctx.assertLease();
        await this.port.setAutoDeploy(userId, id, true);
        report.autoDeployRestored++;
      }
      if (report.autoDeployRestored > 0) {
        await ctx.emit({ level: "info", code: "release.auto-deploy-restored", params: { count: report.autoDeployRestored } });
        await ctx.emit({ level: "warn", code: "release.webhooks-repoint", params: { count: report.autoDeployRestored } });
      }
    }
    return report;
  }

  /** The reverse: stop the workers this run started and switch push-to-deploy back off. Idempotent. Returns how many things changed and how many failed. */
  async undo(ctx: StepContext): Promise<{ changed: number; failed: number }> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    let changed = 0;
    let failed = 0;
    if (run.opId) {
      const op = await this.port.opSnapshot(userId, run.opId).catch(() => null);
      if (op) {
        const hints = this.hints ? await this.hints.list(run.id, run.promotedFromId).catch(() => []) : [];
        const r = await stopRunApps(this.port, userId, run.id, appIdsOf(op, workerSetsOfOp(run, op, hints).held));
        changed += r.stopped;
        failed += r.failed + r.active;
      }
    }
    if (this.port.autoDeployState && this.port.setAutoDeploy) {
      for (const id of heldAutoDeployIds(ctx)) {
        if ((await this.port.autoDeployState(userId, id)) !== true) continue;
        try {
          await this.port.setAutoDeploy(userId, id, false);
          changed++;
        } catch {
          failed++;
        }
      }
    }
    return { changed, failed };
  }
}
