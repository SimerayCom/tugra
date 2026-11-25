import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { QueueHubService } from "./queue-hub.service";
import { retireLegacyQueues, type LegacyCleanupResult } from "./legacy-queues";

export const SCHEDULER_QUEUE = "scheduler";
/** BullMQ job-scheduler id of a tick: stable, so a restart upserts the SAME scheduler instead of adding a second one. */
export const tickSchedulerId = (name: string) => `tick:${name}`;
/** How long a job that fired before its handler was registered (a restart with overdue ticks, while the feature services
 *  are still booting) waits for the registration before it fails. The next tick simply tries again. */
const HANDLER_WAIT_MS = 120_000;
/** Once boot has settled every feature service has registered its ticks, so a name nobody claimed will not get a
 *  handler later: such a job (an orphaned scheduler) waits only this long before it fails. */
const SETTLED_HANDLER_WAIT_MS = 5_000;
/** Delay after boot before orphaned `tick:*` schedulers (no handler registered in this process) are removed. Must be
 *  shorter than {@link HANDLER_WAIT_MS}; Nest has finished every bootstrap hook (all `register` calls) well before. */
const ORPHAN_SWEEP_DELAY_MS = 30_000;
/** A tick that is skipped this many times in a row (its previous run never finished) is reported as a failure: the
 *  skip is logged at error level and the job is failed so it shows up in the queue's failed list. */
export const MAX_CONSECUTIVE_SKIPS = 3;
/** One slot per job name is enough (a name never runs twice at once); this caps how many different ticks run in parallel. */
const WORKER_CONCURRENCY = 24;

/** The next multiple of `every` after now (what a legacy BullMQ `repeat.every` job used as its first fire time). */
export const nextBoundary = (every: number, now = Date.now()): number => Math.floor(now / every) * every + every;

export interface TickSpec {
  /** Unique, stable job name (it is the scheduler id and the log label). */
  name: string;
  /** Fixed interval in ms ... */
  every?: number;
  /** ... or a cron pattern (optionally in an IANA timezone). Exactly one of `every` / `pattern`. */
  pattern?: string;
  tz?: string;
  run: () => Promise<unknown> | unknown;
}

type Entry = { run: (job: Pick<Job, "name" | "data">) => Promise<unknown> | unknown; exclusive: boolean };

/**
 * One BullMQ queue ("scheduler") and ONE worker for every rare, global, periodic tick the hub runs (metrics rollup,
 * retention, cleanup sweep, digest, telemetry, expiry, update check, image-update, deploy sweep, container health, WAL
 * shipper, dead-man, monthly drill, watchdogs, ...), instead of one queue + worker + Redis connections per tick.
 *
 * Semantics kept from the per-queue schedulers:
 *  - interval / cron per job, repeatable across restarts: a tick is a BullMQ job scheduler keyed by a stable id, so
 *    re-registering at boot is idempotent (never a second copy) and an interval change updates it in place;
 *  - a tick missed while the hub was down runs ONCE on boot (BullMQ keeps the overdue delayed job), never in a burst;
 *  - error isolation: each job runs in its own slot, a throw is logged and fails only that job; a job still running
 *    from its previous tick is skipped (never two copies of one tick at once), and a slow tick never delays another;
 *  - kill switches / env overrides stay with each feature service: it decides whether to `register` or `disable`.
 * Disabled under NODE_ENV=test (nothing touches Redis); specs drive the runners directly.
 */
