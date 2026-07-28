import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { MetricsModule } from "../metrics/metrics.module";
import { CryptoModule } from "../crypto/crypto.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { GitSourcesModule } from "../git-sources/git-sources.module";
import { TeamDefaultsModule } from "../teams/team-defaults.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { SwarmDeployService } from "../clusters/swarm-deploy.service";
import { ProxyService } from "./proxy.service";
import { AiService } from "./ai.service";
import { PortAllocatorService } from "./port-allocator.service";
import { APPLICATIONS_SERVICE } from "./applications.tokens";

@Module({
  imports: [AgentGatewayModule, MetricsModule, CryptoModule, MonitorsModule, NotificationsModule, GitSourcesModule, TeamDefaultsModule, CatalogModule],
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    SwarmDeployService,
    ProxyService,
    AiService,
    PortAllocatorService,
    // String-token alias so ServersService can resolve this lazily via ModuleRef
    // without a static module import (which would form a dependency cycle).
    { provide: APPLICATIONS_SERVICE, useExisting: ApplicationsService },
  ],
  exports: [ApplicationsService, APPLICATIONS_SERVICE, PortAllocatorService],
})
export class ApplicationsModule {}
