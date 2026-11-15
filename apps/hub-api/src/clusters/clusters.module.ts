import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { LogDrainsModule } from "../log-drains/log-drains.module";
import { ClustersController } from "./clusters.controller";
import { ClustersService } from "./clusters.service";
import { SwarmService } from "./swarm.service";
import { SwarmDeployService } from "./swarm-deploy.service";
import { SwarmProxyService } from "./swarm-proxy.service";
import { SwarmSchedulerService } from "./swarm.scheduler.service";

// PrismaService, TeamAccessService, AuditService and ConfigService come from @Global modules.
// AgentGatewayModule provides AgentWsServer (signed command dispatch). SwarmDeployService/SwarmProxyService
// are exported so ApplicationsModule (which imports this module) can drive swarm service deploys + ingress.
@Module({
  imports: [AgentGatewayModule, CryptoModule, NotificationsModule, LogDrainsModule],
  controllers: [ClustersController],
  providers: [ClustersService, SwarmService, SwarmDeployService, SwarmProxyService, SwarmSchedulerService],
  exports: [SwarmDeployService, SwarmProxyService, ClustersService, SwarmService],
})
export class ClustersModule {}
