import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { MetricsModule } from "../metrics/metrics.module";
import { CryptoModule } from "../crypto/crypto.module";
import { TeamDefaultsModule } from "../teams/team-defaults.module";
import { DatabasesController } from "./databases.controller";
import { DatabasesService } from "./databases.service";
import { DatabaseLogStreamGuard } from "./log-stream.guard";

@Module({
  imports: [AgentGatewayModule, MetricsModule, CryptoModule, TeamDefaultsModule],
  controllers: [DatabasesController],
  providers: [DatabasesService, DatabaseLogStreamGuard],
  exports: [DatabasesService],
})
export class DatabasesModule {}
