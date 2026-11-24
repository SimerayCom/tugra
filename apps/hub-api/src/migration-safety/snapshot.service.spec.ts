import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { SnapshotService } from "./snapshot.service";
import { SnapshotSchedulerService } from "./snapshot-scheduler.service";

const ACTOR = { userId: "u1", scopes: ["*"], channel: "session" } as never;
const RUN = { id: "r1", teamId: "t1", opId: "op1", status: "RUNNING" };
const S3 = { type: "S3", s3: { bucket: "bk", region: "r", endpoint: "https://s3.example.com", accessKey: "AK-SECRET", secretKey: "SK-SECRET", prefix: "p" }, encryption: { enabled: false, key: "" } };
const LOCAL = { type: "LOCAL", encryption: { enabled: false, key: "" } };

type Snap = { id: string; runId: string; teamId: string; destinationId: string | null; status: string; items: unknown; note: string | null; expiresAt: Date | null; capturedAt: Date | null; restoredAt: Date | null };

function make(o: { snap?: Partial<Snap> | null; dest?: unknown; send?: jest.Mock; run?: unknown } = {}) {
  const state: { snap: Snap | null } = { snap: o.snap === null ? null : { id: "sn1", runId: "r1", teamId: "t1", destinationId: "d1", status: "PLANNED", items: [], note: null, expiresAt: null, capturedAt: null, restoredAt: null, ...o.snap } };
  const send = o.send ?? jest.fn().mockResolvedValue({ exitCode: 0, output: "2048" });
  const prisma = {
    migrationSnapshot: {
      findUnique: jest.fn(async () => state.snap),
      findUniqueOrThrow: jest.fn(async () => state.snap),
      findMany: jest.fn(async () => (state.snap ? [state.snap] : [])),
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => { state.snap = { ...(state.snap ?? (create as unknown as Snap)), ...update } as Snap; return state.snap; }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { state.snap = { ...state.snap!, ...data } as Snap; return state.snap; }),
      updateMany: jest.fn(async ({ where, data }: { where: { status: { in?: string[] } | string }; data: Record<string, unknown> }) => {
        const allowed = typeof where.status === "string" ? [where.status] : where.status.in ?? [];
        if (!state.snap || !allowed.includes(state.snap.status)) return { count: 0 };
        state.snap = { ...state.snap, ...data } as Snap;
        return { count: 1 };
      }),
    },
    migrationRun: { findUnique: jest.fn().mockResolvedValue("run" in o ? o.run : { opId: "op1", status: "RUNNING", steps: [{ key: "DATA_FINAL", status: "PASSED" }] }) },
    backupDestination: {
      findUnique: jest.fn().mockResolvedValue({ id: "d1", teamId: "t1" }),
      findMany: jest.fn().mockResolvedValue([{ id: "d1", name: "Bucket", type: "S3" }]),
    },
    bulkTask: { findMany: jest.fn().mockResolvedValue([{ resourceType: "database", resourceId: "db1" }, { resourceType: "application", resourceId: "a1" }]) },
    database: { findMany: jest.fn().mockResolvedValue([{ id: "db1", name: "main", engine: "POSTGRES", serverId: "s1" }]) },
    application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", name: "api", serverId: "s1", volumes: [{ name: "uploads", path: "/data" }] }]) },
    backup: { create: jest.fn().mockResolvedValue({ id: "b1" }), update: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    volumeBackup: { create: jest.fn().mockResolvedValue({ id: "v1" }), update: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  };
  const audit = { log: jest.fn() };
  const backups = { destinationSpecById: jest.fn().mockResolvedValue("dest" in o ? o.dest : S3), toSpec: jest.fn().mockReturnValue({ id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "u", password: "p", database: "d" } }) };
  const dbBackups = { restore: jest.fn().mockResolvedValue(undefined) };
  const volBackups = { restore: jest.fn().mockResolvedValue(undefined) };
  const runs = { get: jest.fn().mockResolvedValue(o.run && typeof o.run === "object" && "id" in (o.run as object) ? o.run : RUN) };
  const svc = new SnapshotService(prisma as never, audit as never, { sendCommand: send } as never, backups as never, dbBackups as never, volBackups as never, runs as never);
  return { svc, prisma, state, send, audit, dbBackups, volBackups, runs, backups };
}

