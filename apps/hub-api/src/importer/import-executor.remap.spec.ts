import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImportExecutorService } from "./import-executor.service";

const UUID = "3f1a9c0b2d4e6f8a1b3c5d7e";
const APPUUID = "aabbccddeeff00112233aabb";

type View = Record<string, unknown>;

function harness(opts: {
  op?: Record<string, unknown>;
  env?: Record<string, string>;
  apps?: Array<{ id: string; itemRef: string; name?: string; env: Record<string, string> }>;
  dbView?: View;
  dbGetError?: boolean;
  permissionThrows?: boolean;
  setEnvFailIds?: string[]; // appIds whose setEnv rejects (to exercise partial-write / undo-retry paths)
} = {}) {
  const appList = opts.apps ?? [{ id: "app-1", itemRef: `app:_:${APPUUID}`, name: "web", env: opts.env ?? { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` } }];
  const op = {
    id: "op-1",
    kind: "import",
    actorId: "user-1",
    meta: { sourceKind: "coolify", serverId: "srv-1" },
    cancelRequestedAt: null,
    migrationTokenHash: null,
    migrationTokenExpiresAt: null,
    tasks: [
      { status: "DONE", resourceType: "database", resourceId: "db-1", itemRef: `database:_:${UUID}` },
      ...appList.map((a) => ({ status: "DONE", resourceType: "application", resourceId: a.id, itemRef: a.itemRef, result: { name: a.name ?? a.id } })),
    ],
    ...opts.op,
  };
  const dbView: View = {
    id: "db-1",
    name: "appdb",
    engine: "POSTGRES",
    status: "NEW",
    port: 5432,
    internalHost: "tugra_db_1",
    username: "tugra",
    password: "NEWpw",
    database: "appdb",
    canWrite: true,
    ...opts.dbView,
  };
  const envById = new Map(appList.map((a) => [a.id, a.env]));
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    bulkOperation: {
      findUnique: jest.fn().mockResolvedValue(op),
      update: jest.fn().mockImplementation(({ data }: { data: { meta: Record<string, unknown> } }) => {
        (op as { meta: unknown }).meta = data.meta;
        return Promise.resolve(op);
      }),
      // compare-and-set: apply only if where.meta.equals still matches the current op.meta (jsonb value
      // equality), mutating the shared `op` ref so a later read (undo after apply) sees the persisted record.
      updateMany: jest.fn().mockImplementation(({ where, data }: { where: { meta?: { equals?: unknown } }; data: { meta: Record<string, unknown> } }) => {
        const expected = where?.meta?.equals;
        if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(op.meta)) return Promise.resolve({ count: 0 });
        (op as { meta: unknown }).meta = data.meta;
        return Promise.resolve({ count: 1 });
      }),
    },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-1", teamId: "team-1" }) },
  };
  const access = {
    requirePermission: opts.permissionThrows
      ? jest.fn().mockRejectedValue(new ForbiddenException("denied"))
      : jest.fn().mockResolvedValue(undefined),
  };
  const apps = {
    getEnv: jest.fn().mockImplementation((_u: string, id: string) => Promise.resolve({ ...(envById.get(id) ?? {}) })),
    // write-through so an undo reads back exactly what the apply wrote (the real app store round-trips).
    setEnv: jest.fn().mockImplementation((_u: string, id: string, env: Record<string, string>) => {
      if (opts.setEnvFailIds?.includes(id)) return Promise.reject(new Error("write failed"));
      envById.set(id, { ...env });
      return Promise.resolve(undefined);
    }),
  };
  const dbs = { get: opts.dbGetError ? jest.fn().mockRejectedValue(new Error("deleted")) : jest.fn().mockResolvedValue(dbView) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  // an OPAQUE, reversible round-trip: the stored form hides the plaintext (base64) yet undo recovers it
  // exactly — faithful enough to prove the prior env is stored as ciphertext, not plaintext, in op.meta.
  const crypto = {
    encrypt: jest.fn((s: string) => `enc:${Buffer.from(s, "utf8").toString("base64")}`),
    decrypt: jest.fn((s: string) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString("utf8")),
  };
  const svc = new ImportExecutorService(
    prisma as never,
    {} as never,
    access as never,
    audit as never,
    {} as never,
    apps as never,
    dbs as never,
    {} as never,
    crypto as never,
  );
  return { svc, prisma, access, apps, dbs, audit, crypto, envById };
}

describe("ImportExecutorService.remapEnvPlan", () => {
  it("rotate: a fresh-cred Tugra DB → the app's DATABASE_URL is rewritten, secrets masked, planHash present", async () => {
    const { svc } = harness();
    const plan = await svc.remapEnvPlan("user-1", "op-1");
    expect(plan.databases[0]).toMatchObject({ engine: "POSTGRES", mode: "rotate" });
    const change = plan.apps[0].changes.find((c) => c.key === "DATABASE_URL");
    expect(change?.rule).toBe("url");
    expect(change?.newMasked).toBe("postgres://tugra:***@tugra_db_1:5432/appdb");
    expect(change?.oldMasked).toBe(`postgres://appuser:***@${UUID}:5432/appdb`);
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    // NEVER leak a raw password
    expect(JSON.stringify(plan)).not.toContain("S3cr3t");
    expect(JSON.stringify(plan)).not.toContain("NEWpw");
  });

  it("preserve: when the Tugra DB already carries the app's old creds, only the host is swapped", async () => {
    const { svc } = harness({ dbView: { username: "appuser", password: "S3cr3t", database: "appdb" } });
    const plan = await svc.remapEnvPlan("user-1", "op-1");
    expect(plan.databases[0].mode).toBe("preserve");
    const change = plan.apps[0].changes.find((c) => c.key === "DATABASE_URL");
    expect(change?.newMasked).toBe("postgres://appuser:***@tugra_db_1:5432/appdb");
    expect(JSON.stringify(plan)).not.toContain("S3cr3t");
  });

  it("reports a split *_PASSWORD it cannot confirm as needsManual (no half-rewrite)", async () => {
    const { svc } = harness({ env: { DB_HOST: UUID, DB_USER: "appuser", DB_PASSWORD: "S3cr3t" }, dbView: {} });
    const plan = await svc.remapEnvPlan("user-1", "op-1");
    const app = plan.apps[0];
    expect(app.changes.find((c) => c.key === "DB_HOST")?.newMasked).toBe("tugra_db_1");
    expect(app.needsManual).toContainEqual(expect.objectContaining({ key: "DB_PASSWORD" }));
  });

  it("the preview strips the raw newValue — a password carried in a URL QUERY never reaches the plan", async () => {
    // preserve keeps the app's own query creds in the RAW value; the preview must surface only the masked form.
    const { svc } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb?password=QueryPw` }, dbView: { username: "appuser", password: "S3cr3t", database: "appdb" } });
    const plan = await svc.remapEnvPlan("user-1", "op-1");
    expect(plan.databases[0].mode).toBe("preserve");
    expect(JSON.stringify(plan)).not.toContain("QueryPw");
    expect(JSON.stringify(plan)).not.toContain("newValue");
  });

  it("re-checks apps:config AND databases, and refuses when permission is denied", async () => {
    const { svc, access } = harness({ permissionThrows: true });
    await expect(svc.remapEnvPlan("user-1", "op-1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.requirePermission).toHaveBeenCalled();
  });

  it("refuses a non-Coolify (local-docker adopt) operation", async () => {
    const { svc } = harness({ op: { meta: { sourceKind: "local-docker", serverId: "srv-1" } } });
    await expect(svc.remapEnvPlan("user-1", "op-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("two apps with DIFFERENT creds for the same DB → rotate (never a broken preserve from the first app)", async () => {
    // app-1 alone would preserve (its creds == the Tugra DB); app-2 carries a different role → forces rotate.
    const { svc } = harness({
      dbView: { username: "tugra", password: "NEWpw", database: "appdb" },
      apps: [
        { id: "app-1", itemRef: `app:_:${APPUUID}`, env: { DATABASE_URL: `postgres://tugra:NEWpw@${UUID}:5432/appdb` } },
        { id: "app-2", itemRef: "app:_:bbbb1111cccc2222dddd3333", env: { DATABASE_URL: `postgres://readonly:rpw@${UUID}:5432/appdb` } },
      ],
    });
    const plan = await svc.remapEnvPlan("user-1", "op-1");
    expect(plan.databases[0].mode).toBe("rotate");
  });

  it("a DB that cannot be loaded is SKIPPED (preview does not throw) and its apps show target-unavailable", async () => {
    const { svc } = harness({ dbGetError: true });
    const plan = await svc.remapEnvPlan("user-1", "op-1");
    expect(plan.skipped).toContainEqual(expect.objectContaining({ itemRef: `database:_:${UUID}`, kind: "database", reason: "not-accessible" }));
    expect(plan.apps[0].needsManual).toContainEqual(expect.objectContaining({ key: "DATABASE_URL", reason: "target-unavailable" }));
  });

  it("is read-only: the preview reads env + DB facts but writes nothing (no setEnv, no meta update)", async () => {
    const { svc, apps, dbs, prisma } = harness();
    await svc.remapEnvPlan("user-1", "op-1");
    expect(apps.getEnv).toHaveBeenCalledWith("user-1", "app-1");
    expect(dbs.get).toHaveBeenCalledWith("user-1", "db-1");
    expect(apps.setEnv).not.toHaveBeenCalled();
    expect(prisma.bulkOperation.update).not.toHaveBeenCalled();
    expect(prisma.bulkOperation.updateMany).not.toHaveBeenCalled();
  });
});

