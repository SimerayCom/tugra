import { Module } from "@nestjs/common";
import { CryptoService } from "./crypto.service";
import { SecretsRotationService } from "./secrets-rotation.service";

// PrismaModule and AuditModule are @Global, so the rotation service resolves them without imports here.
@Module({
  providers: [CryptoService, SecretsRotationService],
  exports: [CryptoService, SecretsRotationService],
})
export class CryptoModule {}
