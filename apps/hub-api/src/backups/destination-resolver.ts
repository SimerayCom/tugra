import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import { LOCAL_DEST, type DestinationSpec } from "./destination";
import { DestinationKeyError } from "./destination-key-error";

/**
 * The ONE place a backup destination row becomes a {@link DestinationSpec} (shared by the database, volume and
 * hub runners). Behaviour:
 *  - no id, or the row is gone → the implicit LOCAL server disk (unencrypted — there is no row to hold a key).
 *  - LOCAL row → LOCAL with ITS encryption carried through (a LOCAL destination can be encrypted too).
 *  - S3 row → the decrypted S3 config + encryption.
 *  - FAIL CLOSED: encryption enabled but the key is missing/undecryptable-empty → throw, never an empty
 *    `--passphrase ''` (which would write data "encrypted" with a guessable key). The failures are typed
 *    (DestinationKeyError, a 422) so the reason reaches the caller instead of a generic 500.
 */
export async function resolveDestinationSpec(
  prisma: PrismaService,
  crypto: CryptoService,
  id: string | null,
): Promise<DestinationSpec> {
  if (!id) return LOCAL_DEST;
  const d = await prisma.backupDestination.findUnique({ where: { id } });
  if (!d) return LOCAL_DEST;
  // A stored value the loaded secrets keys cannot open (rotated away, retired data key, corrupt) is the same
  // fail-closed situation as a missing key. The underlying error text is dropped on purpose (it may name a key id).
  const open = (v: string): string => {
    try {
      return crypto.decrypt(v);
    } catch {
      throw new DestinationKeyError("destination_key_unavailable", "the destination's stored credentials cannot be decrypted with the loaded secrets key");
    }
  };
  const encryption = {
    enabled: d.encryptionEnabled,
    key: d.encryptionKey ? open(d.encryptionKey) : "",
  };
  if (encryption.enabled && encryption.key === "") {
    throw new DestinationKeyError("destination_key_missing", "destination encryption is enabled but its key is missing");
  }
  if (d.type !== "S3") return { ...LOCAL_DEST, encryption };
  return {
    type: "S3",
    s3: {
      bucket: d.s3Bucket ?? "",
      region: d.s3Region ?? "",
      endpoint: d.s3Endpoint ?? "",
      accessKey: d.s3AccessKey ? open(d.s3AccessKey) : "",
      secretKey: d.s3SecretKey ? open(d.s3SecretKey) : "",
      prefix: d.s3Prefix ?? "",
    },
    encryption,
  };
}
