import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import _sodium from "libsodium-wrappers";

/**
 * Versioned ciphertext prefix. Legacy ciphertexts are bare base64 (ORIGINAL alphabet: A-Z a-z 0-9 + / =), which
 * never contains "." — so `tk1.<keyId>.<base64>` can be told apart from legacy unambiguously, and a future
 * format bump is `tk2.`.
 */
export const CIPHERTEXT_V1_PREFIX = "tk1.";
const VERSIONED_RE = /^tk1\.([0-9a-f]{16})\.([A-Za-z0-9+/=]+)$/;

/** Thrown when no configured key can open a ciphertext (the key it was written under is not in
 *  SECRETS_ENCRYPTION_KEY / SECRETS_ENCRYPTION_KEY_PREVIOUS). Distinct so callers can tell "rotated away" from
 *  "corrupt". */
export class SecretsKeyUnavailableError extends Error {
  constructor(public readonly keyId: string | null) {
    super(
      keyId
        ? `secret was encrypted with key ${keyId}, which is not configured (set it in SECRETS_ENCRYPTION_KEY_PREVIOUS to read it)`
        : "secret could not be decrypted with any configured key",
    );
    this.name = "SecretsKeyUnavailableError";
  }
}

export interface DecryptedSecret {
  plaintext: string;
  /** Id of the key that opened it. */
  keyId: string;
  /** True when the ciphertext is already in the versioned format under the CURRENT key (nothing to rewrite). */
  current: boolean;
}

interface LoadedKey {
  id: string;
  key: Uint8Array;
}

