import { Module } from "@nestjs/common";
import { TemplateCatalogService } from "./template-catalog.service";
import { CatalogSyncRunnerService } from "./catalog-sync-runner.service";
import { CatalogSyncSchedulerService } from "./catalog-sync-scheduler.service";
import { CatalogController } from "./catalog.controller";

/**
 * DB-backed template catalog: a signed remote overlay on the bundled catalog, with offline fallback.
 * PrismaService / ConfigService are @Global, so no imports are needed. Exports the read-side service
 * for ApplicationsService; the scheduler self-starts on bootstrap when CATALOG_SOURCE_URL is set.
 * The public catalog API (CatalogController) resolves ApplicationsService lazily via ModuleRef, so no
 * ApplicationsModule import is needed here (which would be a cycle — ApplicationsModule imports this).
 */
@Module({
  controllers: [CatalogController],
  providers: [TemplateCatalogService, CatalogSyncRunnerService, CatalogSyncSchedulerService],
  exports: [TemplateCatalogService],
})
export class CatalogModule {}
