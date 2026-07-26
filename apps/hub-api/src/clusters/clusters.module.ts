import { Module } from "@nestjs/common";
import { ClustersController } from "./clusters.controller";
import { ClustersService } from "./clusters.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  controllers: [ClustersController],
  providers: [ClustersService],
})
export class ClustersModule {}
