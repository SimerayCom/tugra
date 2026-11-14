import { ConfigService } from "@nestjs/config";
import { CryptoService, SecretsKeyUnavailableError } from "./crypto.service";

function makeService(passphrase: string | undefined, previous?: string): CryptoService {
  const config = {
    get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? passphrase : k === "SECRETS_ENCRYPTION_KEY_PREVIOUS" ? previous : undefined),
  } as unknown as ConfigService;
  return new CryptoService(config);
}
/** A legacy (pre-rotation) ciphertext: bare base64(nonce||cipher), no key id. */
function legacyEncrypt(svc: CryptoService, plaintext: string): string {
  const v = svc.encrypt(plaintext);
  return v.split(".")[2];
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

describe("CryptoService — key rotation", () => {
  const OLD = "old-passphrase-0123456789";
  const NEW = "new-passphrase-9876543210";

  it("writes versioned ciphertexts (tk1.<keyId>.<base64>) with a stable key id that never reveals the passphrase", async () => {
    const a = makeService(OLD);
    await a.onModuleInit();
    const enc = a.encrypt("v");
    expect(enc).toMatch(/^tk1\.[0-9a-f]{16}\.[A-Za-z0-9+/=]+$/);
    expect(a.keyIdOf(enc)).toBe(a.currentKeyId);
    expect(a.isCurrent(enc)).toBe(true);
    const b = makeService(OLD);
    await b.onModuleInit();
    expect(b.currentKeyId).toBe(a.currentKeyId); // same passphrase → same id across processes
    expect(a.currentKeyId).not.toContain(OLD.slice(0, 6));
    expect(a.previousKeyIds).toEqual([]);
  });

  it("still reads LEGACY unprefixed ciphertexts (marked not-current so the rotation rewrites them)", async () => {
    const svc = makeService(OLD);
    await svc.onModuleInit();
    const legacy = legacyEncrypt(svc, "hello");
    expect(legacy).not.toContain(".");
    expect(svc.decrypt(legacy)).toBe("hello");
    expect(svc.decryptMeta(legacy)).toMatchObject({ plaintext: "hello", current: false, keyId: svc.currentKeyId });
    expect(svc.isCurrent(legacy)).toBe(false);
    expect(svc.keyIdOf(legacy)).toBeNull();
  });

  it("after rotation: the previous key opens old (versioned AND legacy) ciphertexts, new writes use the current key, duplicates collapse", async () => {
    const old = makeService(OLD);
    await old.onModuleInit();
    const oldVersioned = old.encrypt("secret-a");
    const oldLegacy = legacyEncrypt(old, "secret-b");
    const rotated = makeService(NEW, `${OLD}, ${OLD}`); // listed twice → one key
    await rotated.onModuleInit();
    expect(rotated.previousKeyIds).toEqual([old.currentKeyId]);
    expect(rotated.decryptMeta(oldVersioned)).toMatchObject({ plaintext: "secret-a", keyId: old.currentKeyId, current: false });
    expect(rotated.decryptMeta(oldLegacy)).toMatchObject({ plaintext: "secret-b", keyId: old.currentKeyId, current: false });
    const fresh = rotated.encrypt("secret-c");
    expect(rotated.keyIdOf(fresh)).toBe(rotated.currentKeyId);
    expect(rotated.decryptMeta(fresh).current).toBe(true);
    // the OLD process cannot read the new ciphertext and says which key is missing
    expect(() => old.decrypt(fresh)).toThrow(SecretsKeyUnavailableError);
    expect(() => old.decrypt(fresh)).toThrow(new RegExp(rotated.currentKeyId));
  });

  it("a ciphertext under a key that is NOT configured fails with SecretsKeyUnavailableError (never a silent garbage decrypt)", async () => {
    const a = makeService(OLD);
    await a.onModuleInit();
    const enc = a.encrypt("x");
    const legacy = legacyEncrypt(a, "y");
    const other = makeService(NEW, "third-passphrase-5555555555");
    await other.onModuleInit();
    expect(() => other.decrypt(enc)).toThrow(SecretsKeyUnavailableError);
    expect(() => other.decrypt(legacy)).toThrow(SecretsKeyUnavailableError); // tried every key, none opened it
  });

  it("hmac uses the current key; hmacCandidates lists one MAC per configured key, current first", async () => {
    const old = makeService(OLD);
    await old.onModuleInit();
    const rotated = makeService(NEW, OLD);
    await rotated.onModuleInit();
    const data = "recovery:u1:ABCD1234";
    expect(rotated.hmacCandidates(data)).toEqual([rotated.hmac(data), old.hmac(data)]);
    expect(rotated.hmac(data)).not.toBe(old.hmac(data));
    expect(old.hmacCandidates(data)).toEqual([old.hmac(data)]);
  });
});
