import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { DatabasesModule } from "../databases/databases.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BackupsController } from "./backups.controller";
import { FleetBackupsController } from "./fleet-backups.controller";
import { BackupsService } from "./backups.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BaseBackupRunnerService } from "./base-backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { WalShipperRunnerService } from "./wal-shipper-runner.service";
import { WalShipperSchedulerService } from "./wal-shipper.scheduler.service";
import { PitrService } from "./pitr.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule, DatabasesModule, NotificationsModule],
  controllers: [BackupsController, FleetBackupsController],
  providers: [
    BackupsService,
    BackupRunnerService,
    BaseBackupRunnerService,
    BackupSchedulerService,
    BackupAlertsService,
    WalShipperRunnerService,
    WalShipperSchedulerService,
    PitrService,
  ],
  exports: [BackupsService, BackupRunnerService, BaseBackupRunnerService, BackupAlertsService, WalShipperRunnerService, PitrService],
})
export class BackupsModule {}
