import { Module } from "@nestjs/common";
import { CoolifyInPlaceModule } from "../coolify-inplace/coolify-inplace.module";
import { ImporterModule } from "../importer/importer.module";
import { MigrationRunsModule } from "../migration-runs/migration-runs.module";
import { CampaignFactsService } from "./campaign-facts.service";
import { MigrationCampaignsController } from "./migration-campaigns.controller";
import { MigrationCampaignsService } from "./migration-campaigns.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [ImporterModule, MigrationRunsModule, CoolifyInPlaceModule],
  controllers: [MigrationCampaignsController],
  providers: [CampaignFactsService, MigrationCampaignsService],
  exports: [MigrationCampaignsService],
})
export class MigrationCampaignsModule {}
