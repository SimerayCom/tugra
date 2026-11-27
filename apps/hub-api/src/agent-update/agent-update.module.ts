import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { UpdateModule } from "../update/update.module";
import { InFlightModule } from "../in-flight/in-flight.module";
import { AgentUpdateController } from "./agent-update.controller";
import { AgentUpdateService } from "./agent-update.service";
import { AgentRolloutService } from "./agent-rollout.service";

// Owner-triggered agent self-update, plus the automatic one-by-one rollout once the hub is on the latest release. Depends on AgentWsServer (AgentGatewayModule) to send the signed
// command and UpdateService (UpdateModule) for the verified manifest; Prisma/Audit/TeamAccess are @Global.
@Module({
  imports: [AgentGatewayModule, UpdateModule, InFlightModule],
  controllers: [AgentUpdateController],
  providers: [AgentUpdateService, AgentRolloutService],
})
export class AgentUpdateModule {}
