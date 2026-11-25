import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { QueueHubService } from "../scheduler/queue-hub.service";
import { reapIfGone } from "../common/orphan-reap";
import { PrismaService } from "../prisma/prisma.service";
import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";

const QUEUE = "scheduled-tasks";

/** Mirrors the backup/cleanup schedulers, but uses a cron pattern per task. */
@Injectable()
export class ScheduledTasksSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledTasksSchedulerService.name);
  private queue?: Queue;

  constructor(
    private readonly hub: QueueHubService,
    private readonly prisma: PrismaService,
    private readonly runner: ScheduledTaskRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    this.queue = this.hub.queue(QUEUE);
    this.hub.worker(
      QUEUE,
      async (job) => {
        const taskId = job.data.taskId as string;
        // Orphan self-heal: the task was deleted (e.g. its app cascaded away) → stop this repeatable.
        if (!(await reapIfGone(taskId, () => this.prisma.scheduledTask.findUnique({ where: { id: taskId }, select: { id: true } }).then(Boolean), (i) => this.unschedule(i)))) return;
        await this.runner.runTask(taskId);
      },
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
}
