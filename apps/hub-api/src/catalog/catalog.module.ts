import { Module } from "@nestjs/common";
import { TemplateCatalogService } from "./template-catalog.service";
import { CatalogSyncRunnerService } from "./catalog-sync-runner.service";
import { CatalogSyncSchedulerService } from "./catalog-sync-scheduler.service";

/**
 * DB-backed template catalog: a signed remote overlay on the bundled catalog, with offline fallback.
 * PrismaService / ConfigService are @Global, so no imports are needed. Exports the read-side service
 * for ApplicationsService; the scheduler self-starts on bootstrap when CATALOG_SOURCE_URL is set.
 */
@Module({
  providers: [TemplateCatalogService, CatalogSyncRunnerService, CatalogSyncSchedulerService],
  exports: [TemplateCatalogService],
})
export class CatalogModule {}
