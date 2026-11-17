import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { UpdateService } from "./update.service";
import { UpdaterService } from "./updater.service";
import { UpdateCheckSchedulerService } from "./update-check.scheduler.service";
import { StackConvergeService } from "./stack-converge.service";

/**
 * Self-update. UpdateService (CHECK) + UpdaterService (APPLY) depend only on @Global providers
 * (ConfigService, the @Global InstanceSettingsService, and the @Global RedisService), so nothing needs
 * importing for them. Both are exported so the owner-only InstanceSettingsController (declared in AppModule)
 * can inject them for GET/POST /instance/update + the SSE stream. StackConvergeService brings the update helper
 * and the bundled agent onto the hub's release through the local agent (AgentWsServer), hence AgentGatewayModule.
 */
@Module({
  imports: [AgentGatewayModule],
  providers: [UpdateService, UpdaterService, UpdateCheckSchedulerService, StackConvergeService],
  exports: [UpdateService, UpdaterService, StackConvergeService],
})
export class UpdateModule {}
