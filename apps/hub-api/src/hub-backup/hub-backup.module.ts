import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CryptoModule } from "../crypto/crypto.module";
import { BackupsModule } from "../backups/backups.module"; // reuse BackupRunnerService.destinationSpecById
import { HubBackupController } from "./hub-backup.controller";
import { HubBackupService } from "./hub-backup.service";
import { HubBackupRunnerService } from "./hub-backup-runner.service";
import { HubBackupSchedulerService } from "./hub-backup-scheduler.service";
import { DestinationKeysExportService } from "./destination-keys-export.service";

@Module({
  imports: [AgentGatewayModule, NotificationsModule, BackupsModule, CryptoModule],
  controllers: [HubBackupController],
  providers: [HubBackupService, HubBackupRunnerService, HubBackupSchedulerService, DestinationKeysExportService],
})
export class HubBackupModule {}
