import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { buildKeyManifest, sealOpensslCompatible, SEALED_FORMAT } from "../destinations/key-manifest";

export interface SealedKeyExport {
  filename: string;
  format: string;
  contentBase64: string;
  destinationCount: number;
  undecryptable: string[];
}

/** Owner-only export of every encrypted destination's data key, sealed under a passphrase the owner picks. */
@Injectable()
export class DestinationKeysExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  async exportSealed(userId: string, passphrase: string): Promise<SealedKeyExport> {
    const secretsKey = this.config.get<string>("SECRETS_ENCRYPTION_KEY") ?? "";
    const { manifest, undecryptable } = await buildKeyManifest(this.prisma, this.crypto, secretsKey);
    const sealed = sealOpensslCompatible(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), passphrase);
    // Audit the COUNT only — never the passphrase, never any key material.
    await this.audit.log({ actor: userId, action: "instance.backup.keys_export", target: "hub", meta: { count: manifest.destinations.length } });
    const d = new Date();
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    return {
      filename: `tugra-destination-keys-${ymd}.enc`,
      format: SEALED_FORMAT,
      contentBase64: sealed.toString("base64"),
      destinationCount: manifest.destinations.length,
      undecryptable,
    };
  }
}
