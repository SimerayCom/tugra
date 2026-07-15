import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { VolumeBackupsController } from "./volume-backups.controller";
import { VolumeBackupsService } from "./volume-backups.service";
import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule, NotificationsModule],
  controllers: [VolumeBackupsController],
  providers: [VolumeBackupsService, VolumeBackupRunnerService, VolumeBackupSchedulerService],
  exports: [VolumeBackupsService],
})
export class VolumeBackupsModule {}
