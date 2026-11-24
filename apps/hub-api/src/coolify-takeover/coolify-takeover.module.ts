import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ServersModule } from "../servers/servers.module";
import { CoolifyTakeoverController } from "./coolify-takeover.controller";
import { CoolifyTakeoverService } from "./coolify-takeover.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [AgentGatewayModule, ServersModule],
  controllers: [CoolifyTakeoverController],
  providers: [CoolifyTakeoverService],
})
export class CoolifyTakeoverModule {}
