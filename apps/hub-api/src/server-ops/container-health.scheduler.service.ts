import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { ComposeRestartHealService } from "./compose-restart-heal.service";

const QUEUE = "container-health";

/** Periodic fleet-wide container crash/OOM poll (+ the compose restart-policy self-heal pass). One global repeatable job (like SwarmSchedulerService),
 *  disabled in tests. */
@Injectable()
export class ContainerHealthSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ContainerHealthSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: ContainerHealthRunnerService,
    private readonly restartHeal: ComposeRestartHealService,
  ) {}

  private connection() {
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests (house convention)
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(QUEUE, async () => {
      await this.runner.runTick();
      await this.restartHeal.runTick(); // compose members deployed without a restart policy (never throws)
    }, { connection });
    const intervalSec = this.config.get<number>("CONTAINER_HEALTH_INTERVAL_SEC") ?? 60;
    await this.queue.add("container-health", {}, { repeat: { every: intervalSec * 1000 } });
    this.logger.log(`scheduled container-health checks every ${intervalSec}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
