import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { BulkController } from "./bulk.controller";
import { BulkService } from "./bulk.service";

@Module({
  imports: [AgentGatewayModule],
  controllers: [BulkController],
  providers: [BulkService],
})
export class BulkModule {}
