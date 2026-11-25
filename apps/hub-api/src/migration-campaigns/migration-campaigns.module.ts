import { Module } from "@nestjs/common";
import { MigrationCampaignsService } from "./migration-campaigns.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules. Lane E adds its imports and controller here.
@Module({
  providers: [MigrationCampaignsService],
  exports: [MigrationCampaignsService],
})
export class MigrationCampaignsModule {}
