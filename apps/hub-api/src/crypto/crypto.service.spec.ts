import { ConfigService } from "@nestjs/config";
import _sodium from "libsodium-wrappers";
import { CryptoService, SecretsKeyUnavailableError } from "./crypto.service";
import type { KeyringSnapshot, KeyringStore } from "./keyring.store";

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

describe("CryptoService — envelope keyring", () => {
  const ROOT = "root-passphrase-0123456789";
  const ROOT2 = "root2-passphrase-9876543210";
  const cfg = (current: string, previous?: string) =>
    ({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? current : k === "SECRETS_ENCRYPTION_KEY_PREVIOUS" ? previous : undefined) }) as unknown as ConfigService;
  const storeOf = (snap: () => KeyringSnapshot): KeyringStore => ({ load: async () => snap(), readEpoch: async () => snap().epoch });
  const empty: KeyringSnapshot = { epoch: 0, keys: [], wraps: [] };
  const at = new Date("2026-11-19T10:00:00Z");

  /** A data key wrapped by `wrapper` (a service whose env keys are the roots), as the keyring service persists it. */
  function dataKey(wrapper: CryptoService, state: "ACTIVE" | "DECRYPT_ONLY" | "RETIRED" = "ACTIVE", activatedAt = at) {
    const dk = wrapper.generateDataKey();
    const wraps = wrapper.wrapForRoots(dk.key).map((w) => ({ keyId: dk.id, ...w }));
    return { id: dk.id, row: { id: dk.id, state, activatedAt, demotedAt: null }, wraps };
  }
  async function envOnly(current = ROOT, previous?: string) {
    const svc = new CryptoService(cfg(current, previous));
    await svc.onModuleInit();
    return svc;
  }
  async function withRing(snap: KeyringSnapshot, current = ROOT, previous?: string) {
    const svc = new CryptoService(cfg(current, previous), storeOf(() => snap));
    await svc.onModuleInit();
    return svc;
  }

  it("zero keyring rows: the ring is exactly the env keys, byte-identical to a store-less service", async () => {
    const plain = await envOnly(ROOT, ROOT2);
    const viaStore = await withRing(empty, ROOT, ROOT2);
    expect(viaStore.currentKeyId).toBe(plain.currentKeyId);
    expect(viaStore.previousKeyIds).toEqual(plain.previousKeyIds);
    expect(viaStore.describeKeys()).toEqual(plain.describeKeys());
    expect(viaStore.describeKeys().every((k) => k.source === "env")).toBe(true);
    expect(viaStore.ringEpoch).toBe(0);
    expect(viaStore.ringDegraded).toBeNull();
    expect(viaStore.decrypt(plain.encrypt("same"))).toBe("same");
    expect(viaStore.envCurrentKeyId).toBe(plain.currentKeyId);
  });

  it("an ACTIVE data key encrypts; env keys (and legacy bare ciphertexts) still decrypt and report not-current", async () => {
    const env = await envOnly();
    const k = dataKey(env);
    const svc = await withRing({ epoch: 3, keys: [k.row], wraps: k.wraps });
    expect(svc.currentKeyId).toBe(k.id);
    expect(svc.currentKeyId).not.toBe(svc.envCurrentKeyId);
    expect(svc.envCurrentKeyId).toBe(env.currentKeyId);
    expect(svc.ringEpoch).toBe(3);
    expect(svc.describeKeys()).toEqual([{ id: k.id, source: "ring" }, { id: env.currentKeyId, source: "env" }]);
    const fresh = svc.encrypt("new");
    expect(svc.keyIdOf(fresh)).toBe(k.id);
    expect(svc.decryptMeta(fresh)).toMatchObject({ plaintext: "new", keyId: k.id, current: true });
    const legacyRow = env.encrypt("old").split(".")[2];
    expect(svc.decryptMeta(legacyRow)).toMatchObject({ plaintext: "old", current: false, keyId: env.currentKeyId });
    expect(svc.decryptMeta(env.encrypt("old2"))).toMatchObject({ plaintext: "old2", current: false });
    expect(svc.isCurrent(fresh)).toBe(true);
    expect(svc.isCurrent(env.encrypt("x"))).toBe(false);
    // a process that never had the data key cannot read the new value, and names the key
    expect(() => env.decrypt(fresh)).toThrow(new RegExp(k.id));
  });

  it("DECRYPT_ONLY keys still open their rows but never encrypt; order is active, decrypt-only newest first, env", async () => {
    const env = await envOnly(ROOT, ROOT2);
    const old = dataKey(env, "DECRYPT_ONLY", new Date("2026-11-01T00:00:00Z"));
    const mid = dataKey(env, "DECRYPT_ONLY", new Date("2026-11-10T00:00:00Z"));
    const act = dataKey(env, "ACTIVE", new Date("2026-11-18T00:00:00Z"));
    const svc = await withRing({ epoch: 4, keys: [old.row, act.row, mid.row], wraps: [...old.wraps, ...act.wraps, ...mid.wraps] }, ROOT, ROOT2);
    expect(svc.describeKeys().map((k) => k.id)).toEqual([act.id, mid.id, old.id, env.currentKeyId, ...env.previousKeyIds]);
    const viaOld = (() => {
      // a ciphertext written under the old data key by a process that had it active
      return withRing({ epoch: 1, keys: [{ ...old.row, state: "ACTIVE" }], wraps: old.wraps }, ROOT, ROOT2).then((o) => o.encrypt("from-old"));
    })();
    expect(svc.decrypt(await viaOld)).toBe("from-old");
    expect(svc.keyIdOf(svc.encrypt("w"))).toBe(act.id);
  });

  it("RETIRED keys are never loaded (their rows read as unavailable)", async () => {
    const env = await envOnly();
    const dead = dataKey(env, "RETIRED");
    const writer = await withRing({ epoch: 1, keys: [{ ...dead.row, state: "ACTIVE" }], wraps: dead.wraps });
    const ct = writer.encrypt("gone");
    const svc = await withRing({ epoch: 2, keys: [dead.row], wraps: dead.wraps });
    expect(svc.describeKeys().map((k) => k.id)).toEqual([env.currentKeyId]);
    expect(svc.ringDegraded).toBeNull();
    expect(() => svc.decrypt(ct)).toThrow(SecretsKeyUnavailableError);
  });

  it("hmac and hmacCandidates stay on the env keys only: a data key never produces a MAC", async () => {
    const env = await envOnly(ROOT, ROOT2);
    const k = dataKey(env);
    const svc = await withRing({ epoch: 1, keys: [k.row], wraps: k.wraps }, ROOT, ROOT2);
    const data = "recovery:u1:ABCD";
    expect(svc.hmac(data)).toBe(env.hmac(data));
    expect(svc.hmacCandidates(data)).toEqual(env.hmacCandidates(data));
    expect(svc.hmacCandidates(data)).toHaveLength(2); // one per ENV key, none for the DK
  });

  it("wrap/unwrap round-trips under every root; a wrap under a root that is no longer configured is not openable", async () => {
    const env = await envOnly(ROOT, ROOT2);
    const dk = env.generateDataKey();
    const wraps = env.wrapForRoots(dk.key);
    expect(wraps.map((w) => w.rootKeyId)).toEqual([env.envCurrentKeyId, ...env.previousKeyIds]);
    for (const w of wraps) expect(w.wrapped).toMatch(new RegExp(`^tk1\\.${w.rootKeyId}\\.`));
    expect(env.canUnwrap(wraps, dk.id)).toBe(true);
    expect(env.canUnwrap(wraps, "0000000000000000")).toBe(false); // fingerprint mismatch
    const onlyRoot2Missing = await envOnly("third-passphrase-5555555555");
    expect(onlyRoot2Missing.canUnwrap(wraps, dk.id)).toBe(false);
    // the wrapped text is secretbox ciphertext: the raw key bytes never appear in it
    expect(wraps.every((w) => !w.wrapped.includes(_sodium.to_base64(dk.key, _sodium.base64_variants.ORIGINAL)))).toBe(true);
  });

  it("a wrong root or a wrong fingerprint is DEGRADED (never a throw) and falls back to env current", async () => {
    const other = await envOnly("some-other-root-0000000000");
    const foreign = dataKey(other); // wrapped under a root this hub does not have
    const svc = await withRing({ epoch: 2, keys: [foreign.row], wraps: foreign.wraps });
    expect(svc.ringDegraded).toBe(`key ${foreign.id} cannot be unwrapped with the configured root key(s)`);
    expect(svc.currentKeyId).toBe(svc.envCurrentKeyId); // encrypts under the configured .env key
    expect(svc.describeKeys().every((k) => k.source === "env")).toBe(true);
    expect(svc.decrypt(svc.encrypt("still-works"))).toBe("still-works");

    const env = await envOnly();
    const k = dataKey(env);
    const wrongId = "ffffffffffffffff"; // the wrap opens fine but the bytes do not match the row id
    const svc2 = await withRing({ epoch: 2, keys: [{ ...k.row, id: wrongId }], wraps: k.wraps.map((w) => ({ ...w, keyId: wrongId })) });
    expect(svc2.ringDegraded).toContain(wrongId);
    expect(svc2.currentKeyId).toBe(svc2.envCurrentKeyId);
    // a healthy row alongside a broken one is still loaded
    const good = dataKey(env, "DECRYPT_ONLY");
    const svc3 = await withRing({ epoch: 2, keys: [foreign.row, good.row], wraps: [...foreign.wraps, ...good.wraps] });
    expect(svc3.ringDegraded).toContain(foreign.id);
    expect(svc3.describeKeys().map((x) => x.id)).toContain(good.id);
  });

  it("an error from the store fails boot closed", async () => {
    const svc = new CryptoService(cfg(ROOT), { load: async () => Promise.reject(new Error("db down")), readEpoch: async () => 0 });
    await expect(svc.onModuleInit()).rejects.toThrow("db down");
  });

  it("onModuleInit is idempotent (the async module factory initialises first, Nest calls it again)", async () => {
    let loads = 0;
    const svc = new CryptoService(cfg(ROOT), { load: async () => (loads++, empty), readEpoch: async () => 0 });
    await svc.onModuleInit();
    const id = svc.currentKeyId;
    await svc.onModuleInit();
    expect(loads).toBe(1);
    expect(svc.currentKeyId).toBe(id);
  });

  it("applyRing mid-call never mis-reports `current`: decryptMeta reads one ring snapshot", async () => {
    const env = await envOnly();
    const k = dataKey(env);
    const snap: KeyringSnapshot = { epoch: 1, keys: [k.row], wraps: k.wraps };
    const svc = await withRing(snap);
    const ct = svc.encrypt("v"); // under the ACTIVE data key
    // Swap in a ring where that key is only decrypt-only (so it is no longer current) while the decrypt is in flight.
    const demoted: KeyringSnapshot = { epoch: 2, keys: [{ ...k.row, state: "DECRYPT_ONLY" }], wraps: k.wraps };
    const real = (svc as unknown as { open: (b: string, key: Uint8Array) => string }).open.bind(svc);
    jest.spyOn(svc as unknown as { open: (b: string, key: Uint8Array) => string }, "open").mockImplementation((b, key) => {
      svc.applyRing(demoted);
      return real(b, key);
    });
    expect(svc.decryptMeta(ct)).toMatchObject({ plaintext: "v", keyId: k.id, current: true }); // the snapshot it started with
    jest.restoreAllMocks();
    expect(svc.ringEpoch).toBe(2);
    expect(svc.decryptMeta(ct)).toMatchObject({ current: false }); // the new ring now says so
    expect(svc.currentKeyId).toBe(svc.envCurrentKeyId);
  });

  it("encrypt takes one snapshot: the key id in the output is the key that sealed it", async () => {
    const env = await envOnly();
    const a = dataKey(env);
    const b = dataKey(env);
    const svc = await withRing({ epoch: 1, keys: [a.row], wraps: a.wraps });
    const next: KeyringSnapshot = { epoch: 2, keys: [{ ...a.row, state: "DECRYPT_ONLY" }, b.row], wraps: [...a.wraps, ...b.wraps] };
    const realRandom = _sodium.randombytes_buf.bind(_sodium) as (n: number) => Uint8Array;
    const spy = jest.spyOn(_sodium as unknown as { randombytes_buf: (n: number) => Uint8Array }, "randombytes_buf").mockImplementationOnce((n: number) => {
      svc.applyRing(next); // swap while encrypt is between "pick the key" and "seal"
      return realRandom(n);
    });
    const ct = svc.encrypt("x");
    spy.mockRestore();
    expect(svc.keyIdOf(ct)).toBe(a.id);
    expect(svc.decrypt(ct)).toBe("x"); // a is still loaded (decrypt-only), so the value is readable
    expect(svc.currentKeyId).toBe(b.id);
  });

  it("memzero only touches buffers of ring keys that left the ring; shared buffers survive", async () => {
    const env = await envOnly();
    const a = dataKey(env, "ACTIVE", new Date("2026-11-18T00:00:00Z"));
    const b = dataKey(env, "DECRYPT_ONLY", new Date("2026-11-10T00:00:00Z"));
    const svc = await withRing({ epoch: 1, keys: [a.row, b.row], wraps: [...a.wraps, ...b.wraps] });
    const ctA = svc.encrypt("A");
    const spy = jest.spyOn(_sodium, "memzero");
    svc.applyRing({ epoch: 2, keys: [a.row, { ...b.row, state: "RETIRED" }], wraps: [...a.wraps, ...b.wraps] });
    expect(spy).toHaveBeenCalledTimes(1);
    const zeroed = spy.mock.calls[0][0] as Uint8Array;
    expect(zeroed.every((x) => x === 0)).toBe(true);
    expect(svc.describeKeys().map((x) => x.id)).not.toContain(b.id);
    expect(svc.decrypt(ctA)).toBe("A"); // the shared (kept) key buffer was not wiped
    // no-op re-apply: nothing leaves, nothing zeroed
    spy.mockClear();
    svc.applyRing({ epoch: 3, keys: [a.row], wraps: a.wraps });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // env keys are never zeroed even when the ring drops all data keys
    const spy2 = jest.spyOn(_sodium, "memzero");
    svc.applyRing(empty);
    expect(spy2).toHaveBeenCalledTimes(1); // only the data key a
    spy2.mockRestore();
    expect(svc.decrypt(svc.encrypt("env-still-ok"))).toBe("env-still-ok");
  });

  it("boot through a PREVIOUS root: the data key unwraps, and wrapsToAdd carries the wrap under the CURRENT root", async () => {
    const oldRoot = await envOnly(ROOT);
    const k = dataKey(oldRoot); // wrapped only under the old root
    const rotated = await withRing({ epoch: 5, keys: [k.row], wraps: k.wraps }, ROOT2, ROOT);
    expect(rotated.ringDegraded).toBeNull();
    expect(rotated.currentKeyId).toBe(k.id);
    const { wrapsToAdd } = rotated.applyRing({ epoch: 5, keys: [k.row], wraps: k.wraps });
    expect(wrapsToAdd).toHaveLength(1);
    expect(wrapsToAdd[0]).toMatchObject({ keyId: k.id, rootKeyId: rotated.envCurrentKeyId });
    // after the persist, the NEW root alone can unwrap it (the old root is no longer needed)
    const newRootOnly = await envOnly(ROOT2);
    expect(newRootOnly.canUnwrap([wrapsToAdd[0]], k.id)).toBe(true);
    // and once the wrap exists there is nothing left to add
    expect(rotated.applyRing({ epoch: 5, keys: [k.row], wraps: [...k.wraps, wrapsToAdd[0]] }).wrapsToAdd).toEqual([]);
  });

  it("the unknown-key hook fires (best effort, a throwing hook never breaks decrypt) for a versioned id not in the ring", async () => {
    const env = await envOnly();
    const k = dataKey(env);
    const writer = await withRing({ epoch: 1, keys: [k.row], wraps: k.wraps });
    const ct = writer.encrypt("z");
    const hook = jest.fn(() => {
      throw new Error("boom");
    });
    env.onUnknownKey = hook;
    expect(() => env.decrypt(ct)).toThrow(SecretsKeyUnavailableError);
    expect(hook).toHaveBeenCalledTimes(1);
    env.decrypt(env.encrypt("known")); // a known id does not fire it
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("no getter returns key material", async () => {
    const env = await envOnly();
    const k = dataKey(env);
    const svc = await withRing({ epoch: 1, keys: [k.row], wraps: k.wraps });
    const exposed = JSON.stringify([svc.currentKeyId, svc.previousKeyIds, svc.envCurrentKeyId, svc.describeKeys(), svc.ringEpoch, svc.ringDegraded]);
    expect(exposed).not.toContain(ROOT);
    for (const x of svc.describeKeys()) expect(Object.keys(x).sort()).toEqual(["id", "source"]);
  });
});
