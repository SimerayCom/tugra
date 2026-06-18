import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module";
import { ServersModule } from "../servers/servers.module";
import { AgentWsServer } from "./agent-ws.server";
import { DeployLogHub } from "./deploy-log.hub";

@Module({
  imports: [ServersModule, MetricsModule],
  providers: [AgentWsServer, DeployLogHub],
  exports: [AgentWsServer, DeployLogHub],
})
export class AgentGatewayModule {}
