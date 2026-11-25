// Regenerates tse1-vectors.json with Node's crypto only (X25519, HKDF-SHA256, AES-256-GCM), an implementation independent of the Go
// one. Every random input is fixed so the output is byte-stable: run `node gen-node-vectors.mjs > tse1-vectors.json`.
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createCipheriv, createHash } from "node:crypto";

const b = (hex) => Buffer.from(hex, "hex");
const recipientPriv = b("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4");
function pubOf(priv) {
  // derive the public key by importing the private half without x, via DER (PKCS8) and exporting the public key
  const der = Buffer.concat([b("302e020100300506032b656e04220420"), priv]);
  const k = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const jwk = createPublicKey(k).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}
const pkcs8 = (priv) => createPrivateKey({ key: Buffer.concat([b("302e020100300506032b656e04220420"), priv]), format: "der", type: "pkcs8" });
const spki = (pub) => createPublicKey({ key: Buffer.concat([b("302a300506032b656e032100"), pub]), format: "der", type: "spki" });

function seal({ recipientPub, ephPriv, nonce, runId, serverId, ref, field, cls, plain }) {
  const ephPub = pubOf(ephPriv);
  const shared = diffieHellman({ privateKey: pkcs8(ephPriv), publicKey: spki(recipientPub) });
  const keyId = createHash("sha256").update(recipientPub).digest("hex").slice(0, 16);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(runId), Buffer.concat([Buffer.from("tugra/coolify-secret/v1"), Buffer.from(keyId)]), 32));
  const framed = Buffer.alloc(Math.ceil((4 + plain.length) / 64) * 64);
  framed.writeUInt32BE(plain.length, 0);
  plain.copy(framed, 4);
  const aad = Buffer.from([runId, serverId, ref, field, cls].join("\0"));
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(framed), c.final(), c.getAuthTag()]);
  return "tse1." + Buffer.concat([ephPub, nonce, ct]).toString("base64url");
}

const recipientPub = pubOf(recipientPriv);
const cases = [
  { name: "short", ref: "env:abc123", field: "value", cls: "env", plain: Buffer.from("postgres://app:hunter2@db:5432/app") },
  { name: "empty", ref: "env:empty01", field: "value", cls: "env", plain: Buffer.alloc(0) },
  { name: "utf8", ref: "database:db0001", field: "postgres_password", cls: "db_credentials", plain: Buffer.from("pa\u00dfw\u00f6rd-\u20ac-\u{1F511}") },
  { name: "exact-block", ref: "s3:s3x001", field: "secret", cls: "s3", plain: Buffer.alloc(60, 0x61) },
  { name: "just-over-block", ref: "s3:s3x001", field: "key", cls: "s3", plain: Buffer.alloc(61, 0x62) },
  { name: "multiline", ref: "service:svc001", field: "docker_compose_raw", cls: "service_compose", plain: Buffer.from("services:\n  a:\n    image: x\n") },
];
const out = {
  recipientPrivHex: recipientPriv.toString("hex"),
  recipientPubB64: recipientPub.toString("base64"),
  runId: "run-0001",
  serverId: "srv-0001",
  vectors: cases.map((c, i) => {
    const ephPriv = Buffer.alloc(32, i + 1);
    const nonce = Buffer.alloc(12, 0x10 + i);
    const env = seal({ recipientPub, ephPriv, nonce, runId: "run-0001", serverId: "srv-0001", ref: c.ref, field: c.field, cls: c.cls, plain: c.plain });
    return { name: c.name, ref: c.ref, field: c.field, class: c.cls, plainB64: c.plain.toString("base64"), ephPrivHex: ephPriv.toString("hex"), nonceHex: nonce.toString("hex"), env };
  }),
};
console.log(JSON.stringify(out, null, 2));
