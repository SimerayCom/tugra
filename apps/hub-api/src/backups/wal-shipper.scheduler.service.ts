import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { WalShipperRunnerService } from "./wal-shipper-runner.service";

const QUEUE = "wal-ship";
/** One GLOBAL repeatable sweep (not a per-db job): the runner selects the enabled databases each tick, so there
 *  is no schedule/unschedule to couple to enable/disable/delete and no orphan repeatables to reap — a database
 *  that is disabled or deleted simply stops matching the sweep's query. */
const SWEEP_JOB = "wal-sweep";
const SWEEP_EVERY_MS = 60_000;

/**
 * Drives the WAL shipper (PITR 5.5) on a fixed interval, mirroring BackupSchedulerService / the volume-backup
 * scheduler: a dedicated BullMQ queue + Worker (NOT the shared "backups" queue, whose single Worker could be
 * blocked for up to an hour by a base backup and let the spool grow), disabled under NODE_ENV=test so the e2e
 * suite drives the runner directly. Inert in production until a database is PITR-enabled.
 */
@Injectable()
export class WalShipperSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WalShipperSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: WalShipperRunnerService,
  ) {}

  private connection() {
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === SWEEP_JOB) await this.runner.shipAll();
      },
      { connection },
    );
    // Idempotent re-add of the single sweep (fixed jobId, like the backup watchdog).
    await this.queue.add(SWEEP_JOB, {}, { repeat: { every: SWEEP_EVERY_MS }, jobId: SWEEP_JOB });
    this.logger.log("WAL shipper sweep scheduled");
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
