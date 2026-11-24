import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { SnapshotService } from "./snapshot.service";

const TICK_MS = 60_000;
const SWEEP_EVERY_TICKS = 30;

/** A one-minute loop: take the planned safety copies whose data copy finished, and (every half hour) remove expired ones. Off in tests. */
@Injectable()
export class SnapshotSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SnapshotSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  private busy = false;

  constructor(private readonly snapshots: SnapshotService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.busy) return; // a long copy must not stack ticks
    this.busy = true;
    try {
      await this.snapshots.runDue();
      if (this.ticks++ % SWEEP_EVERY_TICKS === 0) await this.snapshots.sweepExpired();
    } catch (e) {
      this.logger.warn(`snapshot tick failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
