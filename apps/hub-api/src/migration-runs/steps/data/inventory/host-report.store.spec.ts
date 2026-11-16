import { PrismaHostReportStore } from "./host-report.store";

type Row = { id: string; runId: string; stepKey: string; sourceServerRef: string; kind: string; state: string; payload: unknown; reportedAt: Date };

/** A minimal in-memory stand-in for the one Prisma delegate the store uses (upsert on the compound key, findMany, findUnique). */
function fakePrisma() {
  const rows: Row[] = [];
  let n = 0;
  const delegate = {
    findMany: jest.fn(async ({ where }: { where: { runId: string; kind?: string } }) => rows.filter((r) => r.runId === where.runId && (!where.kind || r.kind === where.kind))),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    upsert: jest.fn(async ({ where, create, update }: { where: { runId_stepKey_sourceServerRef_kind: { runId: string; stepKey: string; sourceServerRef: string; kind: string } }; create: Omit<Row, "id" | "reportedAt">; update: Partial<Row> }) => {
      const k = where.runId_stepKey_sourceServerRef_kind;
      const hit = rows.find((r) => r.runId === k.runId && r.stepKey === k.stepKey && r.sourceServerRef === k.sourceServerRef && r.kind === k.kind);
      if (hit) return Object.assign(hit, update);
      const row = { id: `r${++n}`, reportedAt: new Date(), ...create } as Row;
      rows.push(row);
      return row;
    }),
  };
  return { prisma: { migrationRunHostReport: delegate }, rows, delegate };
}

describe("PrismaHostReportStore", () => {
  it("keeps the LATEST report per (run, step, host, kind): a second put replaces the first", async () => {
    const { prisma, rows } = fakePrisma();
    const store = new PrismaHostReportStore(prisma as never);
    const first = await store.put({ runId: "run1", stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "launched", payload: { code: "started", rc: null } });
    const second = await store.put({ runId: "run1", stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "finished", payload: { code: "ok", rc: 0 } });
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(second).toMatchObject({ state: "finished", payload: { code: "ok", rc: 0 } });
    await store.put({ runId: "run1", stepKey: "FREEZE", sourceServerRef: "srv-a", kind: "freeze", state: "stopped", payload: {} });
    expect(rows).toHaveLength(2); // another step/kind is another row
  });

  it("lists by run (and kind), and `get` only returns a row that belongs to the run", async () => {
    const { prisma } = fakePrisma();
    const store = new PrismaHostReportStore(prisma as never);
    const a = await store.put({ runId: "run1", stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: { containers: [] } });
    await store.put({ runId: "run1", stepKey: "", sourceServerRef: "srv-a", kind: "reach", state: "ok", payload: { pingCode: 200 } });
    await store.put({ runId: "run2", stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: {} });
    expect((await store.list("run1")).map((r) => r.kind).sort()).toEqual(["inventory", "reach"]);
    expect((await store.list("run1", "inventory")).map((r) => r.id)).toEqual([a.id]);
    expect(await store.get("run1", a.id)).toMatchObject({ kind: "inventory", payload: { containers: [] } });
    expect(await store.get("run2", a.id)).toBeNull();
    expect(await store.get("run1", "missing")).toBeNull();
  });

  it("a stored payload that is not an object reads back as null, never as something the decoders would trip on", async () => {
    const { prisma, rows } = fakePrisma();
    const store = new PrismaHostReportStore(prisma as never);
    await store.put({ runId: "run1", stepKey: "", sourceServerRef: "srv-a", kind: "reach", state: "ok", payload: { a: 1 } });
    rows[0].payload = ["not", "an", "object"];
    expect((await store.list("run1"))[0].payload).toBeNull();
  });
});
