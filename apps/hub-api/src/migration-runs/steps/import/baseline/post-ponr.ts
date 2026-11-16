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
import { appIdsOf, appTasksOf, pinFloatingImages, workerSetsOfOp } from "./op-safety";
import { RUN_HINTS, type RunHint, type RunHintStore } from "./run-hints";
import { degradedItemRefs } from "./source-health";
import type { OpSnapshot } from "../import-ports";

const NOT_ACTING = new Set(["ABORTING", "ABORTED", "ROLLING_BACK", "ROLLED_BACK", "REVERSING", "REVERSED"]);

export interface ReleaseReport {
  workersStarted: number;
  workersFailed: number;
  autoDeployRestored: number;
}

/** Where the held workers stand after the release (see {@link PostPonrRelease.verify}). Names, never ids. */
export interface WorkerVerify {
  total: number;
  running: number;
  /** Queued, building or not started yet: still on its way. */
  starting: string[];
  /** The latest start FAILED or was CANCELLED, the app is gone or it is not RUNNING after a successful deploy. */
  failed: string[];
  /** Failed too, but the source health baseline says it was already failing there: reported, never judged against. */
  failedAtSource: string[];
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

  /**
   * Start the held workers and restore push-to-deploy. Idempotent; null when the run may not release yet. A worker whose earlier
   * start FAILED is rebuilt only with `retry` (the operator's retry of the window), under a new numbered key: never in a loop.
   */
  async run(ctx: StepContext, opts: { retry?: boolean } = {}): Promise<ReleaseReport | null> {
    const run = ctx.run;
    if (ctx.dryRun || !run.ponrAt || !run.opId || NOT_ACTING.has(run.status)) return null;
    const userId = ctx.actor.userId;
    const report: ReleaseReport = { workersStarted: 0, workersFailed: 0, autoDeployRestored: 0 };

    // 1) workers
    const op = await this.port.opSnapshot(userId, run.opId);
    const hints = await this.hintsOf(run);
    const sets = workerSetsOfOp(run, op, hints);
    if ((resolveOwnerInput(run.inputs, "workerPolicy") ?? "hold-dark") === "hold-dark") {
      const ids = appIdsOf(op, sets.held);
      const conc = deployConcurrencyOf(run.options);
      const todo: Array<{ id: string; name: string; key: string }> = [];
      for (const id of ids) {
        const s = await this.port.appState(userId, id);
        if (!s.exists) continue;
        const base = deployKeyBase(run.id, id);
        const deps = await this.port.deployments(id, base);
        const last = deps[deps.length - 1];
        if (last && (isActiveDeploy(last) || last.status === "SUCCESS")) continue; // started (or starting): never twice
        if (last && !opts.retry) {
          report.workersFailed++; // a failed start is the operator's call: no automatic rebuild loop
          continue;
        }
        todo.push({ id, name: s.name ?? id, key: last ? `${base}:${deps.length}` : base });
      }
      // R11: a held worker runs the digest the source runs too, not today's floating tag
      const pinned = todo.length ? await pinFloatingImages(this.port, userId, op, hints, new Set(todo.map((w) => w.id))) : [];
      for (const name of pinned) await ctx.emit({ level: "info", code: "deploy-dark.image-pinned", params: { name } });
      for (let i = 0; i < todo.length; i += conc) {
        await ctx.assertLease();
        const batch = todo.slice(i, i + conc);
        const res = await Promise.allSettled(batch.map((w) => this.port.deploy(userId, w.id, w.key)));
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

    // 2) push-to-deploy. A worker this run excludes was created as a Tugra app but is never meant to run here: its switch stays off.
    if (this.port.autoDeployState && this.port.setAutoDeploy) {
      const excluded = new Set(appIdsOf(op, sets.excluded));
      for (const id of heldAutoDeployIds(ctx)) {
        if (excluded.has(id)) continue;
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

  private hintsOf(run: { id: string; promotedFromId: string | null }): Promise<RunHint[]> {
    return this.hints ? this.hints.list(run.id, run.promotedFromId).catch(() => []) : Promise.resolve([]);
  }

  /**
   * The Tugra apps this run must not start before the cutover: the held workers and the excluded ones. Empty for a run without an
   * op. TLS_PREISSUE leaves them out of its redeploy; nothing else may start them either.
   */
  async withheldAppIds(ctx: StepContext): Promise<Set<string>> {
    const run = ctx.run;
    if (!run.opId) return new Set();
    const op = await this.port.opSnapshot(ctx.actor.userId, run.opId).catch(() => null);
    if (!op || op.rolledBack) return new Set();
    const sets = workerSetsOfOp(run, op, await this.hintsOf(run));
    return new Set([...appIdsOf(op, sets.held), ...appIdsOf(op, sets.excluded)]);
  }

  /**
   * Where the held workers stand: running, still starting, or failed to start. The source health baseline excuses a worker that was
   * already failing at the source. Null when the run may not release yet (same rule as {@link run}) or holds no workers.
   */
  async verify(ctx: StepContext): Promise<WorkerVerify | null> {
    const run = ctx.run;
    if (ctx.dryRun || !run.ponrAt || !run.opId || NOT_ACTING.has(run.status)) return null;
    if ((resolveOwnerInput(run.inputs, "workerPolicy") ?? "hold-dark") !== "hold-dark") return null;
    const userId = ctx.actor.userId;
    const op: OpSnapshot = await this.port.opSnapshot(userId, run.opId);
    const { held } = workerSetsOfOp(run, op, await this.hintsOf(run));
    const skip = degradedItemRefs(run.sourceBaseline);
    const out: WorkerVerify = { total: 0, running: 0, starting: [], failed: [], failedAtSource: [] };
    for (const t of appTasksOf(op)) {
      if (!t.itemRef || !held.has(t.itemRef)) continue;
      out.total++;
      const id = t.resourceId!;
      const s = await this.port.appState(userId, id);
      const name = s.name ?? t.name ?? id;
      const deps = s.exists ? await this.port.deployments(id, deployKeyBase(run.id, id)) : [];
      const last = deps[deps.length - 1];
      if (s.exists && (!last || isActiveDeploy(last))) out.starting.push(name);
      else if (s.exists && last?.status === "SUCCESS" && s.status === "RUNNING") out.running++;
      else (skip.has(t.itemRef) ? out.failedAtSource : out.failed).push(name);
    }
    return out;
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
        const hints = await this.hintsOf(run);
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
