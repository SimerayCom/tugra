import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import _sodium from "libsodium-wrappers";

/**
 * Symmetric encryption for secrets-at-rest (e.g. TOTP secrets).
 * libsodium secretbox (XSalsa20-Poly1305). The 32-byte key is derived from the
 * SECRETS_ENCRYPTION_KEY passphrase via BLAKE2b, so any passphrase length works.
 * (KMS-backed envelope encryption is a P1 upgrade.)
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private sodium!: typeof _sodium;
  private key!: Uint8Array;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await _sodium.ready;
    this.sodium = _sodium;
    const passphrase = this.config.get<string>("SECRETS_ENCRYPTION_KEY");
    if (!passphrase) {
      throw new Error("SECRETS_ENCRYPTION_KEY is required");
    }
    this.key = this.sodium.crypto_generichash(
      this.sodium.crypto_secretbox_KEYBYTES,
      passphrase,
      null,
    );
  }

  encrypt(plaintext: string): string {
    const nonce = this.sodium.randombytes_buf(
      this.sodium.crypto_secretbox_NONCEBYTES,
    );
    const cipher = this.sodium.crypto_secretbox_easy(
      this.sodium.from_string(plaintext),
      nonce,
      this.key,
    );
    const combined = new Uint8Array(nonce.length + cipher.length);
    combined.set(nonce);
    combined.set(cipher, nonce.length);
    return this.sodium.to_base64(combined, this.sodium.base64_variants.ORIGINAL);
  }

  decrypt(payload: string): string {
    const combined = this.sodium.from_base64(
      payload,
      this.sodium.base64_variants.ORIGINAL,
    );
    const nonce = combined.slice(0, this.sodium.crypto_secretbox_NONCEBYTES);
    const cipher = combined.slice(this.sodium.crypto_secretbox_NONCEBYTES);
    const plain = this.sodium.crypto_secretbox_open_easy(
      cipher,
      nonce,
      this.key,
    );
    return this.sodium.to_string(plain);
  }

  /**
   * Keyed hash (MAC) for storing high-value, LOW-entropy secrets like 2FA recovery codes.
   * Unlike a bare sha256, the digest cannot be brute-forced from a DB-only leak because it
   * depends on the server key (derived from SECRETS_ENCRYPTION_KEY, never stored in the DB) —
   * matching the protection the encrypted TOTP secret already has. Deterministic → still an
   * O(1) indexed lookup.
   */
  hmac(data: string): string {
    return this.sodium.to_hex(
      this.sodium.crypto_generichash(32, this.sodium.from_string(data), this.key),
    );
  }
}
