// Test helper: opens one tse1 envelope with Node's crypto. stdin lines: recipient private key (hex), runId, serverId, ref, field, class, envelope.
// Prints the plaintext as base64. Exits non-zero when the envelope does not open.
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [privHex, runId, serverId, ref, field, cls, env] = readFileSync(0, "utf8").split("\n");
const priv = Buffer.from(privHex, "hex");
const pkcs8 = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), priv]), format: "der", type: "pkcs8" });
const recipientPub = Buffer.from(createPublicKey(pkcs8).export({ format: "jwk" }).x, "base64url");
const body = Buffer.from(env.slice(5), "base64url");
const epk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), body.subarray(0, 32)]), format: "der", type: "spki" });
const shared = diffieHellman({ privateKey: pkcs8, publicKey: epk });
const keyId = createHash("sha256").update(recipientPub).digest("hex").slice(0, 16);
const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(runId), Buffer.concat([Buffer.from("tugra/coolify-secret/v1"), Buffer.from(keyId)]), 32));
const d = createDecipheriv("aes-256-gcm", key, body.subarray(32, 44));
d.setAAD(Buffer.from([runId, serverId, ref, field, cls].join("\0")));
d.setAuthTag(body.subarray(body.length - 16));
const framed = Buffer.concat([d.update(body.subarray(44, body.length - 16)), d.final()]);
process.stdout.write(framed.subarray(4, 4 + framed.readUInt32BE(0)).toString("base64"));
