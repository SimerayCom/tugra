import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { GitSourcesModule } from "../git-sources/git-sources.module";
import { TeamDefaultsModule } from "../teams/team-defaults.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { ProxyService } from "./proxy.service";
import { AiService } from "./ai.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule, MonitorsModule, NotificationsModule, GitSourcesModule, TeamDefaultsModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, ProxyService, AiService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
