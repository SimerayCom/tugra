import { createPublicKey, verify } from "node:crypto";
import { HubSigningService } from "./hub-signing.service";

const SEED_B64 = Buffer.alloc(32, 7).toString("base64"); // deterministic 32-byte seed

describe("HubSigningService", () => {
  const prev = process.env.HUB_SIGNING_KEY;
  afterAll(() => {
    process.env.HUB_SIGNING_KEY = prev;
  });

  it("derives a deterministic key from HUB_SIGNING_KEY seed", () => {
    process.env.HUB_SIGNING_KEY = SEED_B64;
    const a = new HubSigningService();
    const b = new HubSigningService();
    expect(a.publicKeySpkiBase64).toBe(b.publicKeySpkiBase64);
  });

  it("produces signatures that verify against the published public key", () => {
    process.env.HUB_SIGNING_KEY = SEED_B64;
    const svc = new HubSigningService();
    const pub = createPublicKey({
      key: Buffer.from(svc.publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const msg = "cmd\nr1\necho hi\n5000";
    const sig = Buffer.from(svc.sign(msg), "base64");
    expect(verify(null, Buffer.from(msg), pub, sig)).toBe(true);
    expect(verify(null, Buffer.from("tampered"), pub, sig)).toBe(false);
  });

  it("generates an ephemeral key when no seed is set", () => {
    delete process.env.HUB_SIGNING_KEY;
    const svc = new HubSigningService();
    expect(svc.publicKeySpkiBase64).toBeTruthy();
    expect(svc.sign("x")).toBeTruthy();
  });
});
