import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { UpdateModule } from "../update/update.module";
import { AgentUpdateController } from "./agent-update.controller";
import { AgentUpdateService } from "./agent-update.service";

// Owner-triggered agent self-update. Depends on AgentWsServer (AgentGatewayModule) to send the signed
// command and UpdateService (UpdateModule) for the verified manifest; Prisma/Audit/TeamAccess are @Global.
@Module({
  imports: [AgentGatewayModule, UpdateModule],
  controllers: [AgentUpdateController],
  providers: [AgentUpdateService],
})
export class AgentUpdateModule {}
