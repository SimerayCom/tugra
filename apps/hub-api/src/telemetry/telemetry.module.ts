import { Module } from "@nestjs/common";
import { TelemetryService } from "./telemetry.service";
import { TelemetrySchedulerService } from "./telemetry.scheduler.service";

// ConfigService, PrismaService and InstanceSettingsService are all global, so no imports are needed.
// TelemetryService is exported for the owner-only InstanceSettingsController (declared in AppModule).
@Module({
  providers: [TelemetryService, TelemetrySchedulerService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
