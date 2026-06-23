import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { VolumeBackupRunnerService } from "./volume-backup-runner.service";

const QUEUE = "volume-backups";

/** Mirrors BackupSchedulerService: BullMQ repeatable jobs, disabled in tests. */
@Injectable()
export class VolumeBackupSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VolumeBackupSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runner: VolumeBackupRunnerService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async (job) => { await this.runner.runBackup(job.data.appId as string); }, { connection });

    const apps = await this.prisma.application.findMany({
      where: { volumeBackupEnabled: true, volumeBackupIntervalHours: { not: null } },
    });
    for (const a of apps) await this.schedule(a.id, (a.volumeBackupIntervalHours ?? 24) * 3600);
    this.logger.log(`scheduled ${apps.length} volume backup(s)`);
  }

  async schedule(appId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(appId);
    await this.queue.add(`volbackup:${appId}`, { appId }, { repeat: { every: intervalSec * 1000 } });
  }

  async unschedule(appId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `volbackup:${appId}`) await this.queue.removeRepeatableByKey(r.key);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
