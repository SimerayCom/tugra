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
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        const taskId = job.data.taskId as string;
        // Orphan self-heal: the task was deleted (e.g. its app cascaded away) → stop this repeatable.
        if (!(await reapIfGone(taskId, () => this.prisma.scheduledTask.findUnique({ where: { id: taskId }, select: { id: true } }).then(Boolean), (i) => this.unschedule(i)))) return;
        await this.runner.runTask(taskId);
      },
      { connection },
    );
    const tasks = await this.prisma.scheduledTask.findMany({ where: { enabled: true } });
    let ok = 0;
    for (const t of tasks) {
      // One task with an unschedulable cron (e.g. a row that predates cron validation) must never crash the
      // hub at boot — BullMQ throws inside queue.add for an invalid pattern, and this loop is unguarded in
      // onApplicationBootstrap, so a single bad row would crash-loop the process. Skip it and keep going.
      try {
        await this.schedule(t.id, t.schedule);
        ok++;
      } catch (e) {
        this.logger.warn(`skipped scheduled task ${t.id} (bad schedule "${t.schedule}"): ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`scheduled ${ok}/${tasks.length} task(s)`);
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
