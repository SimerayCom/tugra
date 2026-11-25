import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { Pm2MoveController } from "./pm2-move.controller";
import { Pm2MoveService } from "./pm2-move.service";

// PrismaService, TeamAccessService and AuditService are provided by @Global modules; InstanceOwnerGuard needs only Prisma.
@Module({
  imports: [AgentGatewayModule, ApplicationsModule],
  controllers: [Pm2MoveController],
  providers: [Pm2MoveService],
})
export class Pm2MoveModule {}
