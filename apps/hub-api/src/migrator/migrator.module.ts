import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { MigratorController } from "./migrator.controller";
import { MigratorService } from "./migrator.service";

// PrismaService, TeamAccessService and AuditService are provided by @Global modules.
@Module({
  imports: [AgentGatewayModule, ApplicationsModule],
  controllers: [MigratorController],
  providers: [MigratorService],
})
export class MigratorModule {}
