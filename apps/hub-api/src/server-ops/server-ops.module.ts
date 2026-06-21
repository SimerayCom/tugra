import { Module, type OnModuleInit } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoModule } from "../crypto/crypto.module";
import { ServerOpsController } from "./server-ops.controller";
import { CleanupService } from "./cleanup.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { PatchService } from "./patch.service";
import { LogDrainService } from "./log-drain.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule],
  controllers: [ServerOpsController],
  providers: [CleanupService, CleanupRunnerService, CleanupSchedulerService, PatchService, LogDrainService],
})
export class ServerOpsModule implements OnModuleInit {
  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly logDrains: LogDrainService,
  ) {}

  onModuleInit(): void {
    // Re-push a server's log-drain config whenever its agent (re)connects.
    this.agentWs.setLogDrainProvider((serverId) => {
      void this.logDrains.pushToAgent(serverId).catch(() => undefined);
    });
  }
}
