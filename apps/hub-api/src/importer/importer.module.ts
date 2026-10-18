import { Module } from "@nestjs/common";
import { MigratorModule } from "../migrator/migrator.module";
import { ImporterController } from "./importer.controller";
import { ImporterService } from "./importer.service";

// Reuses MigratorService (exported by MigratorModule) for the local-docker source. PrismaService,
// TeamAccessService and AuditService are provided by @Global modules.
@Module({
  imports: [MigratorModule],
  controllers: [ImporterController],
  providers: [ImporterService],
})
export class ImporterModule {}
