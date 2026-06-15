import { generateKeyPairSync, sign } from "node:crypto";
import {
  generateEnrollToken,
  generateSeal,
  verifyEd25519,
} from "./agent-auth";

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiB64 = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return { spkiB64, privateKey };
}

describe("agent-auth", () => {
  it("verifies a valid ed25519 signature over the nonce", () => {
    const { spkiB64, privateKey } = makeKeypair();
    const nonce = "challenge-nonce-123";
    const sigB64 = sign(null, Buffer.from(nonce), privateKey).toString("base64");

    expect(verifyEd25519(spkiB64, nonce, sigB64)).toBe(true);
    expect(verifyEd25519(spkiB64, "tampered", sigB64)).toBe(false);
  });

  it("rejects a garbage public key without throwing", () => {
    expect(verifyEd25519("not-a-key", "x", "y")).toBe(false);
  });

  it("generates prefixed, unique tokens and seals", () => {
    expect(generateEnrollToken()).toMatch(/^tugra_en_/);
    expect(generateSeal()).toMatch(/^seal_/);
    expect(generateEnrollToken()).not.toBe(generateEnrollToken());
  });
});
