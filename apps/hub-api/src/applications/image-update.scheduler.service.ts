import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { ImageUpdateService } from "./image-update.service";

const TICK_EVERY_MS = 10 * 60 * 1000; // fixed; per-app due-gating bounds the real probe rate to the configured interval
const BOOT_DELAY_MS = 2 * 60 * 1000;

/** Periodic "image update available" probe tick (one global repeatable job, like container-health). Disabled in
 *  tests, and not scheduled at all when IMAGE_UPDATE_CHECK_INTERVAL_MIN=0 (operator kill switch). */
@Injectable()
export class ImageUpdateSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ImageUpdateSchedulerService.name);
  private bootTimer?: NodeJS.Timeout;

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly runner: ImageUpdateService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests (house convention)
    if (this.runner.intervalMin() === 0) {
      this.logger.log("image-update checks are disabled (IMAGE_UPDATE_CHECK_INTERVAL_MIN=0)");
      await this.ticks.disable("image-update-check"); // kill switch flipped after an earlier boot: drop the old schedule
      return;
    }
    await this.ticks.register({ name: "image-update-check", every: TICK_EVERY_MS, run: async () => { await this.runner.runTick(); } });
    // One direct tick shortly after boot so a fresh hub doesn't wait a full repeat period for its first probes.
    try {
      this.bootTimer = setTimeout(() => { void this.runner.runTick(); }, BOOT_DELAY_MS);
      this.bootTimer.unref();
    } catch {
      /* best-effort */
    }
    this.logger.log(`scheduled image-update checks (tick every ${TICK_EVERY_MS / 60_000}m, per-app interval ${this.runner.intervalMin()}m)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }
}
