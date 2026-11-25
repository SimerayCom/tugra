import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { QueueHubService } from "./queue-hub.service";
import { retireLegacyQueues, type LegacyCleanupResult } from "./legacy-queues";

export const SCHEDULER_QUEUE = "scheduler";
/** BullMQ job-scheduler id of a tick: stable, so a restart upserts the SAME scheduler instead of adding a second one. */
export const tickSchedulerId = (name: string) => `tick:${name}`;
/** How long a job that fired before its handler was registered (a restart with overdue ticks, while the feature services
 *  are still booting) waits for the registration before it fails. The next tick simply tries again. */
const HANDLER_WAIT_MS = 120_000;
/** One slot per job name is enough (a name never runs twice at once); this caps how many different ticks run in parallel. */
const WORKER_CONCURRENCY = 24;

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
export class TickSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TickSchedulerService.name);
  private queue?: Queue;
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Map<string, Array<(e: Entry) => void>>();
  private readonly running = new Set<string>();
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

  /** Resolves when the boot-time legacy cleanup has finished (specs / diagnostics); undefined result = it failed. */
  legacyCleanupDone(): Promise<LegacyCleanupResult | undefined> {
    return this.legacyCleanup ?? Promise.resolve(undefined);
  }

  /** Register (or re-register) a periodic tick. Idempotent: the same name upserts the same scheduler. */
  async register(spec: TickSpec): Promise<void> {
    if ((spec.every == null) === (spec.pattern == null)) throw new Error(`tick ${spec.name}: set exactly one of every / pattern`);
    this.setEntry(spec.name, { run: spec.run, exclusive: true });
    if (!this.enabled) return;
    await this.ensure().upsertJobScheduler(
      tickSchedulerId(spec.name),
      spec.every != null ? { every: spec.every } : { pattern: spec.pattern!, ...(spec.tz ? { tz: spec.tz } : {}) },
      { name: spec.name, data: {} },
    );
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
      const timer = setTimeout(() => {
        const list = this.waiters.get(name)?.filter((r) => r !== onReady) ?? [];
        if (list.length) this.waiters.set(name, list);
        else this.waiters.delete(name);
        reject(new Error(`no handler registered for scheduler job "${name}"`));
      }, HANDLER_WAIT_MS);
      timer.unref?.();
      const onReady = (e: Entry) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.set(name, [...(this.waiters.get(name) ?? []), onReady]);
    });
  }

  /** The worker's processor: route by job name. A throw fails only this job (BullMQ records it, the scheduler goes on). */
  async dispatch(job: Pick<Job, "name" | "data">): Promise<void> {
    const entry = await this.waitFor(job.name);
    if (entry.exclusive) {
      if (this.running.has(job.name)) {
        this.logger.warn(`tick ${job.name} is still running from its previous run, skipping this one`);
        return;
      }
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
