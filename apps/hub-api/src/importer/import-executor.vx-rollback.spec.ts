import { ImportExecutorService } from "./import-executor.service";

/** Rollback guard for streamed (v2) volume data: APPLYING/DONE protect the app/database, anything earlier is cleaned up. */
function make(state: string | null, kind: "app" | "db") {
  const appRef = "app:srv1:5f3a9c";
  const dbRef = "database:srv1:pg7c1";
  const volRef = kind === "app" ? `volume:srv1:5f3a9c:data` : `volume:srv1:pg7c1:data`;
  const tasks = [
    { id: "t-app", itemRef: appRef, kind: "app", status: "DONE", resourceType: "application", resourceId: "app-1", result: {}, output: null, compensation: null },
    { id: "t-db", itemRef: dbRef, kind: "database", status: "DONE", resourceType: "database", resourceId: "db-1", result: {}, output: null, compensation: null },
    ...(state === null
      ? []
      : [{ id: "t-data", itemRef: `data:${volRef}`, kind: "data", status: state === "DONE" ? "DONE" : "FAILED", resourceType: null, resourceId: null, result: kind === "app" ? { vx: true, appItemRef: appRef, volumeName: "data" } : { vx: true, databaseItemRef: dbRef }, output: null, compensation: null }]),
  ];
  const op = { id: "op-1", kind: "import", actorId: "user-1", planId: "h", meta: { sourceKind: "coolify", serverId: "srv-1" }, cancelRequestedAt: null, createdAt: new Date(), tasks };
  const transfer = { id: "cktransfer00000000000000001", itemRef: volRef, state, targetServerId: "srv-1" };
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op), update: jest.fn().mockResolvedValue({}) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-1", teamId: "team-1" }) },
    application: { findUnique: jest.fn().mockResolvedValue({ id: "app-1" }) },
    database: { findUnique: jest.fn().mockResolvedValue({ id: "db-1", status: "NEW" }) },
    deployment: { count: jest.fn().mockResolvedValue(0) },
    restore: { count: jest.fn().mockResolvedValue(0) },
    backup: { count: jest.fn().mockResolvedValue(0) },
    migrationVolumeTransfer: { findMany: jest.fn().mockResolvedValue(state === null ? [] : [transfer]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const apps = { remove: jest.fn().mockResolvedValue(undefined) };
  const dbs = { remove: jest.fn().mockResolvedValue(undefined) };
  const vxApply = { cleanupTarget: jest.fn().mockResolvedValue(true) };
  const migrationTokens = { revoke: jest.fn().mockResolvedValue(false) };
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, {} as never, apps as never, dbs as never, migrationTokens as never, {} as never, {} as never, {} as never, {} as never, undefined as never, vxApply as never);
  return { svc, prisma, apps, dbs, vxApply };
}

describe("ImportExecutorService.rollback with streamed volume copies", () => {
  it.each(["APPLYING", "DONE"])("an app whose streamed volume is %s is NOT removed (its data is the migration's result)", async (state) => {
    const { svc, apps, vxApply, prisma } = make(state, "app");
    await svc.rollback("user-1", "op-1");
    expect(apps.remove).not.toHaveBeenCalled();
    expect(vxApply.cleanupTarget).not.toHaveBeenCalled();
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: { output: expect.stringContaining("app volume data was restored by this migration") } }));
  });

  it.each(["APPLYING", "DONE"])("a database whose streamed volume is %s is NOT removed", async (state) => {
    const { svc, dbs, prisma } = make(state, "db");
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).not.toHaveBeenCalled();
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: { output: expect.stringContaining("database data was copied by this migration") } }));
  });

  it.each(["PENDING", "COPYING", "COPIED", "FAILED"])("a %s transfer only holds staged parts: they are cleaned up, the transfer is ABORTED and the rollback proceeds", async (state) => {
    const { svc, apps, vxApply, prisma } = make(state, "app");
    await svc.rollback("user-1", "op-1");
    expect(vxApply.cleanupTarget).toHaveBeenCalledWith("cktransfer00000000000000001", "srv-1");
    expect(prisma.migrationVolumeTransfer.updateMany).toHaveBeenCalledWith({ where: { id: "cktransfer00000000000000001", state: { in: ["PENDING", "COPYING", "COPIED", "FAILED"] } }, data: expect.objectContaining({ state: "ABORTED" }) });
    expect(apps.remove).toHaveBeenCalledWith("user-1", "app-1");
  });

  it("an import with no streamed copies never touches the transfer table", async () => {
    const { svc, prisma, apps } = make(null, "app");
    await svc.rollback("user-1", "op-1");
    expect(prisma.migrationVolumeTransfer.findMany).not.toHaveBeenCalled();
    expect(apps.remove).toHaveBeenCalled();
  });
});
