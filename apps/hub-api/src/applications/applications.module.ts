import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { GitSourcesModule } from "../git-sources/git-sources.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { ProxyService } from "./proxy.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule, MonitorsModule, NotificationsModule, GitSourcesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, ProxyService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
