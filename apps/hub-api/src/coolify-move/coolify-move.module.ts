import { Module } from "@nestjs/common";
import { CoolifyCleanupModule } from "../coolify-cleanup/coolify-cleanup.module";
import { CoolifyInPlaceModule } from "../coolify-inplace/coolify-inplace.module";
import { CoolifyTakeoverModule } from "../coolify-takeover/coolify-takeover.module";
import { MigrationCampaignsModule } from "../migration-campaigns/migration-campaigns.module";
import { ProjectMovesModule } from "../project-moves/project-moves.module";
import { CoolifyMoveController } from "./coolify-move.controller";
import { CoolifyMoveService } from "./coolify-move.service";

// PrismaService and TeamAccessService come from @Global modules.
@Module({
  imports: [CoolifyTakeoverModule, CoolifyInPlaceModule, CoolifyCleanupModule, MigrationCampaignsModule, ProjectMovesModule],
  controllers: [CoolifyMoveController],
  providers: [CoolifyMoveService],
  exports: [CoolifyMoveService],
})
export class CoolifyMoveModule {}
