import { createPublicKey, randomBytes, verify } from "node:crypto";

/** Verify an ed25519 signature from an agent. publicKey = base64(SPKI DER). */
export function verifyEd25519(
  publicKeySpkiB64: string,
  message: string,
  signatureB64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpkiB64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function generateEnrollToken(): string {
  return `tugra_en_${randomBytes(24).toString("base64url")}`;
}

/** The server's "seal" — its unique signed identity. */
export function generateSeal(): string {
  return `seal_${randomBytes(20).toString("base64url")}`;
}