/**
 * Symmetric encryption for secrets-at-rest. libsodium secretbox (XSalsa20-Poly1305); each 32-byte key is derived
 * from a passphrase via BLAKE2b, so any passphrase length works.
 *
 * KEY ROTATION: `SECRETS_ENCRYPTION_KEY` is the CURRENT key (every new ciphertext / MAC uses it);
 * `SECRETS_ENCRYPTION_KEY_PREVIOUS` (comma-separated, optional) lists keys that may still open OLD ciphertexts.
 * Every ciphertext written since rotation support carries its key id (`tk1.<keyId>.<base64>`), so decryption
 * picks the exact key; a legacy bare-base64 ciphertext is tried against the current key and then each previous
 * key in order. A key id is the first 16 hex chars of BLAKE2b(derived key) — stable across restarts, never
 * reveals the passphrase. `SecretsRotationService` rewrites rows still under an old key; once none remain the
 * previous key can be dropped from the env.
 *
 * (KMS-backed envelope encryption is a P1 upgrade.)
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private sodium!: typeof _sodium;
  private keys: LoadedKey[] = []; // [current, ...previous] in configured order

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await _sodium.ready;
    this.sodium = _sodium;
    const passphrase = this.config.get<string>("SECRETS_ENCRYPTION_KEY");
    if (!passphrase) {
      throw new Error("SECRETS_ENCRYPTION_KEY is required");
    }
    const previous = (this.config.get<string>("SECRETS_ENCRYPTION_KEY_PREVIOUS") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const loaded: LoadedKey[] = [];
    for (const p of [passphrase, ...previous]) {
      const k = this.derive(p);
      if (loaded.some((l) => l.id === k.id)) continue; // the same passphrase listed twice is one key
      loaded.push(k);
    }
    this.keys = loaded;
    if (this.keys.length > 1) {
      this.logger.warn(`secrets key rotation in progress: current ${this.currentKeyId}, previous ${this.previousKeyIds.join(", ")} — re-encrypt stored secrets, then remove SECRETS_ENCRYPTION_KEY_PREVIOUS`);
    }
  }

  private derive(passphrase: string): LoadedKey {
    const key = this.sodium.crypto_generichash(this.sodium.crypto_secretbox_KEYBYTES, passphrase, null);
    // Fingerprint of the DERIVED key (not the passphrase): stable, public-safe, 64 bits is plenty for an id.
    const id = this.sodium.to_hex(this.sodium.crypto_generichash(8, key, null));
    return { id, key };
  }

  private get current(): LoadedKey {
    return this.keys[0];
  }

  /** Id of the key every new ciphertext is written under. */
  get currentKeyId(): string {
    return this.current.id;
  }

  /** Ids of the previous keys still configured (in order). Empty when no rotation is in progress. */
  get previousKeyIds(): string[] {
    return this.keys.slice(1).map((k) => k.id);
  }

  encrypt(plaintext: string): string {
    const nonce = this.sodium.randombytes_buf(this.sodium.crypto_secretbox_NONCEBYTES);
    const cipher = this.sodium.crypto_secretbox_easy(this.sodium.from_string(plaintext), nonce, this.current.key);
    const combined = new Uint8Array(nonce.length + cipher.length);
    combined.set(nonce);
    combined.set(cipher, nonce.length);
    return `${CIPHERTEXT_V1_PREFIX}${this.current.id}.${this.sodium.to_base64(combined, this.sodium.base64_variants.ORIGINAL)}`;
  }

  decrypt(payload: string): string {
    return this.decryptMeta(payload).plaintext;
  }

  /** Decrypt and report WHICH key opened the ciphertext and whether it is already current. */
  decryptMeta(payload: string): DecryptedSecret {
    const m = VERSIONED_RE.exec(payload);
    if (m) {
      const key = this.keys.find((k) => k.id === m[1]);
      if (!key) throw new SecretsKeyUnavailableError(m[1]);
      return { plaintext: this.open(m[2], key.key), keyId: key.id, current: key.id === this.current.id };
    }
    // Legacy (unprefixed) ciphertext: no key id to go by — try the current key, then each previous one. A
    // legacy ciphertext is never "current": the rotation job rewrites it so the key id is recorded.
    let lastErr: unknown;
    for (const k of this.keys) {
      try {
        return { plaintext: this.open(payload, k.key), keyId: k.id, current: false };
      } catch (e) {
        lastErr = e;
      }
    }
    if (this.keys.length > 1 || payload.startsWith(CIPHERTEXT_V1_PREFIX)) throw new SecretsKeyUnavailableError(null);
    throw lastErr instanceof Error ? lastErr : new Error("decrypt failed");
  }

  /** Whether a stored ciphertext is in the versioned format under the current key (no rewrite needed). Pure
   *  string check — never decrypts. */
  isCurrent(payload: string): boolean {
    const m = VERSIONED_RE.exec(payload);
    return !!m && m[1] === this.current.id;
  }

  /** The key id a stored ciphertext claims, or null for a legacy (unprefixed) one. */
  keyIdOf(payload: string): string | null {
    const m = VERSIONED_RE.exec(payload);
    return m ? m[1] : null;
  }

  private open(b64: string, key: Uint8Array): string {
    const combined = this.sodium.from_base64(b64, this.sodium.base64_variants.ORIGINAL);
    const nonce = combined.slice(0, this.sodium.crypto_secretbox_NONCEBYTES);
    const cipher = combined.slice(this.sodium.crypto_secretbox_NONCEBYTES);
    return this.sodium.to_string(this.sodium.crypto_secretbox_open_easy(cipher, nonce, key));
  }

  /**
   * Keyed hash (MAC) for storing high-value, LOW-entropy secrets like 2FA recovery codes.
   * Unlike a bare sha256, the digest cannot be brute-forced from a DB-only leak because it
   * depends on the server key (derived from SECRETS_ENCRYPTION_KEY, never stored in the DB) —
   * matching the protection the encrypted TOTP secret already has. Deterministic → still an
   * O(1) indexed lookup. Always the CURRENT key (new rows); lookups use `hmacCandidates`.
   */
  hmac(data: string): string {
    return this.hmacWith(data, this.current.key);
  }

  /**
   * Every MAC the stored value could carry — one per configured key, current first — for an indexed lookup
   * (`WHERE hash IN (…)`). A MAC cannot be re-derived from the DB (the plaintext is gone), so rows written under
   * a previous key keep matching for as long as that key stays in SECRETS_ENCRYPTION_KEY_PREVIOUS.
   */
  hmacCandidates(data: string): string[] {
    return this.keys.map((k) => this.hmacWith(data, k.key));
  }

  private hmacWith(data: string, key: Uint8Array): string {
    return this.sodium.to_hex(this.sodium.crypto_generichash(32, this.sodium.from_string(data), key));
  }
}
