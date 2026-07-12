import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { MetricsRollupRunnerService } from "./metrics-rollup-runner.service";

const QUEUE = "metrics-rollup";
const ROLLUP_MS = 2 * 60_000; // every 2 minutes: enough that whole minutes are always settled

@Injectable()
export class MetricsRollupSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MetricsRollupSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: MetricsRollupRunnerService,
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
    this.worker = new Worker(QUEUE, async () => this.runner.roll(), { connection });
    await this.queue.add("metrics-rollup", {}, { repeat: { every: ROLLUP_MS } });
    this.logger.log("scheduled 1-minute metrics rollup");
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
