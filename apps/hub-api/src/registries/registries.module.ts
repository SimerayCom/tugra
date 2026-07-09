import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { RegistriesController } from "./registries.controller";
import { RegistriesService } from "./registries.service";

@Module({
  imports: [CryptoModule, AgentGatewayModule],
  controllers: [RegistriesController],
  providers: [RegistriesService],
  exports: [RegistriesService],
})
export class RegistriesModule {}
