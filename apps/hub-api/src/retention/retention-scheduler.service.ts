import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { RetentionRunnerService } from "./retention-runner.service";

const QUEUE = "retention-prune";
const HOURLY_MS = 3600 * 1000;

@Injectable()
export class RetentionSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RetentionSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: RetentionRunnerService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      maxRetriesPerRequest: null,
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    // Disabled in tests; the runner is exercised directly via unit specs.
    if (process.env.NODE_ENV === "test") return;

    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => this.runner.prune(), { connection });
    await this.queue.add("retention-prune", {}, { repeat: { every: HOURLY_MS } });
    this.logger.log("scheduled hourly metrics/heartbeat retention prune");
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
