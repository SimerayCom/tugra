import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { BackupsModule } from "../backups/backups.module";
import { CryptoModule } from "../crypto/crypto.module";
import { VolumeBackupsModule } from "../volume-backups/volume-backups.module";
import { MigrationRunsModule } from "../migration-runs/migration-runs.module";
import { MigrationSafetyController } from "./migration-safety.controller";
import { SnapshotSchedulerService } from "./snapshot-scheduler.service";
import { SnapshotService } from "./snapshot.service";
import { VerificationService } from "./verification.service";

/** Verification report and pre-migration snapshot of a migration run (items 92 and 93). Sits beside the run module, never inside it. */
@Module({
  imports: [MigrationRunsModule, CryptoModule, AgentGatewayModule, BackupsModule, VolumeBackupsModule],
  controllers: [MigrationSafetyController],
  providers: [VerificationService, SnapshotService, SnapshotSchedulerService],
})
export class MigrationSafetyModule {}
