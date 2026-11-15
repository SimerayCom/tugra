import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import _sodium from "libsodium-wrappers";
import type { KeyringSnapshot, KeyringStore } from "./keyring.store";

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
        ? `secret was encrypted with key ${keyId}, which is not loaded in this hub (restore it in Settings -> Secrets encryption key, or add it to SECRETS_ENCRYPTION_KEY_PREVIOUS)`
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

export type KeySource = "env" | "ring";

interface LoadedKey {
  id: string;
  key: Uint8Array;
  /** "env": derived from SECRETS_ENCRYPTION_KEY / _PREVIOUS. "ring": a random data key unwrapped from the keyring. */
  source: KeySource;
}

/** One immutable view of every loaded key. Swapped in a single assignment (applyRing); every public method reads
 *  `this.ring` exactly once, so a call is atomic against a concurrent swap. */
interface Ring {
  /** Encryption order: keys[0] writes every new ciphertext. */
  keys: LoadedKey[];
  /** The .env keys in configured order (current first). Root of trust; the only source of MACs and legacy trials. */
  envKeys: LoadedKey[];
  /** The key every MAC is made with: the env current key, never a data key. */
  mac: LoadedKey;
  epoch: number;
  degraded: string | null;
}

/** A data-key wrap row to persist: the DK, secretbox-encrypted under one .env root key. */
export interface WrapRow {
  keyId: string;
  rootKeyId: string;
  wrapped: string;
}

