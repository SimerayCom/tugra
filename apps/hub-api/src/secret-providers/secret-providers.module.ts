import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { SecretProvidersService } from "./secret-providers.service";
import { SecretProvidersController } from "./secret-providers.controller";
import { VaultApiClient } from "./vault-api.client";

/**
 * External secret-store providers (team-scoped credential) + the Vault client that fetches referenced
 * secrets at deploy time. VaultApiClient is a stateless client provided here directly; PrismaService,
 * TeamAccessService and AuditService come from @Global modules; CryptoModule supplies token encryption.
 * VaultApiClient is exported so ApplicationsModule's AppSecretRefsService can resolve refs at deploy.
 */
@Module({
  imports: [CryptoModule],
  controllers: [SecretProvidersController],
  providers: [SecretProvidersService, VaultApiClient],
  exports: [SecretProvidersService, VaultApiClient],
})
export class SecretProvidersModule {}
