import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { ContainerHealthRunnerService } from "./container-health.runner.service";

const QUEUE = "container-health";

/** Periodic fleet-wide container crash/OOM poll. One global repeatable job (like SwarmSchedulerService),
 *  disabled in tests. */
@Injectable()
export class ContainerHealthSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ContainerHealthSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: ContainerHealthRunnerService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests (house convention)
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => { await this.runner.runTick(); }, { connection });
    const intervalSec = this.config.get<number>("CONTAINER_HEALTH_INTERVAL_SEC") ?? 60;
    await this.queue.add("container-health", {}, { repeat: { every: intervalSec * 1000 } });
    this.logger.log(`scheduled container-health checks every ${intervalSec}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
