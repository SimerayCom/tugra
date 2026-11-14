import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { RolloutEngineService } from "./rollout-engine.service";

const QUEUE = "rollout-tick";
const TICK_JOB = "rollout-tick";
const TICK_EVERY_MS = 5_000;
const BOOT_KICK_MS = 3_000;

/**
 * Drives the rollout engine's stateless tick on a short fixed interval (its own BullMQ queue, like the other
 * schedulers; a tick never awaits a build). Disabled under NODE_ENV=test — specs call tick()/advance()
 * directly. A boot kick settles what the previous process left behind as soon as the reconcile has run.
 */
@Injectable()
export class RolloutSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RolloutSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;
  private kick?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly config: ConfigService,
    private readonly engine: RolloutEngineService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === TICK_JOB) await this.engine.tick();
      },
      { connection },
    );
    await this.queue.add(TICK_JOB, {}, { repeat: { every: TICK_EVERY_MS }, jobId: TICK_JOB });
    this.kick = setTimeout(() => void this.engine.tick().catch(() => undefined), BOOT_KICK_MS);
    this.kick.unref();
    this.logger.log("rollout tick scheduled");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.kick) clearTimeout(this.kick);
    await this.worker?.close();
    await this.queue?.close();
  }
}
