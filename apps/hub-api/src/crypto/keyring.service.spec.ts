import { ConfigService } from "@nestjs/config";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { CryptoService } from "./crypto.service";
import { KeyRingService, RETIRE_GRACE_MS } from "./keyring.service";
import { PrismaKeyringStore, type KeyringSnapshot, type KeyringStore } from "./keyring.store";
import type { SecretsRotationService } from "./secrets-rotation.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";

const ROOT = "root-passphrase-0123456789";
const ROOT_OLD = "old-root-passphrase-5555555555";

type Row = { id: string; state: "ACTIVE" | "DECRYPT_ONLY" | "RETIRED"; createdBy: string | null; createdAt: Date; activatedAt: Date; demotedAt: Date | null; retiredAt: Date | null };
type Wrap = { keyId: string; rootKeyId: string; wrapped: string };
interface State {
  epoch: number;
  keys: Map<string, Row>;
  wraps: Wrap[];
}

/** In-memory Prisma for the keyring tables. `$transaction` serialises callers (the row-lock analogue) and rolls the
 *  state back when the callback throws, like a real transaction. */
function fakeDb(state: State) {
  let lock: Promise<void> = Promise.resolve();
  const clone = (): State => ({ epoch: state.epoch, keys: new Map([...state.keys].map(([k, v]) => [k, { ...v }])), wraps: state.wraps.map((w) => ({ ...w })) });
  const restore = (s: State) => {
    state.epoch = s.epoch;
    state.keys = s.keys;
    state.wraps = s.wraps;
  };
  const matches = (r: Row, where: Partial<Row>) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);
  const delegates = {
    secretsKeyring: {
      upsert: jest.fn(async () => {
        state.epoch += 1;
        return { epoch: state.epoch };
      }),
      findUnique: jest.fn(async () => ({ epoch: state.epoch })),
    },
    secretsKey: {
      findFirst: jest.fn(async ({ where }: { where: Partial<Row> }) => [...state.keys.values()].find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async () => [...state.keys.values()].sort((a, b) => b.activatedAt.getTime() - a.activatedAt.getTime()).map((r) => ({ ...r }))),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = state.keys.get(where.id);
        return r ? { ...r, wraps: state.wraps.filter((w) => w.keyId === r.id).map((w) => ({ rootKeyId: w.rootKeyId, wrapped: w.wrapped })) } : null;
      }),
      create: jest.fn(async ({ data }: { data: Partial<Row> & { id: string } }) => {
        const now = new Date();
        const row: Row = { state: "ACTIVE", createdBy: null, createdAt: now, activatedAt: now, demotedAt: null, retiredAt: null, ...data };
        state.keys.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        Object.assign(state.keys.get(where.id)!, data);
        return state.keys.get(where.id);
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        const hit = [...state.keys.values()].filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    secretsKeyWrap: {
      createMany: jest.fn(async ({ data }: { data: Wrap[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const w of data) {
          if (state.wraps.some((x) => x.keyId === w.keyId && x.rootKeyId === w.rootKeyId)) continue;
          state.wraps.push({ ...w });
          count++;
        }
        return { count };
      }),
    },
  };
  const prisma = {
    ...delegates,
    $transaction: jest.fn(async (fn: (tx: typeof delegates) => Promise<unknown>) => {
      const prev = lock;
      let release!: () => void;
      lock = new Promise<void>((r) => (release = r));
      await prev;
      const before = clone();
      try {
        return await fn(delegates);
      } catch (e) {
        restore(before);
        throw e;
      } finally {
        release();
      }
    }),
  };
  const store: KeyringStore = {
    readEpoch: jest.fn(async () => state.epoch),
    load: jest.fn(async (): Promise<KeyringSnapshot> => ({
      epoch: state.epoch,
      keys: [...state.keys.values()].map((r) => ({ id: r.id, state: r.state, activatedAt: r.activatedAt, demotedAt: r.demotedAt })),
      wraps: state.wraps.map((w) => ({ ...w })),
    })),
  };
  return { prisma, store, delegates };
}

async function setup(opts: { current?: string; previous?: string; state?: State; running?: boolean; byKey?: Record<string, number> } = {}) {
  const state: State = opts.state ?? { epoch: 0, keys: new Map(), wraps: [] };
  const db = fakeDb(state);
  const config = { get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? (opts.current ?? ROOT) : k === "SECRETS_ENCRYPTION_KEY_PREVIOUS" ? opts.previous : undefined) } as unknown as ConfigService;
  const crypto = new CryptoService(config, db.store);
  await crypto.onModuleInit();
  const rotation = {
    isRunning: jest.fn(() => opts.running ?? false),
    start: jest.fn(),
    status: jest.fn(async () => ({ currentKeyId: crypto.currentKeyId, previousKeyIds: crypto.previousKeyIds, byKey: opts.byKey ?? {}, models: [], totals: { current: 0, stale: 0, unreadable: 0 }, hmacRowsOnOldKeys: [], previousKeyRemovable: true, running: false, lastRun: null })),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new KeyRingService(crypto, db.store, db.prisma as unknown as PrismaService, rotation as unknown as SecretsRotationService, audit as unknown as AuditService);
  return { svc, crypto, state, db, rotation, audit };
}

async function expectConflict(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictException);
  expect((err as ConflictException).getResponse()).toMatchObject({ code });
}

