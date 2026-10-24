import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
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
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { AppDatabaseLinksService } from "./app-database-links.service";
import { ProxyService } from "./proxy.service";
import { AiService } from "./ai.service";
import { PortAllocatorService } from "./port-allocator.service";
import { ContainerLogStreamGuard } from "./log-stream.guard";
import { APPLICATIONS_SERVICE } from "./applications.tokens";

@Module({
  imports: [AgentGatewayModule, MetricsModule, CryptoModule, MonitorsModule, NotificationsModule, GitSourcesModule, TeamDefaultsModule, CatalogModule, ClustersModule, DnsModule, DatabasesModule],
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    AppDatabaseLinksService,
    ProxyService,
    AiService,
    PortAllocatorService,
    ContainerLogStreamGuard,
    // String-token alias so ServersService can resolve this lazily via ModuleRef
    // without a static module import (which would form a dependency cycle).
    { provide: APPLICATIONS_SERVICE, useExisting: ApplicationsService },
  ],
  exports: [ApplicationsService, AppDatabaseLinksService, APPLICATIONS_SERVICE, PortAllocatorService],
})
export class ApplicationsModule {}
