/**
 * Host-side exporter used by `scripts/hub-migrate.sh pack`: prints the destination-key manifest as JSON on
 * stdout. Run inside the hub-api container (`node dist/scripts/export-destination-keys.js`). It does NOT boot
 * Nest — only Prisma + the secrets CryptoService — so it works while the API is healthy and needs no HTTP auth.
 * Exit code 2 when any encrypted destination's key could not be decrypted (manifest still printed, incomplete).
 */
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { CryptoService } from "../crypto/crypto.service";
import type { PrismaService } from "../prisma/prisma.service";
import { buildKeyManifest, type KeyManifest } from "../destinations/key-manifest";

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
    const crypto = new CryptoService(config);
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