const demote = (state: State, id: string, msAgo: number) => {
  state.keys.get(id)!.demotedAt = new Date(Date.now() - msAgo);
};

describe("KeyRingService.rotate", () => {
  it("happy path: one ACTIVE key, epoch+1, one wrap per env root, the old ACTIVE demoted, audit meta ids only, no restart needed", async () => {
    const { svc, crypto, state, audit, rotation } = await setup({ previous: ROOT_OLD });
    const envId = crypto.envCurrentKeyId;
    const before = crypto.encrypt("before");
    const r1 = await svc.rotate("owner1", { expectedCurrentKeyId: envId, target: "new-key", reencrypt: true });
    expect(r1).toEqual({ keyId: crypto.currentKeyId, epoch: 1, reencryptStarted: true });
    expect(crypto.currentKeyId).not.toBe(envId);
    expect(state.epoch).toBe(1);
    const active = [...state.keys.values()].filter((k) => k.state === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(crypto.currentKeyId);
    expect(active[0].createdBy).toBe("owner1");
    const wraps = state.wraps.filter((w) => w.keyId === active[0].id);
    expect(wraps.map((w) => w.rootKeyId).sort()).toEqual([crypto.envCurrentKeyId, ...crypto.describeKeys().filter((k) => k.source === "env" && k.id !== crypto.envCurrentKeyId).map((k) => k.id)].sort());
    expect(rotation.start).toHaveBeenCalledWith("owner1");
    // old rows still read, new writes carry the new id (no restart)
    expect(crypto.decrypt(before)).toBe("before");
    expect(crypto.keyIdOf(crypto.encrypt("after"))).toBe(active[0].id);
    expect(audit.log).toHaveBeenCalledWith({ actor: "owner1", action: "instance.secrets_key.rotate", target: "singleton", meta: { newKeyId: active[0].id, previousKeyId: envId, target: "new-key", reencrypt: true } });
    // second rotation demotes the first data key
    const first = active[0].id;
    const r2 = await svc.rotate("owner1", { expectedCurrentKeyId: first, target: "new-key", reencrypt: false });
    expect(r2.epoch).toBe(2);
    expect(r2.reencryptStarted).toBe(false);
    expect(state.keys.get(first)!.state).toBe("DECRYPT_ONLY");
    expect(state.keys.get(first)!.demotedAt).toBeInstanceOf(Date);
    expect([...state.keys.values()].filter((k) => k.state === "ACTIVE")).toHaveLength(1);
    expect(crypto.decrypt(before)).toBe("before");
  });

  it("a restart reloads the same ring: a FRESH CryptoService on the same store reads old and new secrets", async () => {
    const { svc, crypto, state, db } = await setup();
    const old = crypto.encrypt("old");
    await svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const fresh1 = crypto.encrypt("new");
    await svc.rotate("o", { expectedCurrentKeyId: crypto.currentKeyId, target: "new-key", reencrypt: false });
    const fresh2 = crypto.encrypt("newer");
    const restarted = new CryptoService({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? ROOT : undefined) } as unknown as ConfigService, db.store);
    await restarted.onModuleInit();
    expect(restarted.currentKeyId).toBe(crypto.currentKeyId);
    expect(restarted.ringEpoch).toBe(state.epoch);
    for (const [ct, pt] of [[old, "old"], [fresh1, "new"], [fresh2, "newer"]] as const) expect(restarted.decrypt(ct)).toBe(pt);
  });

  it("expectedCurrentKeyId mismatch is 409 stale_current and changes nothing (the epoch bump rolls back)", async () => {
    const { svc, crypto, state } = await setup();
    await expectConflict(svc.rotate("o", { expectedCurrentKeyId: "0000000000000000", target: "new-key", reencrypt: true }), "stale_current");
    expect(state.epoch).toBe(0);
    expect(state.keys.size).toBe(0);
    expect(crypto.currentKeyId).toBe(crypto.envCurrentKeyId);
  });

  it("is refused while a re-encrypt is running and while the ring is degraded", async () => {
    const running = await setup({ running: true });
    await expectConflict(running.svc.rotate("o", { expectedCurrentKeyId: running.crypto.envCurrentKeyId, target: "new-key", reencrypt: true }), "rotation_running");
    expect(running.state.keys.size).toBe(0);

    // a data key wrapped under a root this hub does not have => degraded
    const other = await setup({ current: "foreign-root-0000000000" });
    await other.svc.rotate("o", { expectedCurrentKeyId: other.crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const degraded = await setup({ state: other.state });
    expect(degraded.crypto.ringDegraded).toContain("cannot be unwrapped");
    await expectConflict(degraded.svc.rotate("o", { expectedCurrentKeyId: degraded.crypto.envCurrentKeyId, target: "new-key", reencrypt: true }), "ring_degraded");
  });

  it("two concurrent rotates from the same page: exactly one wins, the other is stale_current", async () => {
    const { svc, crypto, state } = await setup();
    const expected = crypto.envCurrentKeyId;
    const results = await Promise.allSettled([
      svc.rotate("a", { expectedCurrentKeyId: expected, target: "new-key", reencrypt: false }),
      svc.rotate("b", { expectedCurrentKeyId: expected, target: "new-key", reencrypt: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictException);
    expect((lost.reason as ConflictException).getResponse()).toMatchObject({ code: "stale_current" });
    expect(state.keys.size).toBe(1);
    expect([...state.keys.values()].filter((k) => k.state === "ACTIVE")).toHaveLength(1);
  });

  it("env-root target demotes the active data key without creating one; 409 already_env_root when none is active", async () => {
    const { svc, crypto, state } = await setup();
    await expectConflict(svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "env-root", reencrypt: false }), "already_env_root");
    await svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const dk = crypto.currentKeyId;
    const out = await svc.rotate("o", { expectedCurrentKeyId: dk, target: "env-root", reencrypt: true });
    expect(state.keys.size).toBe(1); // nothing created
    expect(state.keys.get(dk)!.state).toBe("DECRYPT_ONLY");
    expect(crypto.currentKeyId).toBe(crypto.envCurrentKeyId); // the .env key encrypts again
    expect(out.keyId).toBe(crypto.envCurrentKeyId);
    expect(crypto.describeKeys().map((k) => k.id)).toContain(dk); // still readable
    // a stale page (still showing the data key as current) is a stale_current; a fresh one says already_env_root
    await expectConflict(svc.rotate("o", { expectedCurrentKeyId: dk, target: "env-root", reencrypt: false }), "stale_current");
    await expectConflict(svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "env-root", reencrypt: false }), "already_env_root");
  });

  it("starting the re-encrypt swallows a Conflict (a run is already going) but not other errors", async () => {
    const a = await setup();
    a.rotation.start.mockImplementation(() => {
      throw new ConflictException("running");
    });
    const out = await a.svc.rotate("o", { expectedCurrentKeyId: a.crypto.envCurrentKeyId, target: "new-key", reencrypt: true });
    expect(out.reencryptStarted).toBe(false);
  });

  it("a failing audit never turns a completed rotate into an error", async () => {
    const { svc, crypto, audit } = await setup();
    audit.log.mockRejectedValue(new Error("audit down"));
    await expect(svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "new-key", reencrypt: false })).resolves.toMatchObject({ epoch: 1 });
  });

  it("audit, response and logs never contain key bytes, wraps or the passphrase; the transient key copy is zeroed", async () => {
    const { svc, crypto, state, audit } = await setup();
    let dkB64 = "";
    let dkRef: Uint8Array | null = null;
    const real = crypto.generateDataKey.bind(crypto);
    jest.spyOn(crypto, "generateDataKey").mockImplementation(() => {
      const k = real();
      dkRef = k.key;
      dkB64 = Buffer.from(k.key).toString("base64");
      return k;
    });
    const out = await svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "new-key", reencrypt: true });
    const seen = JSON.stringify([out, audit.log.mock.calls, await svc.statusView()]);
    expect(dkB64.length).toBeGreaterThan(20);
    expect(seen).not.toContain(dkB64);
    expect(seen).not.toContain(Buffer.from(dkRef!).toString("base64"));
    expect(seen).not.toContain(ROOT);
    for (const w of state.wraps) expect(seen).not.toContain(w.wrapped);
    expect(dkRef!.every((b) => b === 0)).toBe(true); // zeroed after the wraps were made
    expect(Object.keys(audit.log.mock.calls[0][0].meta).sort()).toEqual(["newKeyId", "previousKeyId", "reencrypt", "target"]);
  });
});

