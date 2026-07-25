import { Global, Module } from "@nestjs/common";
import { LicenseService } from "./license.service";

// Global so the instance-settings controller (and any future edition-gated consumer) can inject the
// LicenseService without a per-module import; it verifies the signed license at boot (onModuleInit) and
// feeds the effective edition into common/edition.ts.
@Global()
@Module({
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicenseModule {}
