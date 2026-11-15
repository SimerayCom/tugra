import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { AppMovesController } from "./app-moves.controller";
import { AppMovesService } from "./app-moves.service";
import { PartTransferService } from "./part-transfer.service";
import { VolumeRelayController } from "./volume-relay.controller";
import { VolumeRelayService } from "./volume-relay.service";

/**
 * Move an app to another server. A leaf-ish module: it reads the applications' tables through Prisma and talks to
 * the agents through the gateway; ApplicationsService reaches it only through the `appMove` table (its guards),
 * never by injection, so there is no module cycle.
 */
@Module({
  imports: [AgentGatewayModule, CryptoModule],
  controllers: [AppMovesController, VolumeRelayController],
  providers: [AppMovesService, PartTransferService, VolumeRelayService],
  exports: [AppMovesService, PartTransferService, VolumeRelayService],
})
export class AppMovesModule {}