/**
 * Symmetric encryption for secrets-at-rest. libsodium secretbox (XSalsa20-Poly1305); each 32-byte key is derived
 * from a passphrase via BLAKE2b, so any passphrase length works.
 *
 * ROOT KEYS: `SECRETS_ENCRYPTION_KEY` is the CURRENT root key; `SECRETS_ENCRYPTION_KEY_PREVIOUS` (comma-separated,
 * optional) lists root keys that may still open OLD ciphertexts. They are read at boot only.
 *
 * ENVELOPE KEYRING (no-restart rotation): random data keys (DK) live in Postgres, stored ONLY wrapped under the
 * root key(s), so a DB-only dump decrypts nothing. With an ACTIVE DK every new ciphertext is written under it;
 * DECRYPT_ONLY DKs and the root keys still open older rows. With zero keyring rows the ring is exactly
 * `[env current, ...env previous]` — byte-identical to the pre-keyring behaviour. The ring is swapped atomically
 * (`applyRing`) when an owner rotates, with no restart and no .env change.
 *
 * Every ciphertext written since rotation support carries its key id (`tk1.<keyId>.<base64>`), so decryption picks
 * the exact key; a legacy bare-base64 ciphertext is tried against the ROOT keys only (data keys never wrote bare
 * ciphertexts). A key id is the first 16 hex chars of BLAKE2b(key) — stable across restarts, never reveals the
 * passphrase or a key. MACs (2FA recovery codes) are always made with the env current key.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private sodium!: typeof _sodium;
  private ring: Ring = { keys: [], envKeys: [], mac: undefined as unknown as LoadedKey, epoch: 0, degraded: null };
  private ready = false;

  /** Best-effort hook: called (synchronously, never throwing) when a versioned ciphertext names a key id that is not
   *  in the ring, so the keyring service can refresh in case another process just rotated. */
  onUnknownKey?: () => void;

  constructor(
    private readonly config: ConfigService,
    private readonly store?: KeyringStore,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.ready) return; // idempotent: the async module factory already initialised us before Nest's own hook
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
    this.ring = { keys: loaded, envKeys: loaded, mac: loaded[0], epoch: 0, degraded: null };
    if (this.store) {
      // A store failure throws: boot fails closed rather than starting with a ring that could not read DK rows.
      this.applyRing(await this.store.load());
    }
    this.ready = true;
    if (this.ring.keys.length > 1 && !this.ring.keys.some((k) => k.source === "ring")) {
      this.logger.warn(`secrets key rotation in progress: current ${this.currentKeyId}, previous ${this.previousKeyIds.join(", ")} — re-encrypt stored secrets, then remove SECRETS_ENCRYPTION_KEY_PREVIOUS`);
    }
  }

  private derive(passphrase: string): LoadedKey {
    const key = this.sodium.crypto_generichash(this.sodium.crypto_secretbox_KEYBYTES, passphrase, null);
    // Fingerprint of the DERIVED key (not the passphrase): stable, public-safe, 64 bits is plenty for an id.
    const id = this.sodium.to_hex(this.sodium.crypto_generichash(8, key, null));
    return { id, key, source: "env" };
  }

  private fingerprint(key: Uint8Array): string {
    return this.sodium.to_hex(this.sodium.crypto_generichash(8, key, null));
  }

  /** Id of the key every new ciphertext is written under. */
  get currentKeyId(): string {
    return this.ring.keys[0].id;
  }

  /** Ids of the other loaded keys (ring order). Empty when no rotation is in progress. */
  get previousKeyIds(): string[] {
    return this.ring.keys.slice(1).map((k) => k.id);
  }

  /** Id of the .env current (root) key: the MAC key, and the encryption key whenever no data key is active. */
  get envCurrentKeyId(): string {
    return this.ring.envKeys[0].id;
  }

  /** Epoch of the keyring snapshot the ring was built from (0 with no keyring rows / no store). */
  get ringEpoch(): number {
    return this.ring.epoch;
  }

  /** Non-null when a keyring data key could not be unwrapped with the configured root key(s). */
  get ringDegraded(): string | null {
    return this.ring.degraded;
  }

  /** The loaded keys in ring order, ids and sources only — never key material. */
  describeKeys(): { id: string; source: KeySource }[] {
    return this.ring.keys.map((k) => ({ id: k.id, source: k.source }));
  }

  encrypt(plaintext: string): string {
    const ring = this.ring;
    return this.encryptWith(plaintext, ring.keys[0]);
  }

  private encryptWith(plaintext: string, key: LoadedKey): string {
    const nonce = this.sodium.randombytes_buf(this.sodium.crypto_secretbox_NONCEBYTES);
    const cipher = this.sodium.crypto_secretbox_easy(this.sodium.from_string(plaintext), nonce, key.key);
    const combined = new Uint8Array(nonce.length + cipher.length);
    combined.set(nonce);
    combined.set(cipher, nonce.length);
    return `${CIPHERTEXT_V1_PREFIX}${key.id}.${this.sodium.to_base64(combined, this.sodium.base64_variants.ORIGINAL)}`;
  }

  decrypt(payload: string): string {
    return this.decryptMeta(payload).plaintext;
  }

  /** Decrypt and report WHICH key opened the ciphertext and whether it is already current. */
  decryptMeta(payload: string): DecryptedSecret {
    const ring = this.ring;
    const m = VERSIONED_RE.exec(payload);
    if (m) {
      const key = ring.keys.find((k) => k.id === m[1]);
      if (!key) {
        this.notifyUnknownKey();
        throw new SecretsKeyUnavailableError(m[1]);
      }
      return { plaintext: this.open(m[2], key.key), keyId: key.id, current: key.id === ring.keys[0].id };
    }
    // Legacy (unprefixed) ciphertext: no key id to go by — try each ROOT (env) key, current first (data keys never
    // wrote bare ciphertexts). A legacy ciphertext is never "current": the rotation job rewrites it so the key id
    // is recorded.
    let lastErr: unknown;
    for (const k of ring.envKeys) {
      try {
        return { plaintext: this.open(payload, k.key), keyId: k.id, current: false };
      } catch (e) {
        lastErr = e;
      }
    }
    if (ring.keys.length > 1 || payload.startsWith(CIPHERTEXT_V1_PREFIX)) throw new SecretsKeyUnavailableError(null);
    throw lastErr instanceof Error ? lastErr : new Error("decrypt failed");
  }

  private notifyUnknownKey(): void {
    try {
      this.onUnknownKey?.();
    } catch {
      /* best effort */
    }
  }

  /** Whether a stored ciphertext is in the versioned format under the current key (no rewrite needed). Pure
   *  string check — never decrypts. */
  isCurrent(payload: string): boolean {
    const ring = this.ring;
    const m = VERSIONED_RE.exec(payload);
    return !!m && m[1] === ring.keys[0].id;
  }

  /** The key id a stored ciphertext claims, or null for a legacy (unprefixed) one. */
  keyIdOf(payload: string): string | null {
    const m = VERSIONED_RE.exec(payload);
    return m ? m[1] : null;
  }

  private open(b64: string, key: Uint8Array): string {
    return this.sodium.to_string(this.openBytes(b64, key));
  }

  private openBytes(b64: string, key: Uint8Array): Uint8Array {
    const combined = this.sodium.from_base64(b64, this.sodium.base64_variants.ORIGINAL);
    const nonce = combined.slice(0, this.sodium.crypto_secretbox_NONCEBYTES);
    const cipher = combined.slice(this.sodium.crypto_secretbox_NONCEBYTES);
    return this.sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  }

  /**
   * Keyed hash (MAC) for storing high-value, LOW-entropy secrets like 2FA recovery codes.
   * Unlike a bare sha256, the digest cannot be brute-forced from a DB-only leak because it
   * depends on the server key (derived from SECRETS_ENCRYPTION_KEY, never stored in the DB) —
   * matching the protection the encrypted TOTP secret already has. Deterministic → still an
   * O(1) indexed lookup. Always the CURRENT key (new rows); lookups use `hmacCandidates`.
   */
  hmac(data: string): string {
    return this.hmacWith(data, this.ring.mac.key);
  }

  /**
   * Every MAC the stored value could carry — one per configured ENV key, current first — for an indexed lookup
   * (`WHERE hash IN (…)`). A MAC cannot be re-derived from the DB (the plaintext is gone), so rows written under
   * a previous key keep matching for as long as that key stays in SECRETS_ENCRYPTION_KEY_PREVIOUS.
   */
  hmacCandidates(data: string): string[] {
    return this.ring.envKeys.map((k) => this.hmacWith(data, k.key));
  }

  // ---- envelope keyring -------------------------------------------------------------------------------------------

  /** A fresh random 32-byte data key and its id (the fingerprint carried in ciphertexts). The caller wraps it
   *  (`wrapForRoots`), persists the wraps, and zeroes the bytes; the ring loads it back from the wraps. */
  generateDataKey(): { id: string; key: Uint8Array } {
    const key = this.sodium.randombytes_buf(this.sodium.crypto_secretbox_KEYBYTES);
    return { id: this.fingerprint(key), key };
  }

  /** One wrap per .env key (current and previous): the base64 of the DK, secretbox-encrypted under that root key in
   *  the tk1 format. With every root wrapped, either root opens the DK across a manual passphrase rotation. */
  wrapForRoots(dk: Uint8Array): { rootKeyId: string; wrapped: string }[] {
    const text = this.sodium.to_base64(dk, this.sodium.base64_variants.ORIGINAL);
    return this.ring.envKeys.map((root) => ({ rootKeyId: root.id, wrapped: this.encryptWith(text, root) }));
  }

  /** Whether any wrap opens under a currently configured root key (and, when `keyId` is given, unwraps to the key
   *  with that fingerprint). Used by Restore. */
  canUnwrap(wraps: { rootKeyId: string; wrapped: string }[], keyId?: string): boolean {
    return this.unwrap(wraps, this.ring.envKeys, keyId) !== null;
  }

  private unwrap(wraps: { rootKeyId: string; wrapped: string }[], roots: LoadedKey[], expectedId?: string): Uint8Array | null {
    for (const w of wraps) {
      const root = roots.find((r) => r.id === w.rootKeyId);
      const m = VERSIONED_RE.exec(w.wrapped);
      if (!root || !m || m[1] !== root.id) continue;
      try {
        const bytes = this.sodium.from_base64(this.open(m[2], root.key), this.sodium.base64_variants.ORIGINAL);
        if (bytes.length !== this.sodium.crypto_secretbox_KEYBYTES) continue;
        if (expectedId !== undefined && this.fingerprint(bytes) !== expectedId) continue; // corrupt / mismatched wrap
        return bytes;
      } catch {
        /* wrong root or damaged wrap: try the next one */
      }
    }
    return null;
  }

  /**
   * Build a new ring from a keyring snapshot and swap it in with ONE assignment. Never throws on a bad key: a
   * non-retired DK that cannot be unwrapped (no wrap under a configured root, or the unwrapped bytes do not match
   * the row id) sets `degraded` and is left out. If the ACTIVE DK is the one left out, the ring falls back to env
   * order (encryption under the .env current key — a configured key, same failure shape as an env passphrase
   * mistake). Returns the wraps that should be persisted so each loaded DK is wrapped under the CURRENT root (this is
   * what makes a manual .env passphrase rotation work without re-encrypting any data-key row).
   */
  applyRing(snap: KeyringSnapshot): { wrapsToAdd: WrapRow[] } {
    const prev = this.ring;
    const envKeys = prev.envKeys;
    const reuse = new Map(prev.keys.filter((k) => k.source === "ring").map((k) => [k.id, k]));
    const loaded: { key: LoadedKey; state: string; activatedAt: number }[] = [];
    let degraded: string | null = null;
    for (const row of snap.keys) {
      if (row.state === "RETIRED") continue; // never loaded
      let key = reuse.get(row.id);
      if (!key) {
        const bytes = this.unwrap(snap.wraps.filter((w) => w.keyId === row.id), envKeys, row.id);
        if (bytes) key = { id: row.id, key: bytes, source: "ring" };
      }
      if (!key) {
        degraded ??= `key ${row.id} cannot be unwrapped with the configured root key(s)`;
        this.logger.error(`secrets keyring: key ${row.id} cannot be unwrapped with the configured root key(s)`);
        continue;
      }
      loaded.push({ key, state: row.state, activatedAt: new Date(row.activatedAt).getTime() });
    }
    // At most one ACTIVE by construction (epoch row lock); if the data ever shows more, the newest activation wins
    // and the rest read as decrypt-only.
    const actives = loaded.filter((l) => l.state === "ACTIVE").sort((a, b) => b.activatedAt - a.activatedAt);
    const active = actives[0]?.key ?? null;
    const decryptOnly = loaded
      .filter((l) => l.key !== active)
      .sort((a, b) => b.activatedAt - a.activatedAt)
      .map((l) => l.key);
    const keys = active ? [active, ...decryptOnly, ...envKeys] : [envKeys[0], ...decryptOnly, ...envKeys.slice(1)];
    const next: Ring = { keys, envKeys, mac: envKeys[0], epoch: snap.epoch, degraded };
    this.ring = next;
    // Zero only the buffers of ring-source keys that left the ring; keys that stay share their buffers.
    const kept = new Set(keys);
    for (const k of prev.keys) if (k.source === "ring" && !kept.has(k)) this.sodium.memzero(k.key);

    const currentRoot = envKeys[0];
    const wrapsToAdd: WrapRow[] = [];
    for (const l of loaded) {
      if (snap.wraps.some((w) => w.keyId === l.key.id && w.rootKeyId === currentRoot.id)) continue;
      const text = this.sodium.to_base64(l.key.key, this.sodium.base64_variants.ORIGINAL);
      wrapsToAdd.push({ keyId: l.key.id, rootKeyId: currentRoot.id, wrapped: this.encryptWith(text, currentRoot) });
    }
    return { wrapsToAdd };
  }

  private hmacWith(data: string, key: Uint8Array): string {
    return this.sodium.to_hex(this.sodium.crypto_generichash(32, this.sodium.from_string(data), key));
  }
}
