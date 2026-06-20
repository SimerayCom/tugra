import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";

const QUEUE = "scheduled-tasks";

/** Mirrors the backup/cleanup schedulers, but uses a cron pattern per task. */
@Injectable()
export class ScheduledTasksSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ScheduledTasksSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runner: ScheduledTaskRunnerService,
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
        await this.runner.runTask(job.data.taskId as string);
      },
      { connection },
    );
    const tasks = await this.prisma.scheduledTask.findMany({ where: { enabled: true } });
    for (const t of tasks) await this.schedule(t.id, t.schedule);
    this.logger.log(`scheduled ${tasks.length} task(s)`);
  }

  async schedule(taskId: string, cron: string): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(taskId);
    await this.queue.add(`task:${taskId}`, { taskId }, { repeat: { pattern: cron } });
  }

  async unschedule(taskId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `task:${taskId}`) await this.queue.removeRepeatableByKey(r.key);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
