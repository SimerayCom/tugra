import { Injectable, Logger } from "@nestjs/common";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

// ASN.1 PKCS#8 prefix for an ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * The hub's ed25519 signing identity. Every command/term_start sent to an agent
 * is signed with this key; agents pin the public key (delivered at enroll/auth)
 * and reject anything not signed by it. Key comes from HUB_SIGNING_KEY (base64
 * 32-byte seed, deterministic). In production HUB_SIGNING_KEY is REQUIRED (env
 * validation fails closed without it), so the ephemeral fallback below is only
 * ever reached in development/test.
 */
@Injectable()
export class HubSigningService {
  private readonly logger = new Logger(HubSigningService.name);
  private readonly privateKey: KeyObject;
  readonly publicKeySpkiBase64: string;

  constructor() {
    const seedB64 = process.env.HUB_SIGNING_KEY;
    if (seedB64) {
      const seed = Buffer.from(seedB64, "base64");
      if (seed.length !== 32) {
        throw new Error("HUB_SIGNING_KEY must be a base64-encoded 32-byte ed25519 seed");
      }
      this.privateKey = createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
      });
    } else {
      this.privateKey = generateKeyPairSync("ed25519").privateKey;
      this.logger.warn(
        "HUB_SIGNING_KEY not set — generated an ephemeral signing key (set it for stability)",
      );
    }
    this.publicKeySpkiBase64 = createPublicKey(this.privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64");
  }

  /** ed25519 signature over `message`, base64-encoded. */
  sign(message: string): string {
    return sign(null, Buffer.from(message), this.privateKey).toString("base64");
  }
}
