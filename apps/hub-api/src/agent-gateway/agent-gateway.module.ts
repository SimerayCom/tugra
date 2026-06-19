import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { MetricsModule } from "../metrics/metrics.module";
import { ServersModule } from "../servers/servers.module";
import { AgentWsServer } from "./agent-ws.server";
import { DeployLogHub } from "./deploy-log.hub";
import { TerminalGateway } from "./terminal.gateway";
import { HubSigningService } from "./hub-signing.service";

@Module({
  imports: [ServersModule, MetricsModule, JwtModule.register({})],
  providers: [AgentWsServer, DeployLogHub, TerminalGateway, HubSigningService],
  exports: [AgentWsServer, DeployLogHub],
})
export class AgentGatewayModule {}
