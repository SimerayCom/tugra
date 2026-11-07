import { Global, Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { InstanceSettingsService } from "./instance-settings.service";

// Global: registration-gating, onboarding, edition and API-gating all consume the singleton settings,
// so exporting it globally (like RedisModule/AuditModule) spares every consumer a per-module import.
// CryptoModule: the service encrypts the write-only mail secrets (SMTP password / Resend key).
@Global()
@Module({
  imports: [CryptoModule],
  providers: [InstanceSettingsService],
  exports: [InstanceSettingsService],
})
export class InstanceSettingsModule {}
