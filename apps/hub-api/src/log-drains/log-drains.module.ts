import { Module, type OnModuleInit } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoModule } from "../crypto/crypto.module";
import { AppLogDrainService } from "./app-log-drain.service";
import { AppLogDrainsController } from "./app-log-drains.controller";
import { LogDrainPushService } from "./log-drain-push.service";

/**
 * Log drains (D7). A LEAF module: it depends only on the agent gateway and crypto (PrismaService,
 * TeamAccessService and AuditService come from global modules), so ServerOpsModule, ApplicationsModule and
 * ClustersModule can all import it without a DI cycle. It owns the agent-connect hook that (re)pushes a server's
 * drain set and the sink for the agent's drain_status messages.
 */
@Module({
  imports: [AgentGatewayModule, CryptoModule],
  controllers: [AppLogDrainsController],
  providers: [LogDrainPushService, AppLogDrainService],
  exports: [LogDrainPushService, AppLogDrainService],
})
export class LogDrainsModule implements OnModuleInit {
  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly push: LogDrainPushService,
  ) {}

  onModuleInit(): void {
    // Re-push a server's drain set whenever its agent (re)connects or its capabilities change.
    this.agentWs.setLogDrainProvider((serverId) => {
      void this.push.pushToAgent(serverId).catch(() => undefined);
    });
    this.agentWs.setDrainStatusSink((serverId, drains) => this.push.ingestStatus(serverId, drains));
  }
}
