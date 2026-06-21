import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ServerOpsController } from "./server-ops.controller";
import { CleanupService } from "./cleanup.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { PatchService } from "./patch.service";

@Module({
  imports: [AgentGatewayModule],
  controllers: [ServerOpsController],
  providers: [CleanupService, CleanupRunnerService, CleanupSchedulerService, PatchService],
})
export class ServerOpsModule {}
