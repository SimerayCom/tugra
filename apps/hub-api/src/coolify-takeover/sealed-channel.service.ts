import { Injectable } from "@nestjs/common";
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { COOLIFY_SEAL_HKDF_INFO, COOLIFY_SEAL_PAD_BYTES, COOLIFY_SEALED_PREFIX, coolifySealAad } from "@tugra/shared";
import { CryptoService } from "../crypto/crypto.service";

/** Why an envelope did not open. A fixed code only: never the envelope, the key or any decrypted byte in a message. */
export class SealOpenError extends Error {
  constructor(public readonly code: "bad_envelope" | "bad_context" | "bad_key" | "auth_failed") {
    super(code);
    this.name = "SealOpenError";
  }
}

/** Where one sealed value came from; it is the AAD, so a value moved to another field, ref, agent or run does not open. */
export interface SealContext {
  runId: string;
  serverId: string;
  ref: string;
  field: string;
  cls: string;
}

/** A run key held in memory for the life of one fetch. The private half is a KeyObject, never a string and never logged. */
export interface RunKey {
  readonly publicKeyB64: string;
  readonly keyId: string;
  /** @internal */
  readonly priv: KeyObject;
}

// DER prefixes for raw X25519 keys (RFC 8410).
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

/** The id of a recipient key in the HKDF info: first 16 hex chars of SHA-256(raw public key). */
export function sealKeyId(rawPublic: Buffer): string {
  return createHash("sha256").update(rawPublic).digest("hex").slice(0, 16);
}

/**
 * The sealed secret channel (Coolify hub takeover, lane B). The hub makes one X25519 key pair PER RUN, keeps the private half wrapped
 * with CryptoService (tk1) only so a restart can resume, and opens the `tse1` envelopes the agent sends (ephemeral X25519, HKDF-SHA256,
 * AES-256-GCM, Node crypto only). It is NOT the hub signing key and NOT SECRETS_ENCRYPTION_KEY: when the run ends the wrapped private
 * half is cleared, so an envelope captured later can never be opened (forward secrecy for the run).
 *
 * Plaintext exists only in the string `open` returns to its caller, who must hand it straight to an encrypting setter. Nothing here
 * logs, caches, audits or returns a value, and every error carries a fixed code.
 */
@Injectable()
export class SealedChannelService {
  constructor(private readonly crypto: CryptoService) {}

  /** A fresh per-run key pair: the base64 public key (sent to the agent) and the private half wrapped as `tk1.`. */
  newRunKey(): { publicKeyB64: string; privateKeyEnc: string } {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const pub = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
    const d = Buffer.from(String(privateKey.export({ format: "jwk" }).d), "base64url");
    const privateKeyEnc = this.crypto.encrypt(d.toString("base64"));
    d.fill(0);
    return { publicKeyB64: pub.toString("base64"), privateKeyEnc };
  }

  /** Unwrap a stored run key into a KeyObject (throws SealOpenError("bad_key") when it cannot be opened). */
  loadRunKey(privateKeyEnc: string): RunKey {
    let raw: Buffer;
    try {
      raw = Buffer.from(this.crypto.decrypt(privateKeyEnc), "base64");
    } catch {
      throw new SealOpenError("bad_key");
    }
    if (raw.length !== 32) throw new SealOpenError("bad_key");
    try {
      const priv = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
      const pub = Buffer.from(String(createPublicKey(priv).export({ format: "jwk" }).x), "base64url");
      return { publicKeyB64: pub.toString("base64"), keyId: sealKeyId(pub), priv };
    } catch {
      throw new SealOpenError("bad_key");
    } finally {
      raw.fill(0);
    }
  }

  /** Open one envelope. The context must be exactly the one the agent sealed under. */
  open(key: RunKey, envelope: string, ctx: SealContext): string {
    let aad: string;
    try {
      aad = coolifySealAad(ctx);
    } catch {
      throw new SealOpenError("bad_context");
    }
    if (typeof envelope !== "string" || !envelope.startsWith(COOLIFY_SEALED_PREFIX) || envelope.length > 3 << 20) throw new SealOpenError("bad_envelope");
    const body = Buffer.from(envelope.slice(COOLIFY_SEALED_PREFIX.length), "base64url");
    // ephemeral key (32) + nonce (12) + at least one padded block + tag (16)
    if (body.length < 32 + 12 + COOLIFY_SEAL_PAD_BYTES + 16) throw new SealOpenError("bad_envelope");
    let framed: Buffer;
    try {
      const epk = createPublicKey({ key: Buffer.concat([SPKI_X25519, body.subarray(0, 32)]), format: "der", type: "spki" });
      const shared = diffieHellman({ privateKey: key.priv, publicKey: epk }); // throws on a small-order ephemeral key
      const aesKey = Buffer.from(hkdfSync("sha256", shared, Buffer.from(ctx.runId), Buffer.from(COOLIFY_SEAL_HKDF_INFO + key.keyId), 32));
      shared.fill(0);
      const d = createDecipheriv("aes-256-gcm", aesKey, body.subarray(32, 44));
      aesKey.fill(0);
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(body.subarray(body.length - 16));
      framed = Buffer.concat([d.update(body.subarray(44, body.length - 16)), d.final()]);
    } catch {
      throw new SealOpenError("auth_failed");
    }
    try {
      if (framed.length % COOLIFY_SEAL_PAD_BYTES !== 0 || framed.length < 4) throw new SealOpenError("bad_envelope");
      const n = framed.readUInt32BE(0);
      if (n > framed.length - 4) throw new SealOpenError("bad_envelope");
      return framed.subarray(4, 4 + n).toString("utf8");
    } finally {
      framed.fill(0);
    }
  }
}
