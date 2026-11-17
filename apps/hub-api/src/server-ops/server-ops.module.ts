import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { MetricsModule } from "../metrics/metrics.module";
import { CryptoModule } from "../crypto/crypto.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ServersModule } from "../servers/servers.module";
import { ClustersModule } from "../clusters/clusters.module";
import { LogDrainsModule } from "../log-drains/log-drains.module";
import { ServerOpsController } from "./server-ops.controller";
import { FleetController } from "./fleet.controller";
import { CleanupService } from "./cleanup.service";
import { GpuInventoryService } from "./gpu-inventory.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { PatchService } from "./patch.service";
import { LogDrainService } from "./log-drain.service";
import { ProxyOpsService } from "./proxy-ops.service";
import { ContainerOpsService } from "./container-ops.service";
import { ContainerLogStreamGuard } from "./container-log-stream.guard";
import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { ContainerHealthSchedulerService } from "./container-health.scheduler.service";
import { ComposeRestartHealService } from "./compose-restart-heal.service";
import { ComposeRestartHealSchedulerService } from "./compose-restart-heal.scheduler.service";

@Module({
  imports: [AgentGatewayModule, MetricsModule, CryptoModule, NotificationsModule, ServersModule, ClustersModule, LogDrainsModule],
  controllers: [ServerOpsController, FleetController],
  providers: [CleanupService, GpuInventoryService, CleanupRunnerService, CleanupSchedulerService, PatchService, LogDrainService, ProxyOpsService, ContainerOpsService, ContainerLogStreamGuard, ContainerHealthRunnerService, ContainerHealthSchedulerService, ComposeRestartHealService, ComposeRestartHealSchedulerService],
})
export class ServerOpsModule {}
