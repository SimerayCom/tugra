import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { isIPv4 } from "node:net";

// A self-signed TLS certificate for the hub when it is reached on a bare IP (http://<ip>/ install: no domain, so no
// public CA can issue one). Built with node:crypto only: the X.509 structure is small enough to DER-encode directly,
// so no third-party library is needed. ECDSA P-256 / SHA-256, a 10-year validity, an iPAddress SAN and the serverAuth
// key usage — what OpenSSL/curl need to accept it as a pinned trust anchor and what Traefik serves as its default cert.

export interface SelfSignedCert {
  /** Leaf certificate, PEM. */
  certPem: string;
  /** PKCS#8 private key, PEM. */
  keyPem: string;
  /** `sha256:<64 hex>` of the certificate DER — what an agent pins (the same value `openssl x509 -fingerprint -sha256` prints, lower-case, no colons). */
  fingerprint: string;
}

// ---- minimal DER ------------------------------------------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const oid = (dotted: string): Buffer => {
  const a = dotted.split(".").map(Number);
  const out: number[] = [a[0]! * 40 + a[1]!];
  for (const n of a.slice(2)) {
    const chunk: number[] = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer) => tlv(0x03, Buffer.from([0]), b); // 0 unused bits
const boolTrue = tlv(0x01, Buffer.from([0xff]));
/** Non-negative INTEGER from big-endian bytes (a leading 0 is added when the top bit is set). */
function posInt(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  return tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  if (y >= 2050 || y < 1950) throw new Error("validity outside the UTCTime range");
  return tlv(0x17, Buffer.from(`${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_ORG = "2.5.4.10";
const OID_BASIC = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EKU = "2.5.29.37";
const OID_SAN = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

function ext(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [boolTrue] : []), octets(value));
}

function name(cn: string): Buffer {
  return seq(set(seq(oid(OID_ORG), utf8("Tugra"))), set(seq(oid(OID_CN), utf8(cn))));
}

export interface SelfSignedOpts {
  /** The IPv4 the hub is reached on; becomes the iPAddress SAN and the CN. Omit for a certificate without a SAN. */
  ip?: string;
  /** Validity in days (default ~10 years). */
  days?: number;
  now?: Date;
}

/** Generate a fresh ECDSA P-256 key and a self-signed certificate for it. */
export function generateSelfSignedCert(opts: SelfSignedOpts = {}): SelfSignedCert {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return signSelfSigned(publicKey, privateKey, opts);
}

function signSelfSigned(publicKey: KeyObject, privateKey: KeyObject, opts: SelfSignedOpts): SelfSignedCert {
  const ip = opts.ip && isIPv4(opts.ip) ? opts.ip : undefined;
  const now = opts.now ?? new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600_000); // tolerate a skewed clock on the agent
  const notAfter = new Date(now.getTime() + (opts.days ?? 3650) * 24 * 3600_000);
  const serial = randomBytes(16);
  serial[0]! &= 0x7f; // positive
  const subject = name(ip ?? "tugra-hub");
  const alg = seq(oid(OID_ECDSA_SHA256));
  const exts: Buffer[] = [
    ext(OID_BASIC, true, seq()), // cA = FALSE (the default, omitted)
    ext(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]))), // digitalSignature (ECDSA)
    ext(OID_EKU, false, seq(oid(OID_SERVER_AUTH))),
  ];
  if (ip) exts.push(ext(OID_SAN, false, seq(tlv(0x87, Buffer.from(ip.split(".").map(Number))))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // version v3
    posInt(serial),
    alg,
    subject, // issuer == subject (self-signed)
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    Buffer.from(publicKey.export({ format: "der", type: "spki" })),
    tlv(0xa3, seq(...exts)),
  );
  // Node returns ECDSA signatures as the DER Ecdsa-Sig-Value when dsaEncoding is "der" — exactly what X.509 carries.
  const sig = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, alg, bitString(sig));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    fingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
  };
}

/** `sha256:<hex>` of a PEM certificate's DER — recomputed from the stored PEM so the pin can never drift from the served cert. */
export function certFingerprint(certPem: string): string {
  return `sha256:${new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase()}`;
}

/** base64 of the SHA-256 of the certificate's SubjectPublicKeyInfo — what `curl --pinnedpubkey sha256//<this>` takes. */
export function certSpkiPin(certPem: string): string {
  const spki = new X509Certificate(certPem).publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("base64");
}
