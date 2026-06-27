import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { DestinationsController } from "./destinations.controller";
import { DestinationsService } from "./destinations.service";

@Module({
  imports: [CryptoModule, AgentGatewayModule],
  controllers: [DestinationsController],
  providers: [DestinationsService],
  exports: [DestinationsService],
})
export class DestinationsModule {}
