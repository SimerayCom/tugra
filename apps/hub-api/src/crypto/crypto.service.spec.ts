import { ConfigService } from "@nestjs/config";
import { CryptoService } from "./crypto.service";

function makeService(passphrase: string | undefined): CryptoService {
  const config = {
    get: () => passphrase,
  } as unknown as ConfigService;
  return new CryptoService(config);
}

describe("CryptoService", () => {
  it("round-trips a value (encrypt then decrypt)", async () => {
    const svc = makeService("test-passphrase-1234567890");
    await svc.onModuleInit();

    const secret = "JBSWY3DPEHPK3PXP";
    const enc = svc.encrypt(secret);

    expect(enc).not.toContain(secret);
    expect(svc.decrypt(enc)).toBe(secret);
  });

  it("produces a different ciphertext each time (random nonce)", async () => {
    const svc = makeService("test-passphrase-1234567890");
    await svc.onModuleInit();

    expect(svc.encrypt("same")).not.toBe(svc.encrypt("same"));
  });

  it("fails closed when the master key is missing", async () => {
    const svc = makeService(undefined);
    await expect(svc.onModuleInit()).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
  });
});