describe("ImportExecutorService.remapEnvApply + remapEnvUndo (S4d-3 — the first WRITE, confirm-gated)", () => {
  it("writes the rewritten env (merged, other keys kept), stores an undo snapshot, and returns a secret-free summary", async () => {
    const { svc, apps } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb`, KEEP_ME: "x" } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    const res = await svc.remapEnvApply("user-1", "op-1", planHash);
    expect(res.applied).toBe(true);
    expect(res.apps[0]).toMatchObject({ appId: "app-1", written: 1, keys: ["DATABASE_URL"], needsRedeploy: true });
    // the app store now holds the ROTATED raw url + the untouched companion key
    expect(apps.setEnv).toHaveBeenCalledWith("user-1", "app-1", { DATABASE_URL: "postgres://tugra:NEWpw@tugra_db_1:5432/appdb", KEEP_ME: "x" });
    // response carries counts/keys only — never a raw secret
    expect(JSON.stringify(res)).not.toContain("S3cr3t");
    expect(JSON.stringify(res)).not.toContain("NEWpw");
  });

  it("REFUSES (409) when confirmToken does not equal the fresh planHash — a stale diff is never written", async () => {
    const { svc, apps } = harness();
    await expect(svc.remapEnvApply("user-1", "op-1", "f".repeat(64))).rejects.toBeInstanceOf(ConflictException);
    expect(apps.setEnv).not.toHaveBeenCalled();
  });

  it("apply then undo restores each app's env to the exact pre-remap snapshot", async () => {
    const { svc, apps } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb`, KEEP_ME: "x" } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await svc.remapEnvApply("user-1", "op-1", planHash);
    const undo = await svc.remapEnvUndo("user-1", "op-1");
    expect(undo.undone).toBe(true);
    expect(undo.apps).toContainEqual(expect.objectContaining({ appId: "app-1" }));
    // the LAST setEnv restored the ORIGINAL env verbatim (secret recovered from the encrypted snapshot)
    expect(apps.setEnv).toHaveBeenLastCalledWith("user-1", "app-1", { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb`, KEEP_ME: "x" });
  });

  it("refuses a second apply while an un-undone remap exists (the undo baseline is never clobbered)", async () => {
    const { svc } = harness();
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await svc.remapEnvApply("user-1", "op-1", planHash);
    // a fresh plan over the now-rewritten env would re-plan to no changes; but the guard trips first.
    await expect(svc.remapEnvApply("user-1", "op-1", planHash)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses undo when nothing has been applied (409)", async () => {
    const { svc } = harness();
    await expect(svc.remapEnvUndo("user-1", "op-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to apply a plan that proposes no automatic rewrites (409), so an empty confirm is never a silent no-op", async () => {
    // an env that references no migrated DB → zero changes → nothing to apply.
    const { svc, apps } = harness({ env: { LOG_LEVEL: "info" } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await expect(svc.remapEnvApply("user-1", "op-1", planHash)).rejects.toBeInstanceOf(ConflictException);
    expect(apps.setEnv).not.toHaveBeenCalled();
  });

  it("the stored undo snapshot is encrypted at rest — no raw secret sits in op.meta", async () => {
    const { svc, prisma, crypto } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await svc.remapEnvApply("user-1", "op-1", planHash);
    expect(crypto.encrypt).toHaveBeenCalled();
    const metaWritten = prisma.bulkOperation.updateMany.mock.calls.at(-1)?.[0].data.meta;
    expect(JSON.stringify(metaWritten)).not.toContain("S3cr3t"); // the prior env is ciphertext in meta, not plaintext
  });

  it("persists the undo record BEFORE writing, so a mid-loop write failure stays fully reversible (Fix A)", async () => {
    const { svc, prisma } = harness({
      setEnvFailIds: ["app-2"], // the 2nd app's write fails after the 1st already wrote
      apps: [
        { id: "app-1", itemRef: `app:_:${APPUUID}`, name: "web", env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` } },
        { id: "app-2", itemRef: "app:_:bbbb1111cccc2222dddd3333", name: "api", env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` } },
      ],
    });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    const res = await svc.remapEnvApply("user-1", "op-1", planHash);
    expect(res.applied).toBe(false); // partial
    expect(res.apps.map((a) => a.appId)).toEqual(["app-1"]);
    expect(res.failed).toContainEqual(expect.objectContaining({ appId: "app-2" }));
    // the undo commit (an atomic CAS, before any setEnv) already covers BOTH apps → reversible.
    const committed = prisma.bulkOperation.updateMany.mock.calls[0][0].data.meta;
    expect(committed.remapUndo.apps.map((a: { appId: string }) => a.appId).sort()).toEqual(["app-1", "app-2"]);
    expect(committed.remapUndo.undoneAt).toBeUndefined();
  });

  it("undo reverts ONLY the remapped keys, preserving env vars added after apply (Fix D)", async () => {
    const { svc, apps, envById } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb`, KEEP: "x" } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await svc.remapEnvApply("user-1", "op-1", planHash);
    envById.set("app-1", { ...(envById.get("app-1") as Record<string, string>), FEATURE_FLAG: "on" }); // operator edits AFTER apply
    await svc.remapEnvUndo("user-1", "op-1");
    const final = apps.setEnv.mock.calls.at(-1)?.[2] as Record<string, string>;
    expect(final.DATABASE_URL).toBe(`postgres://appuser:S3cr3t@${UUID}:5432/appdb`); // remapped key reverted
    expect(final.FEATURE_FLAG).toBe("on"); // the post-apply edit is KEPT (no blind whole-env replace)
    expect(final.KEEP).toBe("x");
  });

  it("undo that fails transiently keeps the app pending (undoneAt unset) and a retry restores it (Fix C)", async () => {
    const { svc, apps, prisma } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await svc.remapEnvApply("user-1", "op-1", planHash);
    apps.setEnv.mockRejectedValueOnce(new Error("blip")); // the undo's setEnv blips once
    const first = await svc.remapEnvUndo("user-1", "op-1");
    expect(first.undone).toBe(false);
    const meta1 = prisma.bulkOperation.updateMany.mock.calls.at(-1)?.[0].data.meta;
    expect(meta1.remapUndo.undoneAt).toBeUndefined(); // NOT consumed — apply stays blocked
    expect(meta1.remapUndo.apps).toHaveLength(1); // still pending for retry
    const second = await svc.remapEnvUndo("user-1", "op-1"); // retry
    expect(second.undone).toBe(true);
    const meta2 = prisma.bulkOperation.updateMany.mock.calls.at(-1)?.[0].data.meta;
    expect(meta2.remapUndo.undoneAt).toBeTruthy();
  });

  it("undo DROPS an app that no longer exists (NotFound) and still consumes the record (Fix C)", async () => {
    const { svc, apps } = harness({ env: { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` } });
    const { planHash } = await svc.remapEnvPlan("user-1", "op-1");
    await svc.remapEnvApply("user-1", "op-1", planHash);
    apps.getEnv.mockRejectedValueOnce(new NotFoundException("app deleted")); // the app is gone at undo time
    const res = await svc.remapEnvUndo("user-1", "op-1");
    expect(res.undone).toBe(true); // a gone app has nothing to restore → record consumed, not stranded
    expect(res.failed).toContainEqual(expect.objectContaining({ appId: "app-1" }));
  });
});
