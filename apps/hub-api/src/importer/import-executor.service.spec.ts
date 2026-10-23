import { ImportExecutorService } from "./import-executor.service";
import { planImport } from "./import-planner";
import type { ForeignFleet } from "./foreign-fleet";

// Let the async fan-out (void this.fanout(...)) drain against immediately-resolving mocks.
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function fleet(): ForeignFleet {
  return {
    servers: [{ ref: "srv-a", name: "box", ip: "1.2.3.4" }],
    apps: [{ sourceRef: "app-1", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "o/r", branch: "main" }, ports: [3000], serverRef: "srv-a", env: [], volumes: [], domains: [] }],
    databases: [{ sourceRef: "db-1", name: "orders", engine: "POSTGRES", version: "16", serverRef: "srv-a" }],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}

const DB_ITEMREF = "database:srv-a:db-1";

function harness(over: { priorImported?: Array<{ itemRef: string; resourceId: string; resourceType: string }>; liveDbIds?: string[] } = {}) {
  let seq = 0;
  const created: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1" }) },
    bulkOperation: {
      findFirst: jest.fn().mockResolvedValue(null), // assertNoInflight: nothing in progress
      create: jest.fn().mockResolvedValue({ id: "op-1" }),
      findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }), // worker cancel check
      update: jest.fn().mockResolvedValue({}),
    },
    bulkTask: {
      findMany: jest.fn().mockResolvedValue(over.priorImported ?? []), // alreadyImported
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const t = { id: `task-${seq++}`, ...data };
        created.push({ id: t.id, data });
        return Promise.resolve(t);
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), // claim succeeds
    },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue((over.liveDbIds ?? []).map((id) => ({ id }))) },
  };
  const source = {
    discover: jest.fn().mockResolvedValue(fleet()),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const importer = { openSession: jest.fn().mockResolvedValue({ source }) };
  const apps = { create: jest.fn().mockResolvedValue({ id: "app-new", name: "web" }) };
  const dbs = { create: jest.fn().mockResolvedValue({ id: "db-new", name: "orders" }) };
  const svc = new ImportExecutorService(
    prisma as never,
    {} as never, // migrator (unused in coolify path)
    access as never,
    audit as never,
    importer as never,
    apps as never,
    dbs as never,
  );
  return { svc, prisma, source, apps, dbs, created };
}

function input() {
  const planHash = planImport(fleet(), { sourceKind: "coolify" }).planHash;
  return { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash };
}

describe("ImportExecutorService.applyCoolify — database provisioning (S1)", () => {
  it("provisions an empty Tugra database for a coolify DB item and records the sourceRef→resourceId mapping", async () => {
    const { svc, dbs, apps, prisma, source } = harness();
    const res = await svc.apply("user-1", input());
    expect(res.opId).toBe("op-1");
    await flush();

    // The database is created (deploy:false path) with the source engine/version on the TARGET server.
    expect(dbs.create).toHaveBeenCalledTimes(1);
    expect(dbs.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "orders", serverId: "srv-tugra", engine: "POSTGRES", version: "16" }));
    // And the mapping row is persisted so the migrator can later restore INTO it.
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE", resourceType: "database", resourceId: "db-new" }) }));
    // The app is still copied in the same run.
    expect(apps.create).toHaveBeenCalledTimes(1);
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE", resourceType: "application", resourceId: "app-new" }) }));
    expect(source.close).toHaveBeenCalled();
  });

  it("is idempotent: a DB already provisioned by a prior run (still live) is SKIPPED, not duplicated", async () => {
    const { svc, dbs, created } = harness({
      priorImported: [{ itemRef: DB_ITEMREF, resourceId: "db-existing", resourceType: "database" }],
      liveDbIds: ["db-existing"],
    });
    await svc.apply("user-1", input());
    await flush();

    expect(dbs.create).not.toHaveBeenCalled();
    const dbTask = created.find((c) => c.data.itemRef === DB_ITEMREF)!;
    expect(dbTask.data.status).toBe("SKIPPED");
    expect(String(dbTask.data.output)).toMatch(/already imported/);
  });

  it("still provisions when the prior-run DB was deleted since (stale mapping does not block re-provision)", async () => {
    const { svc, dbs } = harness({
      priorImported: [{ itemRef: DB_ITEMREF, resourceId: "db-existing", resourceType: "database" }],
      liveDbIds: [], // the earlier DB no longer exists
    });
    await svc.apply("user-1", input());
    await flush();
    expect(dbs.create).toHaveBeenCalledTimes(1);
  });
});

function rollbackHarness(opts: { dbStatus?: string; restores?: number; backups?: number } = {}) {
  const dbTask = { id: "t-db", itemRef: DB_ITEMREF, kind: "database", status: "DONE", resourceType: "database", resourceId: "db-1", result: { name: "orders" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation: null };
  const op = { id: "op-1", kind: "import", actorId: "user-1", planId: "h", meta: { sourceKind: "coolify", serverId: "srv-tugra" }, cancelRequestedAt: null, createdAt: new Date(), tasks: [dbTask] };
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1" }) },
    database: { findUnique: jest.fn().mockResolvedValue({ id: "db-1", status: opts.dbStatus ?? "NEW" }) },
    restore: { count: jest.fn().mockResolvedValue(opts.restores ?? 0) },
    backup: { count: jest.fn().mockResolvedValue(opts.backups ?? 0) },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const dbs = { remove: jest.fn().mockResolvedValue(undefined), create: jest.fn() };
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, {} as never, {} as never, dbs as never);
  return { svc, prisma, dbs };
}

describe("ImportExecutorService.rollback — database teardown guard (S1)", () => {
  it("tears down a still-EMPTY provisioned database (status NEW, no restores/backups)", async () => {
    const { svc, dbs, prisma } = rollbackHarness();
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).toHaveBeenCalledWith("user-1", "db-1");
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ROLLED_BACK" }) }));
  });

  it("NEVER tears down a database that has been started since import (status != NEW)", async () => {
    const { svc, dbs, prisma } = rollbackHarness({ dbStatus: "RUNNING" });
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).not.toHaveBeenCalled();
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ output: expect.stringMatching(/remove it manually/) }) }));
  });

  it("NEVER tears down a database that has data restored into it (restore history present)", async () => {
    const { svc, dbs } = rollbackHarness({ dbStatus: "NEW", restores: 1 });
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).not.toHaveBeenCalled();
  });
});
