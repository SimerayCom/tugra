import { ConflictException } from "@nestjs/common";
import { MigrationIngestService } from "./migration-ingest.service";
import { VX_409 } from "./volume-stream/vx-constants";

const OP = { opId: "op-1", actorId: "user-1", expiresAt: new Date(Date.now() + 3_600_000) };
const DB_REF = "database:srv1:pg7c1";
const APP_REF = "app:srv1:5f3a9c";

function make(o: { dbVolumeMode?: boolean; transfer?: boolean; vxRows?: unknown[]; envelope?: Record<string, unknown> } = {}) {
  const tasks = [
    { id: "t-db", itemRef: DB_REF, kind: "database", status: "DONE", resourceType: "database", resourceId: "db-1", result: {} },
    { id: "t-app", itemRef: APP_REF, kind: "app", status: "DONE", resourceType: "application", resourceId: "app-1", result: { volumes: { mounts: [{ path: "/var/www/data", name: "data" }], declared: 1 } } },
  ];
  const opRow = { id: "op-1", actorId: "user-1", meta: { serverId: "srv-1", hubBase: "http://localhost:3000", plan: { items: o.dbVolumeMode ? [{ itemRef: DB_REF, kind: "database", proposed: { dataMode: "volume" } }] : [] } }, tasks };
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-1", teamId: "team-1" }) },
    database: { findUnique: jest.fn().mockResolvedValue({ id: "db-1", engine: "POSTGRES", serverId: "srv-1", teamId: "team-1", status: "NEW" }) },
    application: { findUnique: jest.fn().mockResolvedValue({ id: "app-1", serverId: "srv-1", teamId: "team-1", clusterId: null, volumes: [{ name: "data", path: "/var/www/data" }] }) },
    bulkTask: {
      // the provisioning tasks resolve by (itemRef, kind, status DONE); data/staging rows do not exist yet
      findFirst: jest.fn(async (a: { where: { itemRef?: string; kind?: string; status?: string } }) => tasks.find((t) => t.itemRef === a.where.itemRef && (!a.where.kind || t.kind === a.where.kind) && (!a.where.status || t.status === a.where.status)) ?? null),
      create: jest.fn().mockResolvedValue({ id: "stage-1" }),
    },
    migrationVolumeTransfer: { findUnique: jest.fn().mockResolvedValue(o.transfer ? { id: "tr1" } : null) },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const executor = { loadIngestOp: jest.fn().mockResolvedValue(opRow) };
  const vx = { targetRows: jest.fn().mockResolvedValue({ rows: o.vxRows ?? [], volumeRefOfDb: new Map(o.dbVolumeMode ? [[DB_REF, "volume:srv1:pg7c1:data"]] : []) }), targetsEnvelope: jest.fn().mockReturnValue(o.envelope ?? {}) };
  const svc = new MigrationIngestService(prisma as never, access as never, { log: jest.fn() } as never, executor as never, {} as never, {} as never, {} as never, { get: () => "x".repeat(32) } as never, vx as never);
  return { svc, prisma, vx, executor, opRow };
}
const req = { headers: { "content-type": "application/octet-stream", "content-length": "5" } } as never;

afterEach(() => {
  delete process.env.MIGRATION_VX_ENABLED;
});

describe("GET targets with the streamed copy", () => {
  it("existing rows are byte-identical; volume rows and the envelope are only ADDED", async () => {
    const base = await make().svc.listTargets(OP);
    expect(base).toEqual({
      opId: "op-1",
      targets: [
        { itemRef: DB_REF, kind: "database", engine: "POSTGRES" },
        { itemRef: APP_REF, kind: "application", volumes: [{ name: "data", path: "/var/www/data" }], volumeIngest: "hub-staged" },
      ],
      maxArtifactBytes: expect.any(Number),
      maxVolumeBytes: expect.any(Number),
    });
    const row = { itemRef: "volume:srv1:5f3a9c:data", kind: "volume", volumeIngest: "stream-v2" };
    const withVx = (await make({ vxRows: [row], envelope: { vxProtocol: 1, vx: { partRawBytes: 1, maxBytes: 2, maxParts: 3 } } }).svc.listTargets(OP)) as { targets: unknown[]; vxProtocol: number };
    expect(withVx.targets.slice(0, 2)).toEqual((base as { targets: unknown[] }).targets);
    expect(withVx.targets[2]).toEqual(row);
    expect(withVx.vxProtocol).toBe(1);
  });

  it("marks the database row `dataPlane: volume` ONLY when its plan chose a volume copy", async () => {
    const vol = (await make({ dbVolumeMode: true }).svc.listTargets(OP)) as { targets: Array<{ itemRef: string; dataPlane?: string }> };
    expect(vol.targets.find((t) => t.itemRef === DB_REF)!.dataPlane).toBe("volume");
    const plain = (await make().svc.listTargets(OP)) as { targets: Array<{ itemRef: string; dataPlane?: string }> };
    expect(plain.targets.find((t) => t.itemRef === DB_REF)).not.toHaveProperty("dataPlane");
  });

  it("the response carries no host path, credential or token", async () => {
    const json = JSON.stringify(await make({ dbVolumeMode: true }).svc.listTargets(OP));
    expect(json).not.toMatch(/tugra_dbv|tugra_appv|\/etc\/tugra|tugra_mig_|password/i);
  });
});

