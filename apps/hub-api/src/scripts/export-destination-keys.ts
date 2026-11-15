/**
 * Host-side exporter used by `scripts/hub-migrate.sh pack`: prints the destination-key manifest as JSON on
 * stdout. Run inside the hub-api container (`node dist/scripts/export-destination-keys.js`). It does NOT boot
 * Nest — only Prisma + the secrets CryptoService — so it works while the API is healthy and needs no HTTP auth.
 * Exit code 2 when any encrypted destination's key could not be decrypted (manifest still printed, incomplete).
 */
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaKeyringStore } from "../crypto/keyring.store";
import type { PrismaService } from "../prisma/prisma.service";
import { buildKeyManifest, type KeyManifest } from "../destinations/key-manifest";

/** Same wiring as crypto.module.ts: the ring must include the Postgres keyring (data keys wrapped under the .env
 *  root keys), otherwise every key written after a rotation (`tk1.<dataKeyId>.…`) is unreadable here. A store
 *  failure throws, which is right: the exporter fails closed rather than emit an empty manifest. */
export function buildExporterCrypto(config: ConfigService, prisma: PrismaService): CryptoService {
  return new CryptoService(config, new PrismaKeyringStore(prisma));
}

export async function runExport(
  prisma: PrismaService,
  crypto: CryptoService,
  secretsKey: string,
): Promise<{ manifest: KeyManifest; exitCode: number }> {
  const { manifest, undecryptable } = await buildKeyManifest(prisma, crypto, secretsKey);
  return { manifest, exitCode: undecryptable.length ? 2 : 0 };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const config = new ConfigService();
    const crypto = buildExporterCrypto(config, prisma as unknown as PrismaService);
    await crypto.onModuleInit();
    const secretsKey = config.get<string>("SECRETS_ENCRYPTION_KEY") ?? "";
    const { manifest, exitCode } = await runExport(prisma as unknown as PrismaService, crypto, secretsKey);
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
    if (exitCode) process.stderr.write("some destination keys could not be decrypted; manifest is incomplete\n");
    process.exitCode = exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`export-destination-keys failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