describe("SnapshotService.plan", () => {
  it("records the chosen destination (team-checked) and lets the choice change until the copy starts", async () => {
    const t = make({ snap: null });
    const v = await t.svc.plan(ACTOR, "r1", { destinationId: "d1", skip: false });
    expect(t.prisma.migrationSnapshot.upsert).toHaveBeenCalled();
    expect(v.snapshot).toMatchObject({ status: "PLANNED", destinationId: "d1", destinationType: "S3", keepDays: 7 });
    await t.svc.plan(ACTOR, "r1", { destinationId: null, skip: false });
    expect(t.state.snap).toMatchObject({ destinationId: null, status: "PLANNED" });
  });
  it("accepts the target's own disk and shows it as LOCAL (the UI warns)", async () => {
    const t = make({ snap: null });
    expect((await t.svc.plan(ACTOR, "r1", { destinationId: null, skip: false })).snapshot?.destinationType).toBe("LOCAL");
  });
  it("records an explicit skip", async () => {
    const t = make({ snap: null });
    expect((await t.svc.plan(ACTOR, "r1", { destinationId: "d1", skip: true })).snapshot?.status).toBe("SKIPPED");
  });
  it("refuses a destination of another team, a started copy and a finished run", async () => {
    const other = make({ snap: null });
    (other.prisma.backupDestination.findUnique as jest.Mock).mockResolvedValue({ id: "dX", teamId: "OTHER" });
    await expect(other.svc.plan(ACTOR, "r1", { destinationId: "dX", skip: false })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ snap: { status: "SUCCESS" } }).svc.plan(ACTOR, "r1", { destinationId: "d1", skip: false })).rejects.toBeInstanceOf(ConflictException);
    const over = make({ snap: null });
    over.runs.get.mockResolvedValue({ ...RUN, status: "ABORTED" });
    await expect(over.svc.plan(ACTOR, "r1", { destinationId: "d1", skip: false })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("SnapshotService.capture", () => {
  it("copies every database and volume of the run to the chosen destination and records them as backups", async () => {
    const t = make();
    await t.svc.capture("sn1");
    expect(t.send).toHaveBeenCalledTimes(2);
    const scripts = t.send.mock.calls.map((c) => String(c[1]));
    expect(scripts[0]).toContain("pg_dump");
    expect(scripts[0]).toContain("mc pipe");
    expect(scripts[1]).toContain("tar -C /data");
    expect(t.prisma.backup.create).toHaveBeenCalledWith({ data: expect.objectContaining({ databaseId: "db1", destinationId: "d1", createdBy: "migration-snapshot:r1" }) });
    expect(t.prisma.volumeBackup.create).toHaveBeenCalledWith({ data: expect.objectContaining({ appId: "a1", volumeName: "uploads", destinationId: "d1" }) });
    expect(t.state.snap!.status).toBe("SUCCESS");
    expect((t.state.snap!.items as unknown[]).length).toBe(2);
    expect(t.state.snap!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
  });

  it("is PARTIAL when one item fails and keeps secrets out of the recorded error", async () => {
    const send = jest.fn().mockResolvedValueOnce({ exitCode: 0, output: "10" }).mockResolvedValueOnce({ exitCode: 1, output: "mc: failed with AK-SECRET and SK-SECRET" });
    const t = make({ send });
    await t.svc.capture("sn1");
    expect(t.state.snap!.status).toBe("PARTIAL");
    expect(JSON.stringify(t.state.snap!.items)).not.toMatch(/AK-SECRET|SK-SECRET/);
  });

  it("an agent that throws fails the item, never the whole hub", async () => {
    const t = make({ send: jest.fn().mockRejectedValue(new Error("agent offline")) });
    await t.svc.capture("sn1");
    expect(t.state.snap!.status).toBe("FAILED");
    expect(JSON.stringify(t.state.snap!.items)).toContain("agent offline");
  });

  it("an unreadable destination fails the copy with a short note", async () => {
    const t = make();
    (t.backups.destinationSpecById as jest.Mock).mockRejectedValue(new Error("destination key unreadable"));
    await t.svc.capture("sn1");
    expect(t.state.snap).toMatchObject({ status: "FAILED" });
    expect(t.send).not.toHaveBeenCalled();
  });

  it("claims the row atomically: a second capture of the same row does nothing", async () => {
    const t = make({ snap: { status: "CAPTURING" } });
    await t.svc.capture("sn1");
    expect(t.send).not.toHaveBeenCalled();
  });

  it("writes to the local disk when no destination was chosen", async () => {
    const t = make({ snap: { destinationId: null }, dest: LOCAL });
    await t.svc.capture("sn1");
    expect(String(t.send.mock.calls[0][1])).not.toContain("mc pipe");
    expect(t.state.snap!.status).toBe("SUCCESS");
  });

  it("nothing to copy is SKIPPED, not a fake success", async () => {
    const t = make();
    (t.prisma.bulkTask.findMany as jest.Mock).mockResolvedValue([]);
    (t.prisma.database.findMany as jest.Mock).mockResolvedValue([]);
    (t.prisma.application.findMany as jest.Mock).mockResolvedValue([]);
    await t.svc.capture("sn1");
    expect(t.state.snap).toMatchObject({ status: "SKIPPED", note: "nothing-to-copy" });
  });
});

describe("SnapshotService.runDue / captureNow", () => {
  it("takes the copy only once the final data copy passed", async () => {
    const early = make({ run: { opId: "op1", status: "RUNNING", steps: [{ key: "DATA_FINAL", status: "RUNNING" }] } });
    await early.svc.runDue();
    expect(early.send).not.toHaveBeenCalled();
    const ready = make();
    await ready.svc.runDue();
    expect(ready.send).toHaveBeenCalled();
  });
  it("drops a planned copy of a run that is over", async () => {
    const t = make({ run: { opId: "op1", status: "ABORTED", steps: [] } });
    await t.svc.runDue();
    expect(t.state.snap).toMatchObject({ status: "SKIPPED", note: "run-over" });
    expect(t.send).not.toHaveBeenCalled();
  });
  it("captureNow needs a plan first and retries a failed copy", async () => {
    await expect(make({ snap: null }).svc.captureNow(ACTOR, "r1")).rejects.toBeInstanceOf(ConflictException);
    const t = make({ snap: { status: "FAILED" } });
    await t.svc.captureNow(ACTOR, "r1");
    expect(t.state.snap!.status).toBe("SUCCESS");
  });
  it("the scheduler tick drives due copies and never stacks", async () => {
    const t = make();
    const sch = new SnapshotSchedulerService(t.svc);
    await sch.tick();
    expect(t.send).toHaveBeenCalled();
  });
});

describe("SnapshotService.restore", () => {
  const done = { status: "SUCCESS", items: [{ kind: "database", ref: "db1", name: "main", rowId: "b1", status: "SUCCESS", sizeBytes: "1", error: null }, { kind: "volume", ref: "a1", volume: "uploads", name: "api", rowId: "v1", status: "SUCCESS", sizeBytes: "1", error: null }] };
  it("goes back through the existing restore of the recorded backup (permission is re-checked there)", async () => {
    const t = make({ snap: done });
    await t.svc.restore(ACTOR, "r1", "b1");
    expect(t.dbBackups.restore).toHaveBeenCalledWith("u1", "db1", "b1");
    await t.svc.restore(ACTOR, "r1", "v1");
    expect(t.volBackups.restore).toHaveBeenCalledWith("u1", "a1", "v1");
    expect(t.state.snap!.restoredAt).toBeInstanceOf(Date);
  });
  it("refuses an item that is not part of this copy and an expired copy", async () => {
    await expect(make({ snap: done }).svc.restore(ACTOR, "r1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ snap: { ...done, status: "EXPIRED" } }).svc.restore(ACTOR, "r1", "b1")).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ snap: null }).svc.restore(ACTOR, "r1", "b1")).rejects.toBeInstanceOf(ConflictException);
  });
  it("authorizes through the run first", async () => {
    const t = make({ snap: done });
    t.runs.get.mockRejectedValue(new Error("not found"));
    await expect(t.svc.restore(ACTOR, "other", "b1")).rejects.toThrow("not found");
    expect(t.dbBackups.restore).not.toHaveBeenCalled();
  });
});

describe("SnapshotService.sweepExpired", () => {
  const old = { status: "SUCCESS", expiresAt: new Date(Date.now() - 1000), items: [{ kind: "database", ref: "db1", name: "main", rowId: "b1", status: "SUCCESS", sizeBytes: "1", error: null }, { kind: "volume", ref: "a1", volume: "uploads", name: "api", rowId: "v1", status: "SUCCESS", sizeBytes: "1", error: null }] };
  it("removes the stored objects and rows after seven days, then marks the copy expired", async () => {
    const t = make({ snap: old });
    (t.prisma.backup.findUnique as jest.Mock).mockResolvedValue({ id: "b1", databaseId: "db1", filename: "f.dump.gz", database: { serverId: "s1" } });
    (t.prisma.volumeBackup.findUnique as jest.Mock).mockResolvedValue({ id: "v1", appId: "a1", volumeName: "uploads", filename: "f.tar.gz", app: { serverId: "s1" } });
    expect(await t.svc.sweepExpired()).toBe(1);
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(String(t.send.mock.calls[0][1])).toContain("mc rm");
    expect(t.prisma.backup.delete).toHaveBeenCalled();
    expect(t.prisma.volumeBackup.delete).toHaveBeenCalled();
    expect(t.state.snap).toMatchObject({ status: "EXPIRED", items: [] });
  });
  it("keeps the copy when an agent is offline, to try again", async () => {
    const t = make({ snap: old, send: jest.fn().mockRejectedValue(new Error("offline")) });
    (t.prisma.backup.findUnique as jest.Mock).mockResolvedValue({ id: "b1", databaseId: "db1", filename: "f", database: { serverId: "s1" } });
    (t.prisma.volumeBackup.findUnique as jest.Mock).mockResolvedValue({ id: "v1", appId: "a1", volumeName: "u", filename: "f", app: { serverId: "s1" } });
    expect(await t.svc.sweepExpired()).toBe(0);
    expect(t.state.snap!.status).toBe("SUCCESS");
  });
});