describe("old-migrator guards (fail closed)", () => {
  it("DB stage and restore refuse once the plan chose a volume copy (`this database is set to volume copy`)", async () => {
    const { svc } = make({ dbVolumeMode: true });
    await expect(svc.stage(OP, DB_REF, req, { gzip: true })).rejects.toThrow(VX_409.dbVolumeMode);
    await expect(svc.restore(OP, DB_REF, { resync: false })).rejects.toThrow(VX_409.dbVolumeMode);
  });

  it("DB stage and restore also refuse once the database is on the streamed dump lane (its data moves as a dump through the volume stream)", async () => {
    const { svc, executor, opRow } = make();
    executor.loadIngestOp.mockResolvedValue({ ...opRow, meta: { ...(opRow.meta as object), vxStream: { [DB_REF]: { at: "t", by: "u" } } } });
    await expect(svc.stage(OP, DB_REF, req, { gzip: true })).rejects.toThrow(VX_409.dbVolumeMode);
    await expect(svc.restore(OP, DB_REF, { resync: false })).rejects.toThrow(VX_409.dbVolumeMode);
  });

  it("a normal logical DB is NOT closed by the guard", async () => {
    const { svc } = make();
    // it gets past the guard and fails later on the missing artifact, not with the volume-copy literal
    await expect(svc.restore(OP, DB_REF, { resync: false })).rejects.not.toThrow(VX_409.dbVolumeMode);
  });

  it("with the stream disabled the DB guard is off (today's behaviour)", async () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    const { svc } = make({ dbVolumeMode: true });
    await expect(svc.restore(OP, DB_REF, { resync: false })).rejects.not.toThrow(VX_409.dbVolumeMode);
  });

  it("v1 volume stage and restore refuse once a streamed transfer exists (`this volume uses the streamed copy`)", async () => {
    const { svc, prisma } = make({ transfer: true });
    await expect(svc.stageVolume(OP, APP_REF, "data", req, { gzip: true })).rejects.toThrow(VX_409.usesStream);
    await expect(svc.restoreVolume(OP, APP_REF, "data", { resync: false })).rejects.toThrow(VX_409.usesStream);
    expect(prisma.migrationVolumeTransfer.findUnique).toHaveBeenCalledWith({ where: { opId_itemRef: { opId: "op-1", itemRef: "volume:srv1:5f3a9c:data" } }, select: { id: true } });
  });

  it("without a transfer the v1 route is untouched", async () => {
    const { svc } = make();
    const err = await svc.restoreVolume(OP, APP_REF, "data", { resync: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/nothing staged/); // today's behaviour
  });
});

describe("destination placement on a multi-host op (grup-7)", () => {
  type Priv = { resolveTarget(op: typeof OP, ref: string): Promise<{ db: { serverId: string } }>; resolveVolumeTarget(op: typeof OP, ref: string, vol: string): Promise<{ app: { serverId: string } }> };
  const placed = (taskServer: string | undefined) => (a: { where: { itemRef?: string; kind?: string } }) =>
    Promise.resolve(
      a.where.kind === "database"
        ? { id: "t-db", itemRef: DB_REF, serverId: taskServer, resourceId: "db-1" }
        : { id: "t-app", itemRef: APP_REF, serverId: taskServer, resourceId: "app-1" },
    );

  it("a database placed on another target server is a valid destination of its own task, and only of it", async () => {
    const { svc, prisma } = make();
    const priv = svc as unknown as Priv;
    (prisma.bulkTask.findFirst as jest.Mock).mockImplementation(placed("tgt-2"));
    (prisma.database.findUnique as jest.Mock).mockResolvedValue({ id: "db-1", engine: "POSTGRES", serverId: "tgt-2", teamId: "team-1", status: "NEW" });
    await expect(priv.resolveTarget(OP, DB_REF)).resolves.toMatchObject({ db: { serverId: "tgt-2" } });
    // the database sits on the default server while its task was placed on tgt-2: not a destination of this import
    (prisma.database.findUnique as jest.Mock).mockResolvedValue({ id: "db-1", engine: "POSTGRES", serverId: "srv-1", teamId: "team-1", status: "NEW" });
    await expect(priv.resolveTarget(OP, DB_REF)).rejects.toThrow(/does not belong/);
  });

  it("a task with no recorded server falls back to the op's default server (rows from before multi-host)", async () => {
    const { svc, prisma } = make();
    const priv = svc as unknown as Priv;
    (prisma.bulkTask.findFirst as jest.Mock).mockImplementation(placed(undefined));
    await expect(priv.resolveTarget(OP, DB_REF)).resolves.toMatchObject({ db: { serverId: "srv-1" } });
    (prisma.database.findUnique as jest.Mock).mockResolvedValue({ id: "db-1", engine: "POSTGRES", serverId: "other", teamId: "team-1", status: "NEW" });
    await expect(priv.resolveTarget(OP, DB_REF)).rejects.toThrow(/does not belong/);
  });

  it("an app volume follows its own task's server the same way", async () => {
    const { svc, prisma } = make();
    const priv = svc as unknown as Priv;
    (prisma.bulkTask.findFirst as jest.Mock).mockImplementation(placed("tgt-2"));
    (prisma.application.findUnique as jest.Mock).mockResolvedValue({ id: "app-1", serverId: "tgt-2", teamId: "team-1", clusterId: null, volumes: [{ name: "data", path: "/var/www/data" }] });
    await expect(priv.resolveVolumeTarget(OP, APP_REF, "data")).resolves.toMatchObject({ app: { serverId: "tgt-2" } });
    (prisma.application.findUnique as jest.Mock).mockResolvedValue({ id: "app-1", serverId: "srv-1", teamId: "team-1", clusterId: null, volumes: [{ name: "data", path: "/var/www/data" }] });
    await expect(priv.resolveVolumeTarget(OP, APP_REF, "data")).rejects.toThrow(/does not belong/);
  });
});
