import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";

@Module({
  imports: [AgentGatewayModule, CryptoModule],
  controllers: [BackupsController],
  providers: [BackupsService, BackupRunnerService, BackupSchedulerService],
  exports: [BackupsService],
})
export class BackupsModule {}
