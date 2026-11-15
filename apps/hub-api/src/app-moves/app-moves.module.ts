import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { CryptoModule } from "../crypto/crypto.module";
import { DnsModule } from "../dns/dns.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AppMovesController } from "./app-moves.controller";
import { AppMoveArchiveSweeper } from "./app-move-archive.sweeper";
import { AppMoveRecoveryService } from "./app-move-recovery.service";
import { AppMoveRunnerService } from "./app-move-runner.service";
import { AppMovesService } from "./app-moves.service";
import { MovePreflightService } from "./move-preflight.service";
import { PartTransferService } from "./part-transfer.service";
import { VolumeRelayController } from "./volume-relay.controller";
import { VolumeRelayService } from "./volume-relay.service";

/**
 * Move an app to another server. A leaf-ish module: it reads the applications' tables through Prisma and talks to
 * the agents through the gateway; ApplicationsService reaches it only through the `appMove` table (its guards),
 * never by injection, so there is no module cycle.
 */
@Module({
  imports: [AgentGatewayModule, ApplicationsModule, CryptoModule, DnsModule, NotificationsModule],
  controllers: [AppMovesController, VolumeRelayController],
  providers: [AppMovesService, AppMoveRunnerService, AppMoveRecoveryService, AppMoveArchiveSweeper, MovePreflightService, PartTransferService, VolumeRelayService],
  exports: [AppMovesService, AppMoveRunnerService, MovePreflightService, PartTransferService, VolumeRelayService],
})
export class AppMovesModule {}
