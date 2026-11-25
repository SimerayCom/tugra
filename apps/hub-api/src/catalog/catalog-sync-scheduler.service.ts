import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { CatalogSyncRunnerService } from "./catalog-sync-runner.service";

/**
 * Opt-in periodic catalog sync (only when CATALOG_SOURCE_URL is set). Mirrors the house recurring-job
 * pattern (BullMQ Queue+Worker in OnApplicationBootstrap, disabled in tests). The INITIAL sync runs
 * directly (not via the queue) so a flaky Redis can't block first sync; only the recurring repeat
 * needs Redis. The runner never throws — offline fallback keeps the bundled catalog serving.
 */
@Injectable()
export class CatalogSyncSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSyncSchedulerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ticks: TickSchedulerService,
    private readonly runner: CatalogSyncRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    if (!this.config.get<string>("CATALOG_SOURCE_URL")) {
      await this.ticks.disable("catalog-sync"); // opt-in switched off after an earlier boot: drop the old schedule
      return; // opt-in
    }
    await this.runner.sync().catch((e) => this.logger.warn(`initial catalog sync failed: ${String(e)}`));
    const intervalMin = this.config.get<number>("CATALOG_SYNC_INTERVAL_MIN") ?? 60;
    await this.ticks.register({ name: "catalog-sync", every: intervalMin * 60_000, run: async () => { await this.runner.sync(); } });
    this.logger.log(`scheduled catalog sync every ${intervalMin}m`);
  }
}
