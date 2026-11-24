/**
 * Web Push, implemented directly on node:crypto (no library):
 *  - RFC 8291 message encryption (content-coding aes128gcm, RFC 8188) of a payload for one browser subscription,
 *  - RFC 8292 VAPID: an ES256 JWT identifying the application server, sent as `Authorization: vapid t=…, k=…`.
 * Pure functions only (no Nest, no I/O): the transport lives in push.service.ts.
 */
import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createCipheriv,
  hkdfSync,
  randomBytes,
  sign,
  type ECDH,
} from "node:crypto";

const CURVE = "prime256v1";
/** RFC 8188 record size we announce. A push service accepts bodies up to 4096 bytes; we always send a single record. */
const RECORD_SIZE = 4096;
const TAG_LEN = 16;
const HEADER_LEN = 16 + 4 + 1 + 65; // salt + rs + idlen + keyid (the ephemeral public key)
/** Largest plaintext that still fits one 4096-byte body: record minus tag, minus the 0x02 delimiter, minus the header. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_LEN - TAG_LEN - 1;

export function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Browsers hand out the public key as an uncompressed P-256 point (0x04 || X || Y) and a 16-byte auth secret. */
export function isValidSubscriptionKeys(p256dh: string, auth: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return false;
  const pub = fromB64u(p256dh);
  if (pub.length !== 65 || pub[0] !== 0x04) return false;
  if (fromB64u(auth).length !== 16) return false;
  try {
    const probe = createECDH(CURVE);
    probe.generateKeys();
    probe.computeSecret(pub); // rejects a point that is not on the curve
    return true;
  } catch {
    return false;
  }
}

export interface VapidKeys {
  /** Uncompressed public point, base64url: the `applicationServerKey` browsers subscribe with, and `k=` in the header. */
  publicKey: string;
  /** PKCS8 PEM. Secret: store encrypted only. */
  privateKeyPem: string;
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([0x04]), fromB64u(String(jwk.x)), fromB64u(String(jwk.y))]);
  return { publicKey: b64u(point), privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

/** Does this private key belong to this public point? Guards against a half-rotated / corrupted pair. */
export function vapidPairMatches(keys: VapidKeys): boolean {
  try {
    const jwk = createPublicKey(createPrivateKey(keys.privateKeyPem)).export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([0x04]), fromB64u(String(jwk.x)), fromB64u(String(jwk.y))]);
    return b64u(point) === keys.publicKey;
  } catch {
    return false;
  }
}

/** The origin of a push endpoint: the VAPID `aud` claim. */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * The RFC 8292 `Authorization` header value. `exp` is kept well inside the 24h ceiling; `subject` is a mailto: or
 * https: contact the push service can use to reach the operator.
 */
export function vapidAuthorization(
  endpoint: string,
  subject: string,
  keys: VapidKeys,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audienceOf(endpoint), exp: nowSec + 12 * 3600, sub: subject })));
  const input = `${header}.${claims}`;
  // dsaEncoding ieee-p1363 = the raw r||s 64-byte form a JWT wants (node's default is DER).
  const sig = sign("sha256", Buffer.from(input), { key: createPrivateKey(keys.privateKeyPem), dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
}

export interface EncryptOptions {
  /** Test seam: a fixed application-server ephemeral key and salt (RFC 8291 appendix A). Production leaves both unset. */
  ephemeral?: ECDH;
  salt?: Buffer;
}

/** RFC 8291 section 3.4 + RFC 8188: one aes128gcm record addressed to the subscription (`p256dh`, `auth`). */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string, opts: EncryptOptions = {}): Buffer {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload too large (${payload.length} > ${MAX_PAYLOAD_BYTES})`);
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const as = opts.ephemeral ?? createECDH(CURVE);
  if (!opts.ephemeral) as.generateKeys();
  const asPublic = as.getPublicKey();
  const salt = opts.salt ?? randomBytes(16);

  const ecdhSecret = as.computeSecret(uaPublic);
  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, L=32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the final (here: only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed]);
}

export interface WebPushRequest {
  body: Buffer;
  headers: Record<string, string>;
}

/** The full HTTP request for one push: encrypted body + VAPID auth + delivery hints (TTL / Urgency). */
export function buildWebPushRequest(args: {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: Buffer;
  subject: string;
  keys: VapidKeys;
  ttlSec?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}): WebPushRequest {
  const body = encryptPayload(args.payload, args.p256dh, args.auth);
  return {
    body,
    headers: {
      authorization: vapidAuthorization(args.endpoint, args.subject, args.keys),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      "content-length": String(body.length), // push services reject chunked uploads
      ttl: String(args.ttlSec ?? 86_400),
      urgency: args.urgency ?? "normal",
    },
  };
}