describe("KeyRingService.retire / restore", () => {
  /** Two data keys: `old` DECRYPT_ONLY (demoted long ago), `active` ACTIVE. */
  async function twoKeys(opts: { byKey?: Record<string, number>; running?: boolean } = {}) {
    const s = await setup({ byKey: opts.byKey });
    await s.svc.rotate("o", { expectedCurrentKeyId: s.crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const old = s.crypto.currentKeyId;
    await s.svc.rotate("o", { expectedCurrentKeyId: old, target: "new-key", reencrypt: false });
    demote(s.state, old, RETIRE_GRACE_MS + 5_000);
    return { ...s, old, active: s.crypto.currentKeyId };
  }

  it("retires a decrypt-only key that nothing references (after the grace), unloads it, audits ids only", async () => {
    const { svc, crypto, state, audit, old } = await twoKeys();
    const ct = (() => {
      return crypto.describeKeys().some((k) => k.id === old);
    })();
    expect(ct).toBe(true);
    const out = await svc.retire("o", old);
    expect(out).toEqual({ keyId: old, state: "RETIRED" });
    expect(state.keys.get(old)!.state).toBe("RETIRED");
    expect(state.keys.get(old)!.retiredAt).toBeInstanceOf(Date);
    expect(crypto.describeKeys().map((k) => k.id)).not.toContain(old);
    expect(audit.log).toHaveBeenLastCalledWith({ actor: "o", action: "instance.secrets_key.retire", target: "singleton", meta: { keyId: old } });
    expect(state.wraps.some((w) => w.keyId === old)).toBe(true); // reversible: the wraps stay
  });

  it("retire gating: unknown/env key 404, active key / retired key not_decrypt_only, referenced, grace, running, degraded", async () => {
    const k = await twoKeys({ byKey: {} });
    const notFound = (id: string) => k.svc.retire("o", id).then(() => null, (e) => e);
    expect(await notFound(k.crypto.envCurrentKeyId)).toBeInstanceOf(NotFoundException);
    expect(((await notFound("1111111111111111")) as NotFoundException).getResponse()).toMatchObject({ code: "unknown_key" });
    await expectConflict(k.svc.retire("o", k.active), "not_decrypt_only");

    const ref = await twoKeys({ byKey: {} });
    ref.rotation.status.mockResolvedValue({ byKey: { [ref.old]: 3 } } as never);
    await expectConflict(ref.svc.retire("o", ref.old), "referenced");

    const grace = await twoKeys();
    demote(grace.state, grace.old, 1_000);
    await expectConflict(grace.svc.retire("o", grace.old), "grace");

    const run = await twoKeys();
    run.rotation.isRunning.mockReturnValue(true);
    await expectConflict(run.svc.retire("o", run.old), "rotation_running");

    const deg = await twoKeys();
    const degraded = await setup({ state: deg.state, current: "not-the-root-0000000000" });
    expect(degraded.crypto.ringDegraded).not.toBeNull();
    await expectConflict(degraded.svc.retire("o", deg.old), "ring_degraded");

    // an already retired key is not decrypt-only either
    const done = await twoKeys();
    await done.svc.retire("o", done.old);
    await expectConflict(done.svc.retire("o", done.old), "not_decrypt_only");
  });

  it("a lost CAS (updateMany count 0) is a 409 and the epoch bump rolls back", async () => {
    const { svc, state, db, old } = await twoKeys();
    const epoch = state.epoch;
    db.delegates.secretsKey.updateMany.mockResolvedValueOnce({ count: 0 });
    await expectConflict(svc.retire("o", old), "not_decrypt_only");
    expect(state.epoch).toBe(epoch);
    expect(state.keys.get(old)!.state).toBe("DECRYPT_ONLY");
  });

  it("restore brings a retired key back as decrypt-only (demotedAt unchanged) and reloads it", async () => {
    const { svc, crypto, state, audit, old } = await twoKeys();
    await svc.retire("o", old);
    const demotedAt = state.keys.get(old)!.demotedAt;
    const out = await svc.restore("o", old);
    expect(out).toEqual({ keyId: old, state: "DECRYPT_ONLY" });
    expect(state.keys.get(old)!.demotedAt).toBe(demotedAt);
    expect(crypto.describeKeys().map((k) => k.id)).toContain(old);
    expect(audit.log).toHaveBeenLastCalledWith({ actor: "o", action: "instance.secrets_key.restore", target: "singleton", meta: { keyId: old } });
  });

  it("restore: 404 for an unknown key, 409 not_retired for a live one, 409 no_root when no configured root can unwrap it", async () => {
    const { svc, state, old, active } = await twoKeys();
    const missing = await svc.restore("o", "2222222222222222").then(() => null, (e) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    await expectConflict(svc.restore("o", old), "not_retired");
    await expectConflict(svc.restore("o", active), "not_retired");
    // wraps exist only under a root that is gone => no_root
    await svc.retire("o", old);
    const rootless = await setup({ state, current: ROOT_OLD });
    await expectConflict(rootless.svc.restore("o", old), "no_root");
    expect(state.keys.get(old)!.state).toBe("RETIRED");
  });
});

describe("KeyRingService status view", () => {
  it("fresh install: only the env keys, nothing referenced, downgrade safe, previous fields untouched", async () => {
    const { svc, crypto } = await setup({ previous: ROOT_OLD });
    const v = await svc.statusView();
    expect(v.currentKeyId).toBe(crypto.currentKeyId);
    expect(v.previousKeyIds).toEqual(crypto.previousKeyIds);
    expect(v.epoch).toBe(0);
    expect(v.degraded).toBeNull();
    expect(v.downgradeSafe).toBe(true);
    expect(v.keys.map((k) => [k.source, k.role])).toEqual([["env", "active"], ["env", "decrypt-only"]]);
    expect(v.keys.every((k) => !k.retirable && k.retireBlockedReason === null)).toBe(true);
  });

  it("after a rotation: the ring key is active, the env key is the root, retire reasons are reported, downgradeSafe follows references", async () => {
    const { svc, crypto, state, rotation } = await setup({ byKey: {} });
    await svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const first = crypto.currentKeyId;
    await svc.rotate("o", { expectedCurrentKeyId: first, target: "new-key", reencrypt: false });
    const second = crypto.currentKeyId;
    let v = await svc.statusView();
    expect(v.keys.find((k) => k.id === second)).toMatchObject({ source: "ring", role: "active", retirable: false });
    expect(v.keys.find((k) => k.id === crypto.envCurrentKeyId)).toMatchObject({ source: "env", role: "root" });
    expect(v.keys.find((k) => k.id === first)).toMatchObject({ role: "decrypt-only", retirable: false, retireBlockedReason: "grace" });
    demote(state, first, RETIRE_GRACE_MS + 1);
    v = await svc.statusView();
    expect(v.keys.find((k) => k.id === first)).toMatchObject({ retirable: true, retireBlockedReason: null });
    expect(v.downgradeSafe).toBe(true);
    rotation.status.mockResolvedValue({ byKey: { [first]: 2, [second]: 1 } } as never);
    v = await svc.statusView();
    expect(v.keys.find((k) => k.id === first)).toMatchObject({ referenced: 2, retirable: false, retireBlockedReason: "referenced" });
    expect(v.downgradeSafe).toBe(false);
    rotation.isRunning.mockReturnValue(true);
    expect((await svc.statusView()).keys.find((k) => k.id === first)!.retireBlockedReason).toBe("running");
    // a retired key is listed last with role retired
    rotation.isRunning.mockReturnValue(false);
    rotation.status.mockResolvedValue({ byKey: {} } as never);
    await svc.retire("o", first);
    const last = (await svc.statusView()).keys.at(-1)!;
    expect(last).toMatchObject({ id: first, role: "retired", retirable: false });
    expect(last.retiredAt).toBeInstanceOf(Date);
  });

  it("back on the .env key (all data keys decrypt-only) the env current key is the active one again", async () => {
    const { svc, crypto } = await setup();
    await svc.rotate("o", { expectedCurrentKeyId: crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    await svc.rotate("o", { expectedCurrentKeyId: crypto.currentKeyId, target: "env-root", reencrypt: false });
    const v = await svc.statusView();
    expect(v.keys.find((k) => k.id === crypto.envCurrentKeyId)).toMatchObject({ role: "active" });
    expect(v.currentKeyId).toBe(crypto.envCurrentKeyId);
  });

  it("a degraded ring is reported and blocks every retire", async () => {
    const other = await setup({ current: "foreign-root-0000000000" });
    await other.svc.rotate("o", { expectedCurrentKeyId: other.crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    await other.svc.rotate("o", { expectedCurrentKeyId: other.crypto.currentKeyId, target: "new-key", reencrypt: false });
    const first = [...other.state.keys.values()].find((k) => k.state === "DECRYPT_ONLY")!.id;
    demote(other.state, first, RETIRE_GRACE_MS + 1);
    const degraded = await setup({ state: other.state });
    const v = await degraded.svc.statusView();
    expect(v.degraded).toContain("cannot be unwrapped");
    expect(v.keys.find((k) => k.id === first)).toMatchObject({ retirable: false, retireBlockedReason: "degraded" });
  });
});

describe("KeyRingService refresh / poll / unknown key / boot", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Another process rotates: a data key appears in the store with a higher epoch. */
  async function foreignRotate(state: State) {
    const w = await setup({ state: { epoch: 0, keys: new Map(), wraps: [] } });
    const dk = w.crypto.generateDataKey();
    const now = new Date();
    state.keys.set(dk.id, { id: dk.id, state: "ACTIVE", createdBy: "other", createdAt: now, activatedAt: now, demotedAt: null, retiredAt: null });
    for (const x of w.crypto.wrapForRoots(dk.key)) state.wraps.push({ keyId: dk.id, ...x });
    state.epoch += 1;
    return dk.id;
  }

  it("the epoch poll refreshes the ring when another process changed it, and does nothing when the epoch matches", async () => {
    const { svc, crypto, state, db } = await setup();
    (db.store.load as jest.Mock).mockClear();
    await svc.pollEpoch();
    expect(db.store.load).not.toHaveBeenCalled(); // same epoch: readEpoch only
    const id = await foreignRotate(state);
    await svc.pollEpoch();
    expect(crypto.currentKeyId).toBe(id);
    expect(crypto.ringEpoch).toBe(1);
  });

  it("onApplicationBootstrap polls every 15 s on an unref'd timer and onModuleDestroy clears it; poll errors are swallowed", async () => {
    jest.useFakeTimers();
    const { svc, crypto, state, db } = await setup();
    await svc.onApplicationBootstrap();
    const id = await foreignRotate(state);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(crypto.currentKeyId).toBe(id);
    (db.store.readEpoch as jest.Mock).mockRejectedValueOnce(new Error("db blip"));
    await jest.advanceTimersByTimeAsync(15_000); // does not throw
    svc.onModuleDestroy();
    (db.store.readEpoch as jest.Mock).mockClear();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.store.readEpoch).not.toHaveBeenCalled();
  });

  it("the unknown-key hook refreshes, debounced to once per 2 s", async () => {
    const { svc, crypto, state, db } = await setup();
    expect(crypto.onUnknownKey).toBeDefined();
    const id = await foreignRotate(state);
    (db.store.load as jest.Mock).mockClear();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 5; i++) crypto.onUnknownKey!();
    await svc.refresh(); // drain the chain
    expect((db.store.load as jest.Mock).mock.calls.length).toBe(2); // one from the hook burst + this explicit refresh
    expect(crypto.currentKeyId).toBe(id);
    (db.store.load as jest.Mock).mockClear();
    now += 2_500;
    crypto.onUnknownKey!();
    await svc.refresh();
    expect((db.store.load as jest.Mock).mock.calls.length).toBe(2); // past the window: the hook fires again
    void svc;
  });

  it("boot persists the missing wrap under the CURRENT root (manual .env passphrase rotation completes without re-encrypting)", async () => {
    const before = await setup({ current: ROOT_OLD });
    await before.svc.rotate("o", { expectedCurrentKeyId: before.crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const dk = before.crypto.currentKeyId;
    const secret = before.crypto.encrypt("kept");
    expect(before.state.wraps.map((w) => w.rootKeyId)).toEqual([before.crypto.envCurrentKeyId]);
    // the operator swaps the .env root: new -> current, old -> previous, restart
    const after = await setup({ state: before.state, current: ROOT, previous: ROOT_OLD });
    expect(after.crypto.ringDegraded).toBeNull();
    expect(after.crypto.currentKeyId).toBe(dk);
    expect(after.crypto.decrypt(secret)).toBe("kept");
    await after.svc.onApplicationBootstrap();
    after.svc.onModuleDestroy();
    expect(before.state.wraps.filter((w) => w.keyId === dk).map((w) => w.rootKeyId).sort()).toEqual([after.crypto.envCurrentKeyId, ...after.crypto.describeKeys().filter((k) => k.source === "env" && k.id !== after.crypto.envCurrentKeyId).map((k) => k.id)].sort());
    // the new root alone now opens it: the old passphrase can be dropped from .env
    const newRootOnly = await setup({ state: before.state, current: ROOT });
    expect(newRootOnly.crypto.ringDegraded).toBeNull();
    expect(newRootOnly.crypto.decrypt(secret)).toBe("kept");
  });

  it("a failed wrap write is logged (ids only) and never blocks the ring", async () => {
    const before = await setup({ current: ROOT_OLD });
    await before.svc.rotate("o", { expectedCurrentKeyId: before.crypto.envCurrentKeyId, target: "new-key", reencrypt: false });
    const after = await setup({ state: before.state, current: ROOT, previous: ROOT_OLD });
    after.db.delegates.secretsKeyWrap.createMany.mockRejectedValueOnce(new Error("readonly"));
    await expect(after.svc.refresh(true)).resolves.toBeUndefined();
    expect(after.crypto.ringDegraded).toBeNull();
  });
});

describe("PrismaKeyringStore", () => {
  function fakePrisma(epochs: number[]) {
    let call = 0;
    return {
      secretsKeyring: { findUnique: jest.fn(async () => ({ epoch: epochs[Math.min(call++, epochs.length - 1)] })) },
      secretsKey: { findMany: jest.fn(async () => [{ id: "aaaaaaaaaaaaaaaa", state: "ACTIVE", activatedAt: new Date(), demotedAt: null }]) },
      secretsKeyWrap: { findMany: jest.fn(async () => [{ keyId: "aaaaaaaaaaaaaaaa", rootKeyId: "bbbbbbbbbbbbbbbb", wrapped: "tk1.bbbbbbbbbbbbbbbb.AAAA" }]) },
    };
  }

  it("a consistent read returns the epoch, keys and wraps", async () => {
    const p = fakePrisma([4, 4]);
    const snap = await new PrismaKeyringStore(p as unknown as PrismaService).load();
    expect(snap.epoch).toBe(4);
    expect(snap.keys).toHaveLength(1);
    expect(snap.wraps).toHaveLength(1);
    expect(p.secretsKeyring.findUnique).toHaveBeenCalledTimes(2);
  });

  it("a torn read (epoch changed mid-read) is retried, then succeeds", async () => {
    const p = fakePrisma([1, 2, 2, 2]);
    const snap = await new PrismaKeyringStore(p as unknown as PrismaService).load();
    expect(snap.epoch).toBe(2);
    expect(p.secretsKey.findMany).toHaveBeenCalledTimes(2);
  });

  it("a read that stays torn for 3 attempts throws", async () => {
    const p = fakePrisma([1, 2, 3, 4, 5, 6]);
    await expect(new PrismaKeyringStore(p as unknown as PrismaService).load()).rejects.toThrow(/torn/);
    expect(p.secretsKey.findMany).toHaveBeenCalledTimes(3);
  });

  it("a missing singleton row reads as epoch 0", async () => {
    const p = { secretsKeyring: { findUnique: jest.fn(async () => null) } };
    expect(await new PrismaKeyringStore(p as unknown as PrismaService).readEpoch()).toBe(0);
  });
});
