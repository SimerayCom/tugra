import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { CatalogSyncRunnerService } from "./catalog-sync-runner.service";

const QUEUE = "catalog-sync";

/**
 * Opt-in periodic catalog sync (only when CATALOG_SOURCE_URL is set). Mirrors the house recurring-job
 * pattern (BullMQ Queue+Worker in OnApplicationBootstrap, disabled in tests). The INITIAL sync runs
 * directly (not via the queue) so a flaky Redis can't block first sync; only the recurring repeat
 * needs Redis. The runner never throws — offline fallback keeps the bundled catalog serving.
 */
@Injectable()
export class CatalogSyncSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: CatalogSyncRunnerService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    if (!this.config.get<string>("CATALOG_SOURCE_URL")) return; // opt-in
    await this.runner.sync().catch((e) => this.logger.warn(`initial catalog sync failed: ${String(e)}`));
    const intervalMin = this.config.get<number>("CATALOG_SYNC_INTERVAL_MIN") ?? 60;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => { await this.runner.sync(); }, { connection });
    await this.queue.add("catalog-sync", {}, { repeat: { every: intervalMin * 60_000 } });
    this.logger.log(`scheduled catalog sync every ${intervalMin}m`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
