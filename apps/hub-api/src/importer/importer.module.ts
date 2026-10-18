import { Module } from "@nestjs/common";
import { MigratorModule } from "../migrator/migrator.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ImporterController } from "./importer.controller";
import { ImporterService } from "./importer.service";
import { ImportExecutorService } from "./import-executor.service";
import { CoolifyClientFactory } from "./sources/coolify-client.factory";

// Reuses MigratorService (exported by MigratorModule) for the local-docker source + adopt/unadopt, and
// CryptoService (CryptoModule) to encrypt the Coolify session token at rest. PrismaService,
// TeamAccessService and AuditService are provided by @Global modules.
@Module({
  imports: [MigratorModule, CryptoModule],
  controllers: [ImporterController],
  providers: [ImporterService, ImportExecutorService, CoolifyClientFactory],
})
export class ImporterModule {}
