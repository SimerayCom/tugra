#!/usr/bin/env node
// One-time keypair generator for the signed update manifest. Prints an ed25519 keypair:
//   - UPDATE_SIGNING_KEY  : the PRIVATE seed → store as a GitHub Actions secret, NEVER commit.
//   - UPDATE_PUBLISHER_KEY: the PUBLIC key   → operators set this on their instances to verify updates.
// Writes NO files — copy the values from stdout. Depends only on node:crypto (no build needed).
//   node scripts/keygen-publisher.mjs
import { generateKeyPairSync, createPublicKey } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
// PKCS#8 ed25519 DER is 48 bytes: a 16-byte prefix + the 32-byte seed. The seed is UPDATE_SIGNING_KEY.
const seedB64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)).toString("base64");
const pubB64 = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");

if (Buffer.from(seedB64, "base64").length !== 32) {
  console.error("keygen: unexpected seed length");
  process.exit(1);
}
if (Buffer.from(pubB64, "base64").length !== 44) {
  console.error("keygen: unexpected public key length");
  process.exit(1);
}

console.log("UPDATE_SIGNING_KEY (private seed — GitHub Actions secret, NEVER commit):");
console.log(seedB64);
console.log("");
console.log("UPDATE_PUBLISHER_KEY (public — operators set this on their instances):");
console.log(pubB64);
