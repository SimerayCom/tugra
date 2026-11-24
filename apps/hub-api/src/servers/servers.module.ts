import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ServersController } from "./servers.controller";
import { ServersService } from "./servers.service";
import { ServerTeamTransferService } from "./server-team-transfer.service";

@Module({
  imports: [MetricsModule, NotificationsModule, CryptoModule],
  controllers: [ServersController],
  providers: [ServersService, ServerTeamTransferService],
  exports: [ServersService],
})
export class ServersModule {}
