import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { RolloutsController } from "./rollouts.controller";
import { RolloutsService } from "./rollouts.service";
import { RolloutEngineService } from "./rollout-engine.service";
import { RolloutSchedulerService } from "./rollout-scheduler.service";

@Module({
  imports: [AgentGatewayModule, ApplicationsModule],
  controllers: [RolloutsController],
  providers: [RolloutsService, RolloutEngineService, RolloutSchedulerService],
  exports: [RolloutsService, RolloutEngineService],
})
export class RolloutsModule {}
