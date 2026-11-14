import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { ImageUpdateService } from "./image-update.service";

const QUEUE = "image-update-check";
const TICK_EVERY_MS = 10 * 60 * 1000; // fixed; per-app due-gating bounds the real probe rate to the configured interval
const BOOT_DELAY_MS = 2 * 60 * 1000;

/** Periodic "image update available" probe tick (one global repeatable job, like container-health). Disabled in
 *  tests, and not scheduled at all when IMAGE_UPDATE_CHECK_INTERVAL_MIN=0 (operator kill switch). */
@Injectable()
export class ImageUpdateSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ImageUpdateSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;
  private bootTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: ImageUpdateService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests (house convention)
    if (this.runner.intervalMin() === 0) {
      this.logger.log("image-update checks are disabled (IMAGE_UPDATE_CHECK_INTERVAL_MIN=0)");
      return;
    }
    const connection = redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(QUEUE, async () => { await this.runner.runTick(); }, { connection });
    await this.queue.add("image-update-check", {}, { repeat: { every: TICK_EVERY_MS } });
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
    await this.worker?.close();
    await this.queue?.close();
  }
}
