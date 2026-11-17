import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { ComposeRestartHealService } from "./compose-restart-heal.service";

const QUEUE = "compose-restart-heal";
/** The tick fires often; the per-server throttle inside the service (HEAL_INTERVAL_MS) decides who is actually due. */
export const HEAL_TICK_MS = 5 * 60 * 1000;

/** Own repeatable job for the compose restart-policy self-heal, so a slow or hung agent cannot delay the 60s container-health crash/OOM poll.
 *  Disabled in tests (house convention). */
@Injectable()
export class ComposeRestartHealSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ComposeRestartHealSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly heal: ComposeRestartHealService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(QUEUE, async () => { await this.heal.runTick(); }, { connection });
    await this.queue.add("compose-restart-heal", {}, { repeat: { every: HEAL_TICK_MS } });
    this.logger.log(`scheduled compose restart-policy heal every ${HEAL_TICK_MS / 1000}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
