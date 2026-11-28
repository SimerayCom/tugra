import { pinDatabaseBeforeStart } from "./exact-db-pin";

const D1 = `sha256:${"1".repeat(64)}`;
const REF = `postgres:16-alpine@${D1}`;

function make(over: { run?: unknown; task?: unknown; hints?: Array<{ runId: string; kind: string; value: string }>; db?: unknown; setImage?: jest.Mock } = {}) {
  const prisma = {
    migrationRun: { findUnique: jest.fn().mockResolvedValue("run" in over ? over.run : { id: "run1", promotedFromId: null }) },
    bulkTask: { findFirst: jest.fn().mockResolvedValue("task" in over ? over.task : { itemRef: "database:s:d1" }) },
    migrationRunHint: { findMany: jest.fn().mockResolvedValue(over.hints ?? [{ runId: "run1", kind: "exact-image", value: REF }]) },
    database: { findUnique: jest.fn().mockResolvedValue("db" in over ? over.db : { image: "postgres:16", status: "NEW" }) },
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
