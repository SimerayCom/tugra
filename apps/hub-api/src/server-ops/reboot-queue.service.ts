import { Injectable, Logger } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { rebootTiming } from "./reboot-logic";

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
 * Scheduler side of the reboot feature, on the shared scheduler queue: one delayed job per scheduled reboot (precise
 * start) and one recurring tick that watches every live reboot (verification polling, recovery after a hub restart).
 * The database is the source of truth: the delayed job is only a precise trigger, and the tick also starts any
 * scheduled reboot that is due whether or not its job survived (Redis flushed, or restarted with the host it runs on).
 * Disabled in tests, like the other schedulers.
 */
@Injectable()
export class RebootQueueService {
  private readonly logger = new Logger(RebootQueueService.name);

  constructor(private readonly ticks: TickSchedulerService) {}

  /** Register the delayed-job handler and start the watcher. A no-op under NODE_ENV=test. */
  async start(handlers: RebootQueueHandlers): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    this.ticks.handle(DUE_JOB, async (job) => {
      try {
        await handlers.due(String((job.data as { rebootId?: string }).rebootId ?? ""));
      } catch (e) {
        this.logger.warn(`reboot job ${DUE_JOB} failed: ${String(e)}`);
        throw e;
      }
    });
    await this.ticks.register({ name: TICK_JOB, every: rebootTiming.tickMs, run: () => handlers.tick() });
    this.logger.log(`watching server reboots every ${rebootTiming.tickMs / 1000}s`);
  }

  /** Queue the delayed trigger for a scheduled reboot. Idempotent by job id (re-adding after a restart is harmless). */
  async scheduleAt(rebootId: string, at: Date, now = Date.now()): Promise<void> {
    await this.ticks.enqueueAt(DUE_JOB, { rebootId }, rebootJobId(rebootId), at, now);
  }

  /** Drop a scheduled reboot's pending trigger (cancelled, or already started). */
  async unschedule(rebootId: string): Promise<void> {
    await this.ticks.removeJob(rebootJobId(rebootId));
  }
}
