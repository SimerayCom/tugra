import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { MigrationRunsModule } from "../migration-runs/migration-runs.module";
import { MigrationSafetyController } from "./migration-safety.controller";
import { VerificationService } from "./verification.service";

/** Verification report and pre-migration snapshot of a migration run (items 92 and 93). Sits beside the run module, never inside it. */
@Module({
  imports: [MigrationRunsModule, CryptoModule],
  controllers: [MigrationSafetyController],
  providers: [VerificationService],
})
export class MigrationSafetyModule {}
