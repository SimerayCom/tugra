import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { AppMovesModule } from "../app-moves/app-moves.module";
import { ApplicationsModule } from "../applications/applications.module";
import { BackupsModule } from "../backups/backups.module";
import { DatabasesModule } from "../databases/databases.module";
import { ProjectMoveRecoveryService } from "./project-move-recovery.service";
import { ProjectMoveRunnerService } from "./project-move-runner.service";
import { ProjectMovesController } from "./project-moves.controller";
import { ProjectMovesService } from "./project-moves.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [AgentGatewayModule, AppMovesModule, ApplicationsModule, BackupsModule, DatabasesModule],
  controllers: [ProjectMovesController],
  providers: [ProjectMovesService, ProjectMoveRunnerService, ProjectMoveRecoveryService],
  exports: [ProjectMovesService],
})
export class ProjectMovesModule {}
