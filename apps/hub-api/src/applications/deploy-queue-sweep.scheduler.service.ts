import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { ApplicationsService } from "./applications.service";

const QUEUE = "deploy-queue-sweep";
const HOURLY_MS = 3600 * 1000;
// A QUEUED deploy whose server's agent never reconnects is cancelled once it is older than this. Generous
// (default 6h) — far beyond any real deploy PLUS a transient reboot/network-blip reconnect window — so a
// server that is merely rebooting is never swept. Env-overridable via DEPLOY_QUEUE_MAX_AGE_MS.
const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000;

/**
 * Backstop for QUEUED deploys that survive a hub restart (see DeploymentReconcileService): a restart no
 * longer cancels them — they re-drive when their server's agent reconnects — so this hourly sweep is what
 * guarantees a row whose server NEVER comes back (offline forever, deleted, or a stuck-QUEUED bug) doesn't
 * linger forever. Mirrors ExpirySchedulerService: a BullMQ repeatable job, disabled in tests (the sweep DB
 * logic is unit-tested directly on ApplicationsService). Keeps the Deployment mutation on ApplicationsService,
 * the single owner of deploy-row writes.
 */
@Injectable()
export class DeployQueueSweepSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DeployQueueSweepSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly apps: ApplicationsService,
  ) {}

  private connection() {
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  /** The stale-QUEUED cancel threshold (env DEPLOY_QUEUE_MAX_AGE_MS, default 6h). A non-positive / garbage
   *  value falls back to the default so a bad env can never shrink the window and cancel fresh rows. */
  private maxAgeMs(): number {
    const raw = Number(process.env.DEPLOY_QUEUE_MAX_AGE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
  }

  async onApplicationBootstrap(): Promise<void> {
    // Disabled in tests; the sweep DB logic is exercised directly via ApplicationsService unit specs.
    if (process.env.NODE_ENV === "test") return;

    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(
      QUEUE,
      async () => {
        const cancelled = await this.apps.sweepStaleQueued(this.maxAgeMs());
        if (cancelled > 0) {
          this.logger.warn(`cancelled ${cancelled} stale QUEUED deploy(s) (server's agent never reconnected)`);
        }
      },
      { connection },
    );
    await this.queue.add("deploy-queue-sweep", {}, { repeat: { every: HOURLY_MS } });
    this.logger.log("scheduled hourly stale-QUEUED deploy sweep");
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
