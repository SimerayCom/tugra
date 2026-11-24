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
import { ServerScanService } from "./server-scan.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { PatchService } from "./patch.service";
import { RebootService } from "./reboot.service";
import { RebootQueueService } from "./reboot-queue.service";
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
  // RebootService is exported for the MCP tools (the same service the REST routes call); CleanupService for the settings import.
  exports: [RebootService, CleanupService],
  providers: [CleanupService, GpuInventoryService, ServerScanService, CleanupRunnerService, CleanupSchedulerService, PatchService, RebootService, RebootQueueService, LogDrainService, ProxyOpsService, ContainerOpsService, ContainerLogStreamGuard, ContainerHealthRunnerService, ContainerHealthSchedulerService, ComposeRestartHealService, ComposeRestartHealSchedulerService],
})
export class ServerOpsModule {}
