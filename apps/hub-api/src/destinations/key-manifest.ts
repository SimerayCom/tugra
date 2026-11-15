import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import { hubBackupPassphrase } from "../hub-backup/hub-backup-script";

/**
 * The destination-key manifest: every ENCRYPTED destination's data key (plaintext) so backups stay decryptable
 * after losing the hub, plus the .env-derived hub-backup passphrase. Treat like the .env. It deliberately holds
 * NO S3 credentials. Used by the owner-only sealed export and by the host-side DR-bundle exporter.
 */
export interface KeyManifest {
  v: 1;
  exportedAt: string;
  note: string;
  destinations: {
    id: string;
    name: string;
    teamId: string;
    type: string;
    s3: { bucket: string | null; endpoint: string | null; region: string | null; prefix: string | null } | null;
    encryption: { cipher: "gpg-symmetric-AES256"; passphrase: string; sha256: string };
  }[];
  hubBackup: { cipher: "gpg-symmetric-AES256"; passphrase: string };
}

export async function buildKeyManifest(
  prisma: PrismaService,
  crypto: CryptoService,
  secretsKey: string,
): Promise<{ manifest: KeyManifest; undecryptable: string[] }> {
  const rows = await prisma.backupDestination.findMany({
    where: { encryptionEnabled: true, encryptionKey: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const destinations: KeyManifest["destinations"] = [];
  const undecryptable: string[] = [];
  for (const d of rows) {
    let passphrase: string;
    try {
      passphrase = crypto.decrypt(d.encryptionKey!);
    } catch {
      // Never silently dropped: the caller reports the ids so the owner knows the manifest is incomplete.
      undecryptable.push(d.id);
      continue;
    }
    destinations.push({
      id: d.id,
      name: d.name,
      teamId: d.teamId,
      type: d.type,
      s3:
        d.type === "S3"
          ? { bucket: d.s3Bucket, endpoint: d.s3Endpoint, region: d.s3Region, prefix: d.s3Prefix }
          : null,
      encryption: {
        cipher: "gpg-symmetric-AES256",
        passphrase,
        sha256: createHash("sha256").update(passphrase).digest("hex").slice(0, 16),
      },
    });
  }
  return {
    manifest: {
      v: 1,
      exportedAt: new Date().toISOString(),
      note: "treat like .env; contains backup decryption secrets",
      destinations,
      hubBackup: { cipher: "gpg-symmetric-AES256", passphrase: hubBackupPassphrase(secretsKey) },
    },
    undecryptable,
  };
}

export const SEALED_FORMAT = "openssl-aes-256-cbc-pbkdf2-sha256-600000";
const PBKDF2_ITER = 600_000;

/**
 * Seal `plaintext` in the `openssl enc` file layout using node:crypto only: `"Salted__" || salt(8) ||
 * aes-256-cbc(plaintext)` with key(32)||iv(16) = PBKDF2-HMAC-SHA256(passphrase, salt, 600000). Open with:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <file>
 */
export function sealOpensslCompatible(plaintext: Buffer, passphrase: string, salt: Buffer = randomBytes(8)): Buffer {
  const dk = pbkdf2Sync(passphrase, salt, PBKDF2_ITER, 48, "sha256");
  const cipher = createCipheriv("aes-256-cbc", dk.subarray(0, 32), dk.subarray(32, 48));
  return Buffer.concat([Buffer.from("Salted__"), salt, cipher.update(plaintext), cipher.final()]);
}
