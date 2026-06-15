import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module";
import { ServersModule } from "../servers/servers.module";
import { AgentWsServer } from "./agent-ws.server";

@Module({
  imports: [ServersModule, MetricsModule],
  providers: [AgentWsServer],
  exports: [AgentWsServer],
})
export class AgentGatewayModule {}
