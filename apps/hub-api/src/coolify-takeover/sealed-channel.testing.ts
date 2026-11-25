import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { COOLIFY_SEAL_HKDF_INFO, COOLIFY_SEAL_PAD_BYTES, COOLIFY_SEALED_PREFIX, coolifySealAad } from "@tugra/shared";
import { sealKeyId, type SealContext } from "./sealed-channel.service";

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

/**
 * Tests only (never imported by production code): seal a value the way the agent does, so the hub side can be exercised without an agent.
 * The nonce can be fixed by the caller; the ephemeral key is fresh unless given.
 */
export function sealForTest(recipientB64: string, ctx: SealContext, plain: string, nonce: Buffer = Buffer.alloc(12, 7)): string {
  const recipient = Buffer.from(recipientB64, "base64");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const epk = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, recipient]), format: "der", type: "spki" }) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(ctx.runId), Buffer.from(COOLIFY_SEAL_HKDF_INFO + sealKeyId(recipient)), 32));
  const p = Buffer.from(plain);
  const framed = Buffer.alloc(Math.ceil((4 + p.length) / COOLIFY_SEAL_PAD_BYTES) * COOLIFY_SEAL_PAD_BYTES);
  framed.writeUInt32BE(p.length, 0);
  p.copy(framed, 4);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(coolifySealAad(ctx)));
  const ct = Buffer.concat([c.update(framed), c.final(), c.getAuthTag()]);
  return COOLIFY_SEALED_PREFIX + Buffer.concat([epk, nonce, ct]).toString("base64url");
}
