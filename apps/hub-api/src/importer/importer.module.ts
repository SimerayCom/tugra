import { Module } from "@nestjs/common";
import { MigratorModule } from "../migrator/migrator.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ApplicationsModule } from "../applications/applications.module";
import { DatabasesModule } from "../databases/databases.module";
import { BackupsModule } from "../backups/backups.module";
import { ImporterController } from "./importer.controller";
import { MigrationIngestController } from "./migration-ingest.controller";
import { MigrationArtifactController } from "./migration-artifact.controller";
import { ImporterService } from "./importer.service";
import { ImportExecutorService } from "./import-executor.service";
import { MigrationTokenService } from "./migration-token.service";
import { MigrationTokenGuard } from "./migration-token.guard";
import { MigrationIngestService } from "./migration-ingest.service";
import { CoolifyClientFactory } from "./sources/coolify-client.factory";

// Reuses MigratorService (MigratorModule) for local-docker adopt/unadopt, ApplicationsService
// (ApplicationsModule) to create/remove apps and DatabasesService (DatabasesModule) to provision
// databases for the coolify copy executor, and CryptoService (CryptoModule) for the session token at
// rest. PrismaService, TeamAccessService and AuditService are provided by @Global modules.
@Module({
  imports: [MigratorModule, CryptoModule, ApplicationsModule, DatabasesModule, BackupsModule],
  controllers: [ImporterController, MigrationIngestController, MigrationArtifactController],
  providers: [ImporterService, ImportExecutorService, MigrationTokenService, MigrationTokenGuard, MigrationIngestService, CoolifyClientFactory],
  exports: [ImporterService, ImportExecutorService], // the MCP server wraps these as import_* tools
})
export class ImporterModule {}
