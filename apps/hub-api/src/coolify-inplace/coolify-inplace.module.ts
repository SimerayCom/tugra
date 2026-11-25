import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { ClustersModule } from "../clusters/clusters.module";
import { ProxyOpsService } from "../server-ops/proxy-ops.service";
import { CoolifyInPlaceController } from "./coolify-inplace.controller";
import { CoolifyInPlaceService } from "./coolify-inplace.service";
import { INPLACE_WORLD } from "./inplace-world";
import { InPlaceWorldService } from "./inplace-world.service";

// PrismaService, TeamAccessService, AuditService and ProxyConfigService come from @Global modules. ProxyOpsService is a second, stateless
// instance (ServerOpsModule does not export its own), the same way the cutover steps use it.
@Module({
  imports: [AgentGatewayModule, ApplicationsModule, ClustersModule],
  controllers: [CoolifyInPlaceController],
  providers: [ProxyOpsService, InPlaceWorldService, { provide: INPLACE_WORLD, useExisting: InPlaceWorldService }, CoolifyInPlaceService],
  exports: [CoolifyInPlaceService],
})
export class CoolifyInPlaceModule {}
