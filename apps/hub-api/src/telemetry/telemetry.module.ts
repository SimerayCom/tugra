import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { TelemetryService } from "./telemetry.service";
import { TelemetrySchedulerService } from "./telemetry.scheduler.service";

// ConfigService, PrismaService and InstanceSettingsService are global; CryptoModule seals the hub identity key, so no imports are needed.
// TelemetryService is exported for the owner-only InstanceSettingsController (declared in AppModule).
@Module({
  imports: [CryptoModule],
  providers: [TelemetryService, TelemetrySchedulerService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
