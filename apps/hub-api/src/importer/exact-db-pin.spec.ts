import { EXACT_UNAPPLIED_CODE, pinDatabaseBeforeStart } from "./exact-db-pin";

const D1 = `sha256:${"1".repeat(64)}`;
const REF = `postgres:16-alpine@${D1}`;

function make(over: { run?: unknown; task?: unknown; hints?: Array<{ runId: string; kind: string; value: string }>; db?: unknown; setImage?: jest.Mock; inventories?: number; seen?: boolean } = {}) {
  const prisma = {
    migrationRun: { findUnique: jest.fn().mockResolvedValue("run" in over ? over.run : { id: "run1", promotedFromId: null }), update: jest.fn().mockResolvedValue({ eventSeq: 7 }) },
    migrationRunEvent: { findFirst: jest.fn().mockResolvedValue(over.seen ? { seq: 3 } : null), create: jest.fn().mockResolvedValue({}) },
    migrationRunHostReport: { count: jest.fn().mockResolvedValue(over.inventories ?? 0) },
    bulkTask: { findFirst: jest.fn().mockResolvedValue("task" in over ? over.task : { itemRef: "database:s:d1" }) },
    migrationRunHint: { findMany: jest.fn().mockResolvedValue(over.hints ?? [{ runId: "run1", kind: "exact-image", value: REF }]) },
    database: { findUnique: jest.fn().mockResolvedValue("db" in over ? over.db : { image: "postgres:16", status: "NEW", name: "orders" }) },
  };
  const databases = { setImage: over.setImage ?? jest.fn().mockResolvedValue({ changed: true }) };
  return { deps: { prisma, databases } as never, prisma, databases };
}

describe("pinDatabaseBeforeStart: the database keeps the image the source runs, written while it was never started", () => {
  it("writes the recorded exact image into a never-started database of that repository and says it changed it", async () => {
    const m = make();
    expect(await pinDatabaseBeforeStart(m.deps, "u1", "op1", "d1")).toBe(true);
    expect(m.databases.setImage).toHaveBeenCalledWith("u1", "d1", REF);
    expect(m.prisma.migrationRunHint.findMany.mock.calls[0][0].where).toMatchObject({ runId: { in: ["run1"] }, key: "database:s:d1", scope: "" });
  });
  it("reads the dry run the run was promoted from too, and the run's own hint wins", async () => {
    const own = `postgres:16-alpine@sha256:${"2".repeat(64)}`;
    const m = make({ run: { id: "run1", promotedFromId: "dry1" }, hints: [{ runId: "dry1", kind: "exact-image", value: REF }, { runId: "run1", kind: "exact-image", value: own }] });
    await pinDatabaseBeforeStart(m.deps, "u1", "op1", "d1");
    expect(m.prisma.migrationRunHint.findMany.mock.calls[0][0].where.runId).toEqual({ in: ["run1", "dry1"] });
    expect(m.databases.setImage).toHaveBeenCalledWith("u1", "d1", own);
  });
  it("the owner's unticked box wins; ticking it again in the run overrides the dry run's `off`", async () => {
    expect(await pinDatabaseBeforeStart(make({ hints: [{ runId: "run1", kind: "exact-image", value: REF }, { runId: "run1", kind: "exact-off", value: "off" }] }).deps, "u1", "op1", "d1")).toBe(false);
    const again = make({ run: { id: "run1", promotedFromId: "dry1" }, hints: [{ runId: "dry1", kind: "exact-image", value: REF }, { runId: "dry1", kind: "exact-off", value: "off" }, { runId: "run1", kind: "exact-off", value: "on" }] });
    expect(await pinDatabaseBeforeStart(again.deps, "u1", "op1", "d1")).toBe(true);
  });
  it("changes nothing for a started database, another repository, no recorded image, no run, no task", async () => {
    const started = make({ db: { image: "postgres:16", status: "RUNNING" } });
    expect(await pinDatabaseBeforeStart(started.deps, "u1", "op1", "d1")).toBe(false);
    expect(started.databases.setImage).not.toHaveBeenCalled();
    expect(await pinDatabaseBeforeStart(make({ db: { image: "mysql:8", status: "NEW" } }).deps, "u1", "op1", "d1")).toBe(false);
    expect(await pinDatabaseBeforeStart(make({ hints: [] }).deps, "u1", "op1", "d1")).toBe(false);
    expect(await pinDatabaseBeforeStart(make({ run: null }).deps, "u1", "op1", "d1")).toBe(false);
    expect(await pinDatabaseBeforeStart(make({ task: null }).deps, "u1", "op1", "d1")).toBe(false);
    expect(await pinDatabaseBeforeStart(make({ hints: [{ runId: "run1", kind: "exact-image", value: "x; id" }] }).deps, "u1", "op1", "d1")).toBe(false);
  });
  it("never fails the restore or the deploy that called it", async () => {
    const m = make({ setImage: jest.fn().mockRejectedValue(new Error("db down")) });
    await expect(pinDatabaseBeforeStart(m.deps, "u1", "op1", "d1")).resolves.toBe(false);
  });
});

