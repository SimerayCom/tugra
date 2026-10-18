import { Module } from "@nestjs/common";
import { MigratorModule } from "../migrator/migrator.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ApplicationsModule } from "../applications/applications.module";
import { ImporterController } from "./importer.controller";
import { ImporterService } from "./importer.service";
import { ImportExecutorService } from "./import-executor.service";
import { CoolifyClientFactory } from "./sources/coolify-client.factory";

// Reuses MigratorService (MigratorModule) for local-docker adopt/unadopt, ApplicationsService
// (ApplicationsModule) to create/remove apps for the coolify copy executor, and CryptoService
// (CryptoModule) for the session token at rest. PrismaService, TeamAccessService and AuditService are
// provided by @Global modules.
@Module({
  imports: [MigratorModule, CryptoModule, ApplicationsModule],
  controllers: [ImporterController],
  providers: [ImporterService, ImportExecutorService, CoolifyClientFactory],
})
export class ImporterModule {}
