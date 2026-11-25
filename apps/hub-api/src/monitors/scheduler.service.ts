import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { QueueHubService } from "../scheduler/queue-hub.service";
import { PrismaService } from "../prisma/prisma.service";
import { MonitorRunnerService } from "./runner.service";

const QUEUE = "monitors";

@Injectable()
export class MonitorSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonitorSchedulerService.name);
  private queue?: Queue;

  constructor(
    private readonly hub: QueueHubService,
    private readonly prisma: PrismaService,
    private readonly runner: MonitorRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // BullMQ scheduler/worker are disabled in tests; the runner is driven
    // directly via POST /monitors/:id/check there.
    if (process.env.NODE_ENV === "test") return;

    this.queue = this.hub.queue(QUEUE);
    this.hub.worker(QUEUE, async (job) => {
      await this.runner.runCheck(job.data.monitorId as string);
    });

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
}