describe("pinDatabaseBeforeStart: a database that starts on an image the source may not run is never silent", () => {
  const event = (m: ReturnType<typeof make>) => m.prisma.migrationRunEvent.create.mock.calls.map((c: [{ data: Record<string, unknown> }]) => c[0].data);

  it("no recorded image and no inventory yet: the run records a warning that names the database and why", async () => {
    const m = make({ hints: [] });
    expect(await pinDatabaseBeforeStart(m.deps, "u1", "op1", "d1")).toBe(false);
    expect(event(m)).toEqual([{ runId: "run1", seq: 7, stepKey: null, level: "warn", code: EXACT_UNAPPLIED_CODE, params: { kind: "database", name: "orders", itemRef: "database:s:d1", reason: "no-inventory" } }]);
  });
  it("an inventory arrived but reported no digest for it: the reason says so", async () => {
    const m = make({ hints: [], inventories: 1 });
    await pinDatabaseBeforeStart(m.deps, "u1", "op1", "d1");
    expect(event(m)[0]).toMatchObject({ params: { reason: "no-digest" } });
  });
  it("started before its pin arrived, a pin of another repository, and a failed write each say so and still never fail the start", async () => {
    const started = make({ db: { image: "postgres:16", status: "STOPPED", name: "orders" } });
    await expect(pinDatabaseBeforeStart(started.deps, "u1", "op1", "d1")).resolves.toBe(false);
    expect(event(started)[0]).toMatchObject({ params: { reason: "started", name: "orders" } });
    const other = make({ db: { image: "mysql:8", status: "NEW", name: "orders" } });
    await pinDatabaseBeforeStart(other.deps, "u1", "op1", "d1");
    expect(event(other)[0]).toMatchObject({ params: { reason: "other-repository" } });
    const failed = make({ setImage: jest.fn().mockRejectedValue(new Error("db down")) });
    await expect(pinDatabaseBeforeStart(failed.deps, "u1", "op1", "d1")).resolves.toBe(false);
    expect(event(failed)[0]).toMatchObject({ params: { reason: "write-failed" } });
  });
  it("says nothing when the record runs the image (pinned now, already, or the owner's own digest) or the owner unticked the box", async () => {
    const now = make();
    await pinDatabaseBeforeStart(now.deps, "u1", "op1", "d1");
    const already = make({ db: { image: REF, status: "RUNNING", name: "orders" } });
    await pinDatabaseBeforeStart(already.deps, "u1", "op1", "d1");
    const digest = make({ hints: [], db: { image: `postgres:16@${D1}`, status: "NEW", name: "orders" } });
    await pinDatabaseBeforeStart(digest.deps, "u1", "op1", "d1");
    const off = make({ hints: [{ runId: "run1", kind: "exact-off", value: "off" }], db: { image: "postgres:16", status: "NEW", name: "orders" } });
    await pinDatabaseBeforeStart(off.deps, "u1", "op1", "d1");
    for (const m of [now, already, digest, off]) expect(event(m)).toEqual([]);
  });
  it("one warning per database and reason, however many times the start is tried; a run it cannot write to is left alone", async () => {
    const m = make({ hints: [], seen: true });
    await pinDatabaseBeforeStart(m.deps, "u1", "op1", "d1");
    expect(event(m)).toEqual([]);
    const broken = make({ hints: [] });
    broken.prisma.migrationRunEvent.create.mockRejectedValue(new Error("down"));
    await expect(pinDatabaseBeforeStart(broken.deps, "u1", "op1", "d1")).resolves.toBe(false);
  });
});
