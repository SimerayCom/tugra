import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { reapIfGone } from "../common/orphan-reap";
import { PrismaService } from "../prisma/prisma.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";

const QUEUE = "backups";
/** Repeatable job that runs the missing-backup watchdog (not a per-database backup). */
const WATCHDOG_JOB = "watchdog";
const WATCHDOG_EVERY_MS = 3_600_000; // hourly

/** Mirrors MonitorSchedulerService: BullMQ repeatable jobs, disabled in tests. */
@Injectable()
export class BackupSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BackupSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runner: BackupRunnerService,
    private readonly alerts: BackupAlertsService,
  ) {}

  private connection() {
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  async onApplicationBootstrap(): Promise<void> {
    // The scheduler/worker are disabled in tests; backups are driven directly
    // via POST /databases/:id/backups there.
    if (process.env.NODE_ENV === "test") return;

    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === WATCHDOG_JOB) {
          await this.alerts.checkDatabases();
          await this.alerts.checkVerifyLiveness();
          return;
        }
        const databaseId = job.data.databaseId as string;
        const stillExists = () => this.prisma.database.findUnique({ where: { id: databaseId }, select: { id: true } }).then(Boolean);
        // The verify branch MUST come before the backup fall-through, or a verify tick would run a backup.
        if (job.name.startsWith("verify:")) {
          // Orphan self-heal: the database was deleted → stop this repeatable instead of failing every tick.
          if (!(await reapIfGone(databaseId, stillExists, (i) => this.unscheduleVerify(i)))) return;
          await this.runner.verifyScheduled(databaseId);
          return;
        }
        if (!(await reapIfGone(databaseId, stillExists, (i) => this.unschedule(i)))) return;
        await this.runner.runBackup(databaseId);
      },
      { connection },
    );

    // Missing-backup watchdog: a schedule that silently stops producing runs fires nothing by itself, so
    // check periodically that every backup-enabled database has a recent SUCCESS. Idempotent re-add.
    await this.queue.add(WATCHDOG_JOB, {}, { repeat: { every: WATCHDOG_EVERY_MS }, jobId: WATCHDOG_JOB });

    const dbs = await this.prisma.database.findMany({
      where: { backupEnabled: true, OR: [{ backupIntervalHours: { not: null } }, { backupCron: { not: null } }] },
    });
    let ok = 0;
    // A cron expression wins over the plain interval when both are set.
    for (const d of dbs) {
      // A bad stored cron must not crash the hub at boot (BullMQ throws inside queue.add; this loop is
      // unguarded in onApplicationBootstrap). Skip the offending database and keep scheduling the rest.
      try {
        if (d.backupCron) await this.scheduleCron(d.id, d.backupCron);
        else await this.schedule(d.id, (d.backupIntervalHours ?? 24) * 3600);
        ok++;
      } catch (e) {
        this.logger.warn(`skipped backup schedule for database ${d.id} (bad cron "${d.backupCron}"): ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`scheduled ${ok}/${dbs.length} database backup(s)`);

    // Enroll the verify schedules the same way (own per-db try/catch so a stale bad verifyCron can't crash boot).
    const verifyDbs = await this.prisma.database.findMany({
      where: { verifyEnabled: true, OR: [{ verifyIntervalHours: { not: null } }, { verifyCron: { not: null } }] },
    });
    let vok = 0;
    for (const d of verifyDbs) {
      try {
        if (d.verifyCron) await this.scheduleVerifyCron(d.id, d.verifyCron);
        else await this.scheduleVerify(d.id, (d.verifyIntervalHours ?? 24) * 3600);
        vok++;
      } catch (e) {
        this.logger.warn(`skipped verify schedule for database ${d.id} (bad cron "${d.verifyCron}"): ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`scheduled ${vok}/${verifyDbs.length} database verify drill(s)`);
  }

  async schedule(databaseId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(databaseId);
    await this.queue.add(
      `backup:${databaseId}`,
      { databaseId },
      { repeat: { every: intervalSec * 1000 } },
    );
  }

  /** Schedule a backup on a cron pattern (e.g. "0 3 * * *" — 03:00 daily) instead of a fixed interval. */
  async scheduleCron(databaseId: string, cron: string): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(databaseId);
    await this.queue.add(`backup:${databaseId}`, { databaseId }, { repeat: { pattern: cron } });
  }

  async unschedule(databaseId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `backup:${databaseId}`) {
        await this.queue.removeRepeatableByKey(r.key);
      }
    }
  }

  // ── restore-verify drill: a SECOND repeatable family, keyed `verify:<id>` so it never collides with
  //    `backup:<id>` or the watchdog. Mirrors schedule/scheduleCron/unschedule exactly. ──

  async scheduleVerify(databaseId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.unscheduleVerify(databaseId);
    await this.queue.add(`verify:${databaseId}`, { databaseId }, { repeat: { every: intervalSec * 1000 } });
  }

  /** Schedule the verify drill on a cron pattern (e.g. "0 4 * * 0" — 04:00 every Sunday). */
  async scheduleVerifyCron(databaseId: string, cron: string): Promise<void> {
    if (!this.queue) return;
    await this.unscheduleVerify(databaseId);
    await this.queue.add(`verify:${databaseId}`, { databaseId }, { repeat: { pattern: cron } });
  }

  async unscheduleVerify(databaseId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `verify:${databaseId}`) {
        await this.queue.removeRepeatableByKey(r.key);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
