import { createHash, generateKeyPairSync } from "node:crypto";

/**
 * Generate an ed25519 SSH deploy key for cloning a private repo. PURE (no DB/network).
 *
 * node's `createPrivateKey(...).export({ type: "pkcs8" })` produces a PEM OpenSSH REFUSES ("invalid
 * format"), so the private key is hand-serialized in the `openssh-key-v1` container (unencrypted) that
 * `ssh -i` / `git` accept. The public key is the standard `ssh-ed25519 <base64> <comment>` one-liner the
 * user adds to the repo as a read-only deploy key.
 */
export interface GeneratedSshKey {
  privateKeyOpenSsh: string; // "-----BEGIN OPENSSH PRIVATE KEY-----" … (stored encrypted, never returned raw)
  publicKey: string; // "ssh-ed25519 AAAA… tugra"
  fingerprint: string; // "SHA256:…" (OpenSSH-style, as `ssh-keygen -lf` prints)
}

const COMMENT = "tugra";

/** SSH wire string: a uint32 big-endian length prefix followed by the bytes. */
function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function wrap70(b64: string): string {
  return (b64.match(/.{1,70}/g) ?? [b64]).join("\n");
}

export function generateEd25519DeployKey(): GeneratedSshKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The raw 32-byte Ed25519 keys are the tails of the fixed-prefix DER encodings.
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer; // 44 bytes: 12-byte prefix + 32 pub
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer; // 48 bytes: 16-byte prefix + 32 seed
  const pub = spki.subarray(spki.length - 32);
  const seed = pkcs8.subarray(pkcs8.length - 32);

  const keyType = Buffer.from("ssh-ed25519");
  const pubBlob = Buffer.concat([sshString(keyType), sshString(pub)]); // what both the pubkey line and the container carry

  // Private section (unencrypted): check x2, keytype, pub, priv(seed||pub), comment, then 1,2,3… padding to 8.
  const check = Buffer.alloc(4);
  check.writeUInt32BE(0x74756772, 0); // "tugr" — the two checkints must match; value itself is irrelevant
  const priv64 = Buffer.concat([seed, pub]);
  let privSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(priv64),
    sshString(Buffer.from(COMMENT)),
  ]);
  const blockSize = 8; // cipher "none"
  const padLen = (blockSize - (privSection.length % blockSize)) % blockSize;
  if (padLen > 0) {
    const pad = Buffer.alloc(padLen);
    for (let i = 0; i < padLen; i++) pad[i] = i + 1;
    privSection = Buffer.concat([privSection, pad]);
  }

  const container = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString(Buffer.from("none")), // ciphername
    sshString(Buffer.from("none")), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions (empty)
    (() => { const n = Buffer.alloc(4); n.writeUInt32BE(1, 0); return n; })(), // number of keys
    sshString(pubBlob),
    sshString(privSection),
  ]);

  const privateKeyOpenSsh = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrap70(container.toString("base64"))}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const pubB64 = pubBlob.toString("base64");
  const publicKeyLine = `ssh-ed25519 ${pubB64} ${COMMENT}`;
  // OpenSSH fingerprint: base64(sha256(pubBlob)) without padding.
  const fingerprint = `SHA256:${createHash("sha256").update(pubBlob).digest("base64").replace(/=+$/, "")}`;

  return { privateKeyOpenSsh, publicKey: publicKeyLine, fingerprint };
}
