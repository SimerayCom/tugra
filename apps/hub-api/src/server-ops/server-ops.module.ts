import { Module, type OnModuleInit } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { MetricsModule } from "../metrics/metrics.module";
import { CryptoModule } from "../crypto/crypto.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ServersModule } from "../servers/servers.module";
import { ServerOpsController } from "./server-ops.controller";
import { FleetController } from "./fleet.controller";
import { CleanupService } from "./cleanup.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { PatchService } from "./patch.service";
import { LogDrainService } from "./log-drain.service";
import { ProxyOpsService } from "./proxy-ops.service";
import { ContainerOpsService } from "./container-ops.service";
import { ContainerLogStreamGuard } from "./container-log-stream.guard";
import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { ContainerHealthSchedulerService } from "./container-health.scheduler.service";

@Module({
  imports: [AgentGatewayModule, MetricsModule, CryptoModule, NotificationsModule, ServersModule],
  controllers: [ServerOpsController, FleetController],
  providers: [CleanupService, CleanupRunnerService, CleanupSchedulerService, PatchService, LogDrainService, ProxyOpsService, ContainerOpsService, ContainerLogStreamGuard, ContainerHealthRunnerService, ContainerHealthSchedulerService],
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
