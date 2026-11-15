import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "./crypto.service";
import { KeyRingService } from "./keyring.service";
import { KEYRING_STORE, PrismaKeyringStore, type KeyringStore } from "./keyring.store";
import { SecretsRotationService } from "./secrets-rotation.service";

// PrismaModule and AuditModule are @Global, so the keyring/rotation services resolve them without imports here.
// CryptoService is built by an ASYNC factory that loads the keyring before returning: Nest awaits async providers
// during instantiation, i.e. before ANY module's onModuleInit runs, so every consumer can decrypt a data-key
// ciphertext regardless of module order. Nest's own later onModuleInit call on the instance is a no-op (idempotent).
@Module({
  providers: [
    { provide: KEYRING_STORE, useFactory: (prisma: PrismaService) => new PrismaKeyringStore(prisma), inject: [PrismaService] },
    {
      provide: CryptoService,
      useFactory: async (config: ConfigService, store: KeyringStore) => {
        const crypto = new CryptoService(config, store);
        await crypto.onModuleInit();
        return crypto;
      },
      inject: [ConfigService, KEYRING_STORE],
    },
    SecretsRotationService,
    KeyRingService,
  ],
  exports: [CryptoService, SecretsRotationService, KeyRingService],
})
export class CryptoModule {}
