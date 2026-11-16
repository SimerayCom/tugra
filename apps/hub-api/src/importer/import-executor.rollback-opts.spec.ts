import { ImportExecutorService } from "./import-executor.service";

/**
 * `rollback(userId, opId, opts?)` (P7): the run-owned-deployment allowance and the typed-name data removal are ADDITIVE.
 * Without `opts` the behaviour is exactly the original one (pinned here too, so the default can never drift).
 */
function harness(over: { deployCount?: number; appData?: boolean; dbStatus?: string; dbData?: boolean; restores?: number } = {}) {
  const appTask = { id: "t-app", itemRef: "app:_:web", kind: "app", status: "DONE", resourceType: "application", resourceId: "app-1", result: { name: "web" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation: null };
  const dbTask = { id: "t-db", itemRef: "database:_:db1", kind: "database", status: "DONE", resourceType: "database", resourceId: "db-1", result: { name: "pg-main" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation: null };
  const dataTasks = [
    ...(over.appData ? [{ id: "t-d1", itemRef: "data:volume:app:_:web:/data", kind: "data", status: "DONE", resourceType: null, resourceId: null, result: { appItemRef: "app:_:web" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation: null }] : []),
    ...(over.dbData ? [{ id: "t-d2", itemRef: "data:database:db1", kind: "data", status: "DONE", resourceType: null, resourceId: null, result: { databaseItemRef: "database:_:db1" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation: null }] : []),
  ];
  const op = { id: "op-1", kind: "import", actorId: "user-1", planId: "h", meta: { sourceKind: "coolify", serverId: "srv-tugra" }, cancelRequestedAt: null, createdAt: new Date(), tasks: [appTask, dbTask, ...dataTasks] };
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op), update: jest.fn().mockResolvedValue({}) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1" }) },
    application: { findUnique: jest.fn().mockResolvedValue({ id: "app-1" }) },
    deployment: { count: jest.fn().mockResolvedValue(over.deployCount ?? 0) },
    database: { findUnique: jest.fn().mockResolvedValue({ id: "db-1", status: over.dbStatus ?? "NEW" }) },
    restore: { count: jest.fn().mockResolvedValue(over.restores ?? 0) },
    backup: { count: jest.fn().mockResolvedValue(0) },
    migrationVolumeTransfer: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const apps = { remove: jest.fn().mockResolvedValue(undefined) };
  const dbs = { remove: jest.fn().mockResolvedValue(undefined) };
  const migrationTokens = { revoke: jest.fn().mockResolvedValue(false) };
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, {} as never, apps as never, dbs as never, migrationTokens as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, prisma, apps, dbs };
}

describe("ImportExecutorService.rollback without opts is unchanged", () => {
  it("counts EVERY deployment of the app: a deployed app is kept, a never-deployed one removed", async () => {
    const a = harness({ deployCount: 1 });
    await a.svc.rollback("user-1", "op-1");
    expect(a.prisma.deployment.count).toHaveBeenCalledWith({ where: { appId: "app-1" } });
    expect(a.apps.remove).not.toHaveBeenCalled();
    const b = harness({ deployCount: 0 });
    await b.svc.rollback("user-1", "op-1");
    expect(b.apps.remove).toHaveBeenCalledWith("user-1", "app-1");
    expect(b.dbs.remove).toHaveBeenCalledWith("user-1", "db-1");
  });

  it("data-bearing resources are never removed, whatever the (absent) options", async () => {
    const h = harness({ appData: true, dbData: true, dbStatus: "RUNNING" });
    await h.svc.rollback("user-1", "op-1");
    expect(h.apps.remove).not.toHaveBeenCalled();
    expect(h.dbs.remove).not.toHaveBeenCalled();
  });
});

describe("runOwnedDeployments", () => {
  it("only deployments NOT carrying the run's key prefix count (a null key is a person's deployment)", async () => {
    const h = harness({ deployCount: 0 });
    await h.svc.rollback("user-1", "op-1", { runOwnedDeployments: { runId: "run-9" } });
    expect(h.prisma.deployment.count).toHaveBeenCalledWith({ where: { appId: "app-1", OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "migrun:run-9:" } } }] } });
    expect(h.apps.remove).toHaveBeenCalledWith("user-1", "app-1");
  });

  it("an app a person deployed by hand is still kept", async () => {
    const h = harness({ deployCount: 1 });
    await h.svc.rollback("user-1", "op-1", { runOwnedDeployments: { runId: "run-9" } });
    expect(h.apps.remove).not.toHaveBeenCalled();
  });

  it("does not by itself unlock data-bearing resources", async () => {
    const h = harness({ appData: true, dbStatus: "RUNNING" });
    await h.svc.rollback("user-1", "op-1", { runOwnedDeployments: { runId: "run-9" } });
    expect(h.apps.remove).not.toHaveBeenCalled();
    expect(h.dbs.remove).not.toHaveBeenCalled();
  });
});

describe("includeData with typed names", () => {
  it("removes a restored app and a started database only when includeData is true AND the exact name is listed", async () => {
    const h = harness({ appData: true, dbData: true, dbStatus: "RUNNING" });
    await h.svc.rollback("user-1", "op-1", { runOwnedDeployments: { runId: "r" }, includeData: true, dataConfirmNames: ["web", "pg-main"] });
    expect(h.apps.remove).toHaveBeenCalledWith("user-1", "app-1");
    expect(h.dbs.remove).toHaveBeenCalledWith("user-1", "db-1");
  });

  it("a name that is not typed (or typed differently) keeps the resource", async () => {
    const h = harness({ appData: true, dbStatus: "RUNNING", restores: 2 });
    await h.svc.rollback("user-1", "op-1", { includeData: true, dataConfirmNames: ["WEB", "pg-main "] });
    expect(h.apps.remove).not.toHaveBeenCalled();
    expect(h.dbs.remove).not.toHaveBeenCalled();
  });

  it("typed names without includeData do nothing", async () => {
    const h = harness({ appData: true, dbStatus: "RUNNING" });
    await h.svc.rollback("user-1", "op-1", { includeData: false, dataConfirmNames: ["web", "pg-main"] });
    expect(h.apps.remove).not.toHaveBeenCalled();
    expect(h.dbs.remove).not.toHaveBeenCalled();
  });

  it("only the named resource goes: the other data-bearing one stays", async () => {
    const h = harness({ appData: true, dbStatus: "RUNNING" });
    await h.svc.rollback("user-1", "op-1", { includeData: true, dataConfirmNames: ["pg-main"] });
    expect(h.dbs.remove).toHaveBeenCalledWith("user-1", "db-1");
    expect(h.apps.remove).not.toHaveBeenCalled();
  });
});
