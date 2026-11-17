import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { ContainerHealthRunnerService } from "./container-health.runner.service";

const QUEUE = "container-health";
// While a container is mid-transition (starting / restarting / just died) re-check this often instead of waiting
// for the next interval, so a container that comes back healthy reaches the app header and crash timeline within
// seconds. Bounded PER CONTAINER: a container that stays settling for MAX_FAST_CHECKS polls in a row (stuck
// "starting", crash-looping "restarting") stops buying quick re-checks, but never starves another container's
// transition, which starts with a fresh budget. A container that settles (or disappears) is forgotten.
const FAST_INTERVAL_MS = 10_000;
const MAX_FAST_CHECKS = 30;

/** Periodic fleet-wide container crash/OOM poll. One global repeatable job (like SwarmSchedulerService),
 *  disabled in tests. */
@Injectable()
export class ContainerHealthSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ContainerHealthSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;
  private fastTimer?: NodeJS.Timeout;
  private readonly streaks = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: ContainerHealthRunnerService,
  ) {}

  private connection() {
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests (house convention)
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(QUEUE, async () => { await this.tickAndFollowUp(); }, { connection });
    const intervalSec = this.config.get<number>("CONTAINER_HEALTH_INTERVAL_SEC") ?? 60;
    await this.queue.add("container-health", {}, { repeat: { every: intervalSec * 1000 } });
    this.logger.log(`scheduled container-health checks every ${intervalSec}s`);
  }

  /** Run one poll; if a container is still settling, schedule a quick re-check (never more than one pending). */
  async tickAndFollowUp(): Promise<void> {
    const { settlingKeys } = await this.runner.runTick();
    if (this.stopped) return;
    // Consecutive settling polls per container; anything not settling this run drops out (budget resets).
    const next = new Map<string, number>();
    for (const key of settlingKeys) next.set(key, (this.streaks.get(key) ?? 0) + 1);
    this.streaks.clear();
    for (const [k, v] of next) this.streaks.set(k, v);
    // The interval tick counts as streak 1, so a container gets MAX_FAST_CHECKS quick re-checks after it.
    const budgeted = [...next.values()].some((n) => n <= MAX_FAST_CHECKS);
    if (!budgeted || this.fastTimer) return;
    this.fastTimer = setTimeout(() => {
      this.fastTimer = undefined;
      this.tickAndFollowUp().catch((e) => this.logger.warn(`fast container-health check failed: ${String(e)}`));
    }, FAST_INTERVAL_MS);
    this.fastTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.fastTimer) clearTimeout(this.fastTimer);
    await this.worker?.close();
    await this.queue?.close();
  }
}
