import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { BackupRunnerService } from "./backup-runner.service";

const QUEUE = "backups";

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
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      maxRetriesPerRequest: null,
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    // The scheduler/worker are disabled in tests; backups are driven directly
    // via POST /databases/:id/backups there.
    if (process.env.NODE_ENV === "test") return;

    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        await this.runner.runBackup(job.data.databaseId as string);
      },
      { connection },
    );

    const dbs = await this.prisma.database.findMany({
      where: { backupEnabled: true, OR: [{ backupIntervalHours: { not: null } }, { backupCron: { not: null } }] },
    });
    // A cron expression wins over the plain interval when both are set.
    for (const d of dbs) {
      if (d.backupCron) await this.scheduleCron(d.id, d.backupCron);
      else await this.schedule(d.id, (d.backupIntervalHours ?? 24) * 3600);
    }
    this.logger.log(`scheduled ${dbs.length} database backup(s)`);
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

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
