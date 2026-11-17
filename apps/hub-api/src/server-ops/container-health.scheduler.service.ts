import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { ContainerHealthRunnerService } from "./container-health.runner.service";

const QUEUE = "container-health";
// While a container is mid-transition (starting / restarting / just died) re-check this often instead of waiting
// for the next interval, so a container that comes back healthy reaches the app header and crash timeline within
// seconds. Bounded: after MAX_FAST_CHECKS in a row (a container stuck "starting" for ages) it falls back to the
// normal cadence, and an episode that ends (nothing settling) resets the count.
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
  private fastChecks = 0;
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
    const { settling } = await this.runner.runTick();
    if (this.stopped) return;
    if (!settling) {
      this.fastChecks = 0;
      return;
    }
    if (this.fastTimer || this.fastChecks >= MAX_FAST_CHECKS) return;
    this.fastChecks++;
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
