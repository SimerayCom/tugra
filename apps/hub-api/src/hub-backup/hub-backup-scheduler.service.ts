import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { HubBackupRunnerService } from "./hub-backup-runner.service";

const QUEUE = "hub-backup";
const JOB = "hub-backup"; // single repeatable job (one hub DB)

/** Mirrors BackupSchedulerService: a single BullMQ repeatable job for the hub-DB backup, disabled in tests. */
@Injectable()
export class HubBackupSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HubBackupSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runner: HubBackupRunnerService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // driven directly via POST /instance/backup/run in tests
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => { await this.runner.runBackup("scheduler"); }, { connection });
    const cfg = await this.prisma.hubBackupConfig.findUnique({ where: { id: "singleton" } });
    await this.apply(cfg ?? null);
  }

  /** (Re)apply the schedule from the current config: unschedule, then schedule a repeatable job if enabled. */
  async apply(cfg: { enabled: boolean; intervalHours: number } | null): Promise<void> {
    if (!this.queue) return;
    await this.unschedule();
    if (cfg?.enabled) {
      await this.queue.add(JOB, {}, { repeat: { every: cfg.intervalHours * 3600_000 } });
      this.logger.log(`hub backup scheduled every ${cfg.intervalHours}h`);
    }
  }

  async unschedule(): Promise<void> {
    if (!this.queue) return;
    for (const r of await this.queue.getRepeatableJobs()) {
      if (r.name === JOB) await this.queue.removeRepeatableByKey(r.key);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
