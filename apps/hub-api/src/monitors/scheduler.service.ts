import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { MonitorRunnerService } from "./runner.service";

const QUEUE = "monitors";

@Injectable()
export class MonitorSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MonitorSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runner: MonitorRunnerService,
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
    // BullMQ scheduler/worker are disabled in tests; the runner is driven
    // directly via POST /monitors/:id/check there.
    if (process.env.NODE_ENV === "test") return;

    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        await this.runner.runCheck(job.data.monitorId as string);
      },
      { connection },
    );

    const monitors = await this.prisma.monitor.findMany({
      where: { enabled: true },
    });
    for (const m of monitors) await this.schedule(m.id, m.intervalSec);
    this.logger.log(`scheduled ${monitors.length} monitor(s)`);
  }

  async schedule(monitorId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.queue.add(
      `check:${monitorId}`,
      { monitorId },
      { repeat: { every: intervalSec * 1000 } },
    );
  }

  async unschedule(monitorId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `check:${monitorId}`) {
        await this.queue.removeRepeatableByKey(r.key);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
