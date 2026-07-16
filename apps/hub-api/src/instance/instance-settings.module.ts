import { Global, Module } from "@nestjs/common";
import { InstanceSettingsService } from "./instance-settings.service";

// Global: registration-gating, onboarding, edition and API-gating all consume the singleton settings,
// so exporting it globally (like RedisModule/AuditModule) spares every consumer a per-module import.
@Global()
@Module({
  providers: [InstanceSettingsService],
  exports: [InstanceSettingsService],
})
export class InstanceSettingsModule {}
