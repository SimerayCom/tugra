import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { QueueHubService } from "../scheduler/queue-hub.service";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { reapIfGone } from "../common/orphan-reap";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { planCleanupSchedule, reclaimedNothing, shouldTriggerThresholdCleanup, THRESHOLD_BACKOFF_SEC, THRESHOLD_COOLDOWN_SEC } from "./cleanup-defaults";
import { setBounded } from "../common/bounded-map";

const QUEUE = "cleanup";
/** Tick on the shared scheduler queue (every 5 min): registers any missing per-server schedule, then checks disk
 *  thresholds. (Older hubs ran it as a repeatable on this queue; processJob still answers one that fires late.) */
const SWEEP_JOB = "cleanup-threshold-sweep";
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/** Mirrors the backup/monitor schedulers: BullMQ repeatable jobs, disabled in tests. */
@Injectable()
export class CleanupSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CleanupSchedulerService.name);
  private queue?: Queue;
  /** In-process fallback for the once-an-hour throttle when Redis is unreachable (fail closed, not open). */
  private readonly localThrottle = new Map<string, number>(); // serverId -> blocked-until (ms)

  constructor(
    private readonly hub: QueueHubService,
    private readonly ticks: TickSchedulerService,
    private readonly prisma: PrismaService,
    private readonly runner: CleanupRunnerService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    this.queue = this.hub.queue(QUEUE);
    this.hub.worker(QUEUE, (job) => this.processJob(job));
    const registered = await this.registerAll(true);
    this.logger.log(`scheduled ${registered.ok}/${registered.total} docker cleanup(s)`);
    // Missing-schedule reconcile + disk-threshold trigger, every 5 minutes (also covers servers created after boot).
    await this.registerSweep();
  }

  /** Register the 5-minute sweep tick (reconcile + disk trigger). Never throws: a failure only logs. */
  async registerSweep(): Promise<void> {
    await this.ticks.register({ name: SWEEP_JOB, every: SWEEP_EVERY_MS, run: async () => void (await this.sweep()) }).catch((e) => this.logger.warn(`cleanup sweep not scheduled: ${e instanceof Error ? e.message : e}`));
  }

  /** Worker handler: a sweep job runs the reconcile + threshold check; a per-server job runs the daily cleanup. */
  async processJob(job: { name: string; data: { serverId?: string } }): Promise<void> {
    if (job.name === SWEEP_JOB) {
      await this.sweep();
      return;
    }
    const serverId = job.data.serverId as string;
    // Self-heal: a deleted server, or one an operator turned off (the reconcile can re-add a repeatable in the
    // moment between a disable and its unschedule), stops this repeatable instead of pruning or failing every tick.
    const live = await reapIfGone(
      serverId,
      () => this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, cleanupEnabled: true } }).then((r) => !!r && r.cleanupEnabled),
      (i) => this.unschedule(i),
    );
    if (!live) return;
    // The scheduled run always runs (daily hygiene, like Coolify); the disk threshold is a SEPARATE extra
    // trigger (sweep). It still skips while a deploy is building on this server; a manual "Clean now" doesn't.
    await this.runner.runCleanup(serverId, "scheduler", { skipIfDeploying: true });
  }

  /** Register the repeatable job for every enabled server. `force` re-registers (boot); otherwise only servers
   *  with no repeatable yet are added (periodic reconcile for servers created or enabled after boot). Enabled
   *  with no cron/interval of its own gets the default daily cron, so "enabled" always means "runs". */
  async registerAll(force: boolean): Promise<{ ok: number; total: number }> {
    if (!this.queue) return { ok: 0, total: 0 };
    const servers = await this.prisma.server.findMany({
      where: { cleanupEnabled: true },
      select: { id: true, cleanupCron: true, cleanupIntervalHours: true, timezone: true },
    });
    const have = force ? new Set<string>() : new Set((await this.queue.getRepeatableJobs()).map((r) => r.name));
    let ok = 0;
    for (const s of servers) {
      if (have.has(`cleanup:${s.id}`)) {
        ok++;
        continue;
      }
      // A bad stored cron must not crash the hub (BullMQ throws inside queue.add). Skip that server, keep going.
      try {
        const plan = planCleanupSchedule(s);
        if (plan.kind === "cron") await this.scheduleCron(s.id, plan.cron, plan.tz);
        else await this.schedule(s.id, plan.intervalSec);
        ok++;
      } catch (e) {
        this.logger.warn(`skipped cleanup schedule for server ${s.id} (bad cron "${s.cleanupCron}"): ${e instanceof Error ? e.message : e}`);
      }
    }
    return { ok, total: servers.length };
  }

  /** Claim the once-an-hour slot for a server's threshold trigger. Atomic via Redis SET NX EX so it holds
   *  across restarts; falls back to an in-process map if Redis errors. True = this caller may run. */
  private async claimThresholdSlot(serverId: string, now: number): Promise<boolean> {
    try {
      const r = await this.redis.client.set(`cleanup:threshold:${serverId}`, String(now), "EX", THRESHOLD_COOLDOWN_SEC, "NX");
      return r === "OK";
    } catch {
      const until = this.localThrottle.get(serverId);
      if (until != null && now < until) return false;
      setBounded(this.localThrottle, serverId, now + THRESHOLD_COOLDOWN_SEC * 1000, 5000);
      return true;
    }
  }

  /** A threshold run that freed nothing (disk full of non-Docker data) would repeat hourly forever: hold the
   *  slot for THRESHOLD_BACKOFF_SEC instead, so it does not churn audit rows and notifications. */
  private async extendThresholdSlot(serverId: string, now: number): Promise<void> {
    setBounded(this.localThrottle, serverId, now + THRESHOLD_BACKOFF_SEC * 1000, 5000);
    await this.redis.client.set(`cleanup:threshold:${serverId}`, String(now), "EX", THRESHOLD_BACKOFF_SEC).catch(() => undefined);
  }

  /** One 5-minute tick: add any missing schedules, then run a cleanup on every enabled ONLINE server whose
   *  latest reported disk usage is at/above its threshold (throttled to once an hour per server). */
  async sweep(now: Date = new Date()): Promise<{ triggered: string[] }> {
    await this.registerAll(false).catch((e) => this.logger.warn(`cleanup reconcile failed: ${e instanceof Error ? e.message : e}`));
    const servers = await this.prisma.server.findMany({
      where: { cleanupEnabled: true, cleanupThresholdPct: { not: null } },
      select: { id: true, status: true, cleanupEnabled: true, cleanupThresholdPct: true },
    });
    const triggered: string[] = [];
    for (const s of servers) {
      const sample = await this.prisma.metric
        .findFirst({ where: { serverId: s.id }, orderBy: { ts: "desc" }, select: { ts: true, diskUsed: true, diskTotal: true } })
        .catch(() => null);
      if (!shouldTriggerThresholdCleanup({ enabled: s.cleanupEnabled, status: s.status, thresholdPct: s.cleanupThresholdPct, sample, now })) continue;
      if (!(await this.claimThresholdSlot(s.id, now.getTime()))) continue;
      triggered.push(s.id);
      // Same safety as a scheduled run: skip while a deploy is building here. Failures are recorded by the runner.
      try {
        const r = await this.runner.runCleanup(s.id, "threshold", { skipIfDeploying: true });
        if (reclaimedNothing(r)) await this.extendThresholdSlot(s.id, now.getTime());
      } catch (e) {
        this.logger.warn(`threshold cleanup failed for ${s.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { triggered };
  }

  async schedule(serverId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(serverId);
    await this.queue.add(`cleanup:${serverId}`, { serverId }, { repeat: { every: intervalSec * 1000 } });
  }

  /** Schedule cleanup on a cron pattern (e.g. "0 3 * * *" — 03:00 daily) instead of a fixed interval. An
   *  optional IANA timezone makes the cron fire in the server's local time (BullMQ repeat tz). */
  async scheduleCron(serverId: string, cron: string, tz?: string): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(serverId);
    await this.queue.add(`cleanup:${serverId}`, { serverId }, { repeat: { pattern: cron, ...(tz ? { tz } : {}) } });
  }

  async unschedule(serverId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `cleanup:${serverId}`) await this.queue.removeRepeatableByKey(r.key);
    }
  }
}
