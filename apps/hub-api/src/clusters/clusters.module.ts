import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ClustersController } from "./clusters.controller";
import { ClustersService } from "./clusters.service";
import { SwarmService } from "./swarm.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules. AgentGatewayModule provides
// AgentWsServer (signed command dispatch) used by SwarmService for Docker Swarm formation.
@Module({
  imports: [AgentGatewayModule],
  controllers: [ClustersController],
  providers: [ClustersService, SwarmService],
})
export class ClustersModule {}
