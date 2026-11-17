import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { rebootTiming } from "./reboot-logic";

const QUEUE = "server-reboot";
const TICK_JOB = "reboot-tick";
const DUE_JOB = "reboot-due";

/** What the queue calls back into (the reboot service registers it; the queue never imports the service). */
export interface RebootQueueHandlers {
  /** The recurring watcher: advance every live reboot. */
  tick: () => Promise<void>;
  /** A scheduled reboot's delayed job fired. */
  due: (rebootId: string) => Promise<void>;
}

export const rebootJobId = (rebootId: string) => `reboot-${rebootId}`;

/**
 * BullMQ side of the reboot feature: one delayed job per scheduled reboot (precise start) and one recurring tick that
 * watches every live reboot (verification polling, recovery after a hub restart). The database is the source of truth:
 * the delayed job is only a precise trigger, and the tick also starts any scheduled reboot that is due whether or not
 * its job survived (Redis flushed, or restarted with the host it runs on). Disabled in tests, like the other schedulers.
 */
@Injectable()
export class RebootQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(RebootQueueService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly config: ConfigService) {}

  /** Connect and start the watcher. A no-op under NODE_ENV=test. */
  async start(handlers: RebootQueueHandlers): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === TICK_JOB) await handlers.tick();
        else if (job.name === DUE_JOB) await handlers.due(String((job.data as { rebootId?: string }).rebootId ?? ""));
      },
      { connection },
    );
    this.worker.on("failed", (job, err) => this.logger.warn(`reboot job ${job?.name} failed: ${String(err)}`));
    await this.queue.add(TICK_JOB, {}, { repeat: { every: rebootTiming.tickMs } });
    this.logger.log(`watching server reboots every ${rebootTiming.tickMs / 1000}s`);
  }

  /** Queue the delayed trigger for a scheduled reboot. Idempotent by job id (re-adding after a restart is harmless). */
  async scheduleAt(rebootId: string, at: Date, now = Date.now()): Promise<void> {
    if (!this.queue) return;
    await this.queue.add(DUE_JOB, { rebootId }, { jobId: rebootJobId(rebootId), delay: Math.max(0, at.getTime() - now) });
  }

  /** Drop a scheduled reboot's pending trigger (cancelled, or already started). */
  async unschedule(rebootId: string): Promise<void> {
    if (!this.queue) return;
    await this.queue.remove(rebootJobId(rebootId)).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
