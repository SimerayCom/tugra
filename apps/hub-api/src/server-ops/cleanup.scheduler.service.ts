import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { CleanupRunnerService } from "./cleanup-runner.service";

const QUEUE = "cleanup";

/** Mirrors the backup/monitor schedulers: BullMQ repeatable jobs, disabled in tests. */
@Injectable()
export class CleanupSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CleanupSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runner: CleanupRunnerService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        await this.runner.runCleanup(job.data.serverId as string);
      },
      { connection },
    );
    const servers = await this.prisma.server.findMany({
      where: { cleanupEnabled: true, cleanupIntervalHours: { not: null } },
    });
    for (const s of servers) await this.schedule(s.id, (s.cleanupIntervalHours ?? 24) * 3600);
    this.logger.log(`scheduled ${servers.length} docker cleanup(s)`);
  }

  async schedule(serverId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(serverId);
    await this.queue.add(`cleanup:${serverId}`, { serverId }, { repeat: { every: intervalSec * 1000 } });
  }

  async unschedule(serverId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `cleanup:${serverId}`) await this.queue.removeRepeatableByKey(r.key);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
