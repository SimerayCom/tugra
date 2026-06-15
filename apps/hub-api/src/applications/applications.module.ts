import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { ProxyService } from "./proxy.service";

@Module({
  imports: [AgentGatewayModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, ProxyService],
})
export class ApplicationsModule {}
