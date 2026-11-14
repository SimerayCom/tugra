import { Module, type OnModuleInit } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { MetricsModule } from "../metrics/metrics.module";
import { CryptoModule } from "../crypto/crypto.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { GitSourcesModule } from "../git-sources/git-sources.module";
import { TeamDefaultsModule } from "../teams/team-defaults.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ClustersModule } from "../clusters/clusters.module";
import { DnsModule } from "../dns/dns.module";
import { DatabasesModule } from "../databases/databases.module";
import { SecretProvidersModule } from "../secret-providers/secret-providers.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { AppDatabaseLinksService } from "./app-database-links.service";
import { AppSecretRefsService } from "./app-secret-refs.service";
import { DeploymentReconcileService } from "./deployment-reconcile.service";
import { DeployLeaseService } from "./deploy-lease.service";
import { DeployRecoveryService } from "./deploy-recovery.service";
import { DeployQueueSweepSchedulerService } from "./deploy-queue-sweep.scheduler.service";
import { ProxyService } from "./proxy.service";
import { PanelTlsService } from "./panel-tls.service";
import { PanelTlsController } from "./panel-tls.controller";
import { AppPrivilegedController } from "./app-privileged.controller";
import { AiService } from "./ai.service";
import { PortAllocatorService } from "./port-allocator.service";
import { ContainerLogStreamGuard } from "./log-stream.guard";
import { APPLICATIONS_SERVICE } from "./applications.tokens";

@Module({
  imports: [AgentGatewayModule, MetricsModule, CryptoModule, MonitorsModule, NotificationsModule, GitSourcesModule, TeamDefaultsModule, CatalogModule, ClustersModule, DnsModule, DatabasesModule, SecretProvidersModule],
  controllers: [ApplicationsController, PanelTlsController, AppPrivilegedController],
  providers: [
    ApplicationsService,
    AppDatabaseLinksService,
    AppSecretRefsService,
    DeploymentReconcileService,
    DeployLeaseService,
    DeployRecoveryService,
    DeployQueueSweepSchedulerService,
    ProxyService,
    PanelTlsService,
    AiService,
    PortAllocatorService,
    ContainerLogStreamGuard,
    // String-token alias so ServersService can resolve this lazily via ModuleRef
    // without a static module import (which would form a dependency cycle).
    { provide: APPLICATIONS_SERVICE, useExisting: ApplicationsService },
  ],
  exports: [ApplicationsService, AppDatabaseLinksService, AppSecretRefsService, APPLICATIONS_SERVICE, PortAllocatorService],
})
export class ApplicationsModule implements OnModuleInit {
  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
    private readonly recovery: DeployRecoveryService,
  ) {}

  onModuleInit(): void {
    // Whenever a server's agent (re)connects: adopt its interrupted RUNNING deploys (the RISKY half of surviving a
    // hub restart — settled from the agent's command journal, never re-run) AND re-drive its QUEUED deploys (the
    // SAFE half: never-started rows run as normal deploys). Both are strictly gated on the agent being online, which
    // holds by construction since the hook fires after the socket is registered. They run INDEPENDENTLY: an
    // adoption may wait minutes for a live result and must not hold other apps' queues hostage; a still-RUNNING
    // recoverable row is never mistaken for a free slot because drain/claimNext skip an app with a RUNNING row
    // (one RUNNING per app, partial unique index). Mirrors ServerOpsModule's log-drain on-online piggyback.
    this.agentWs.setDeployReDriveProvider((serverId) => {
      void this.recovery.adoptForServer(serverId).catch(() => undefined);
      void this.apps.redriveQueuedForServer(serverId).catch(() => undefined);
    });
  }
}
