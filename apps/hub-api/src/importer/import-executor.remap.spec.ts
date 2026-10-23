import { ConflictException, ForbiddenException } from "@nestjs/common";
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
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-1", teamId: "team-1" }) },
  };
  const access = {
    requirePermission: opts.permissionThrows
      ? jest.fn().mockRejectedValue(new ForbiddenException("denied"))
      : jest.fn().mockResolvedValue(undefined),
  };
  const apps = { getEnv: jest.fn().mockImplementation((_u: string, id: string) => Promise.resolve(envById.get(id) ?? {})) };
  const dbs = { get: opts.dbGetError ? jest.fn().mockRejectedValue(new Error("deleted")) : jest.fn().mockResolvedValue(dbView) };
  const svc = new ImportExecutorService(
    prisma as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    apps as never,
    dbs as never,
    {} as never,
  );
  return { svc, prisma, access, apps, dbs };
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

  it("is read-only: it never writes an env or a DB (only getEnv + dbs.get are called)", async () => {
    const { svc, apps, dbs } = harness();
    await svc.remapEnvPlan("user-1", "op-1");
    expect(apps.getEnv).toHaveBeenCalledWith("user-1", "app-1");
    expect(dbs.get).toHaveBeenCalledWith("user-1", "db-1");
    // the stubbed services expose no setEnv/create, so a write would throw — the call completing proves read-only
  });
});
