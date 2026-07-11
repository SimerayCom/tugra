import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { MetricsModule } from "../metrics/metrics.module";
import { ServersModule } from "../servers/servers.module";
import { AgentWsServer } from "./agent-ws.server";
import { DeployLogHub } from "./deploy-log.hub";
import { LogStreamService } from "./log-stream.service";
import { TerminalGateway } from "./terminal.gateway";
import { TerminalController } from "./terminal.controller";
import { HubSigningService } from "./hub-signing.service";

@Module({
  imports: [ServersModule, MetricsModule, JwtModule.register({})],
  controllers: [TerminalController],
  providers: [AgentWsServer, DeployLogHub, LogStreamService, TerminalGateway, HubSigningService],
  exports: [AgentWsServer, DeployLogHub, LogStreamService],
})
export class AgentGatewayModule {}