@Injectable()
export class TickSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TickSchedulerService.name);
  private queue?: Queue;
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Map<string, Array<(e: Entry) => void>>();
  private readonly running = new Set<string>();
  /** Cancels every job still waiting for its handler (shutdown): the worker's graceful close waits for active jobs. */
  private readonly aborts = new Set<() => void>();
  private readonly skips = new Map<string, number>();
  private settled = false;
  private orphanTimer?: NodeJS.Timeout;
  private legacyCleanup?: Promise<LegacyCleanupResult | undefined>;

  constructor(private readonly hub: QueueHubService) {}

  get enabled(): boolean {
    return this.hub.enabled;
  }

  /** The queue and its single worker, created on first use. */
  private ensure(): Queue {
    if (!this.queue) {
      this.queue = this.hub.queue(SCHEDULER_QUEUE);
      this.hub.worker(SCHEDULER_QUEUE, (job) => this.dispatch(job), { concurrency: WORKER_CONCURRENCY });
    }
    return this.queue;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    this.ensure();
    this.orphanTimer = setTimeout(() => {
      this.settled = true;
      void this.removeOrphanSchedulers().catch((e) => this.logger.warn(`orphan scheduler sweep failed: ${e instanceof Error ? e.message : e}`));
    }, ORPHAN_SWEEP_DELAY_MS);
    this.orphanTimer.unref?.();
    // Old per-feature queues: drop their repeat keys and pending jobs (and carry over scheduled reboots) so the
    // previous version's ticks do not linger in Redis. Never blocks or fails boot.
    this.legacyCleanup = retireLegacyQueues(this.hub, this)
      .then((r) => {
        if (r.retiredQueues.length || r.removedRepeatables || r.movedJobs) {
          this.logger.log(`retired legacy queues [${r.retiredQueues.join(", ")}], removed ${r.removedRepeatables} old repeat key(s), moved ${r.movedJobs} pending job(s)`);
        }
        return r;
      })
      .catch((e) => {
        this.logger.warn(`legacy queue cleanup failed: ${e instanceof Error ? e.message : e}`);
        return undefined;
      });
  }

  onModuleDestroy(): void {
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    for (const abort of [...this.aborts]) abort();
  }

  /** Resolves when the boot-time legacy cleanup has finished (specs / diagnostics); undefined result = it failed. */
  legacyCleanupDone(): Promise<LegacyCleanupResult | undefined> {
    return this.legacyCleanup ?? Promise.resolve(undefined);
  }

  /**
   * Removes `tick:*` schedulers left in Redis whose name no feature registered in this process (a tick that was
   * renamed or dropped in a newer version, or whose feature is gone). Without this they would fire forever and each
   * firing would hold a worker slot until it times out. Per-feature kill switches already `disable` their own tick;
   * this only catches names nobody claims. Returns the removed names.
   */
  async removeOrphanSchedulers(): Promise<string[]> {
    if (!this.enabled) return [];
    const queue = this.ensure();
    const removed: string[] = [];
    for (const s of await queue.getJobSchedulers(0, -1)) {
      const id = s.key;
      if (!id?.startsWith("tick:")) continue;
      const name = id.slice("tick:".length);
      if (this.entries.has(name)) continue;
      await queue.removeJobScheduler(id);
      removed.push(name);
    }
    if (removed.length) this.logger.log(`removed ${removed.length} orphaned scheduler tick(s) no feature claims: ${removed.join(", ")}`);
    return removed;
  }

  /** Register (or re-register) a periodic tick. Idempotent: the same name upserts the same scheduler. */
  async register(spec: TickSpec): Promise<void> {
    if ((spec.every == null) === (spec.pattern == null)) throw new Error(`tick ${spec.name}: set exactly one of every / pattern`);
    this.setEntry(spec.name, { run: spec.run, exclusive: true });
    if (!this.enabled) return;
    const queue = this.ensure();
    const id = tickSchedulerId(spec.name);
    let repeat: Parameters<Queue["upsertJobScheduler"]>[1];
    if (spec.every != null) {
      // BullMQ runs a brand-new `every` scheduler (and one whose interval just changed) at once, then every interval.
      // The per-feature queues this replaces first fired at the next interval boundary, so a fresh install or an
      // upgrade must not fire every tick in the same second (nor auto-apply an update on the upgrade boot): start at
      // the next boundary. A scheduler that already has this interval is upserted as is, which keeps its pending job
      // (an overdue tick still runs once on boot) and re-creates it if it was ever lost.
      const current = await queue.getJobScheduler(id).catch(() => undefined);
      repeat = current?.every === spec.every ? { every: spec.every } : { every: spec.every, startDate: new Date(nextBoundary(spec.every)) };
    } else {
      repeat = { pattern: spec.pattern!, ...(spec.tz ? { tz: spec.tz } : {}) };
    }
    await queue.upsertJobScheduler(id, repeat, { name: spec.name, data: {} });
  }

  /** Stop a tick (kill switch flipped, feature turned off): removes its scheduler and the pending job. Safe if absent. */
  async disable(name: string): Promise<void> {
    this.entries.delete(name);
    if (!this.enabled) return;
    await this.ensure().removeJobScheduler(tickSchedulerId(name));
  }

  /** A handler for one-off jobs added with {@link enqueueAt} (not exclusive: several may run at once). */
  handle(name: string, run: (job: Pick<Job, "name" | "data">) => Promise<unknown> | unknown): void {
    this.setEntry(name, { run, exclusive: false });
  }

  /** One precise delayed job (e.g. a scheduled reboot). Idempotent by `jobId`. */
  async enqueueAt(name: string, data: object, jobId: string, at: Date, now = Date.now()): Promise<void> {
    if (!this.enabled) return;
    await this.ensure().add(name, data, { jobId, delay: Math.max(0, at.getTime() - now) });
  }

  async removeJob(jobId: string): Promise<void> {
    if (!this.enabled || !this.queue) return;
    await this.queue.remove(jobId).catch(() => undefined);
  }

  private setEntry(name: string, entry: Entry): void {
    this.entries.set(name, entry);
    const w = this.waiters.get(name);
    if (w) {
      this.waiters.delete(name);
      for (const resolve of w) resolve(entry);
    }
  }

  private waitFor(name: string): Promise<Entry> {
    const have = this.entries.get(name);
    if (have) return Promise.resolve(have);
    return new Promise<Entry>((resolve, reject) => {
      const forget = () => {
        clearTimeout(timer);
        this.aborts.delete(abort);
        const list = this.waiters.get(name)?.filter((r) => r !== onReady) ?? [];
        if (list.length) this.waiters.set(name, list);
        else this.waiters.delete(name);
      };
      const fail = (message: string) => {
        forget();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail(`no handler registered for scheduler job "${name}"`), this.settled ? SETTLED_HANDLER_WAIT_MS : HANDLER_WAIT_MS);
      timer.unref?.();
      const onReady = (e: Entry) => {
        clearTimeout(timer);
        this.aborts.delete(abort);
        resolve(e);
      };
      const abort = () => fail(`hub is shutting down, scheduler job "${name}" not started`);
      this.aborts.add(abort);
      this.waiters.set(name, [...(this.waiters.get(name) ?? []), onReady]);
    });
  }

  /** The worker's processor: route by job name. A throw fails only this job (BullMQ records it, the scheduler goes on). */
  async dispatch(job: Pick<Job, "name" | "data">): Promise<void> {
    const entry = await this.waitFor(job.name);
    if (entry.exclusive) {
      if (this.running.has(job.name)) {
        const n = (this.skips.get(job.name) ?? 0) + 1;
        this.skips.set(job.name, n);
        if (n < MAX_CONSECUTIVE_SKIPS) {
          this.logger.warn(`tick ${job.name} is still running from its previous run, skipping this one (${n} in a row)`);
          return;
        }
        // Permanently slower than its interval (or hung): make it visible instead of reporting "completed".
        const msg = `tick ${job.name} is still running from its previous run, ${n} runs skipped in a row`;
        this.logger.error(msg);
        throw new Error(msg);
      }
      this.skips.delete(job.name);
      this.running.add(job.name);
    }
    const t0 = Date.now();
    try {
      await entry.run(job);
    } catch (e) {
      this.logger.warn(`tick ${job.name} failed after ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      if (entry.exclusive) this.running.delete(job.name);
    }
  }

  /** Names of the ticks this process registered (diagnostics / specs). */
  names(): string[] {
    return [...this.entries.keys()];
  }
}
