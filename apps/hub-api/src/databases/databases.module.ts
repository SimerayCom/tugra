import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { TeamDefaultsModule } from "../teams/team-defaults.module";
import { DatabasesController } from "./databases.controller";
import { DatabasesService } from "./databases.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule, TeamDefaultsModule],
  controllers: [DatabasesController],
  providers: [DatabasesService],
  exports: [DatabasesService],
})
export class DatabasesModule {}
