import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import { LOCAL_DEST, type DestinationSpec } from "./destination";

/**
 * The ONE place a backup destination row becomes a {@link DestinationSpec} (shared by the database, volume and
 * hub runners). Behaviour:
 *  - no id, or the row is gone → the implicit LOCAL server disk (unencrypted — there is no row to hold a key).
 *  - LOCAL row → LOCAL with ITS encryption carried through (a LOCAL destination can be encrypted too).
 *  - S3 row → the decrypted S3 config + encryption.
 *  - FAIL CLOSED: encryption enabled but the key is missing/undecryptable-empty → throw, never an empty
 *    `--passphrase ''` (which would write data "encrypted" with a guessable key).
 */
export async function resolveDestinationSpec(
  prisma: PrismaService,
  crypto: CryptoService,
  id: string | null,
): Promise<DestinationSpec> {
  if (!id) return LOCAL_DEST;
  const d = await prisma.backupDestination.findUnique({ where: { id } });
  if (!d) return LOCAL_DEST;
  const encryption = {
    enabled: d.encryptionEnabled,
    key: d.encryptionKey ? crypto.decrypt(d.encryptionKey) : "",
  };
  if (encryption.enabled && encryption.key === "") {
    throw new Error("destination encryption is enabled but its key is missing");
  }
  if (d.type !== "S3") return { ...LOCAL_DEST, encryption };
  return {
    type: "S3",
    s3: {
      bucket: d.s3Bucket ?? "",
      region: d.s3Region ?? "",
      endpoint: d.s3Endpoint ?? "",
      accessKey: d.s3AccessKey ? crypto.decrypt(d.s3AccessKey) : "",
      secretKey: d.s3SecretKey ? crypto.decrypt(d.s3SecretKey) : "",
      prefix: d.s3Prefix ?? "",
    },
    encryption,
  };
}
