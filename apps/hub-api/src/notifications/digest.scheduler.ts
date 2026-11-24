import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { DigestService } from "./digest.service";

const QUEUE = "notify-digest";
const SWEEP_EVERY_MS = 15 * 60_000;

/** A BullMQ repeatable sweep (every 15 minutes) that sends whichever weekly digests have come due. Off in tests. */
@Injectable()
export class DigestSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DigestSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly digest: DigestService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(QUEUE, async () => void (await this.digest.runDue()), { connection });
    this.worker.on("error", (err) => this.logger.error(`digest worker error: ${err.message}`));
    await this.queue
      .add("digest-sweep", {}, { repeat: { every: SWEEP_EVERY_MS } })
      .catch((e) => this.logger.warn(`weekly digest sweep not scheduled: ${e instanceof Error ? e.message : e}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
