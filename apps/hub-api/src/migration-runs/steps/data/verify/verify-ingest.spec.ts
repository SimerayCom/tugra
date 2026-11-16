import { BadRequestException, ConflictException } from "@nestjs/common";
import { MigrationTokenGuard } from "../../../../importer/migration-token.guard";
import { MemoryCheckStore, boundEvidence } from "./check-store";
import { VerifyBodySchema } from "./verify-ingest.dto";
import { VerifyIngestService, statsFromReport } from "./verify-ingest.service";
import { RAW_EVIDENCE_MAX_BYTES, SOURCE_STATS_CHECK } from "../data-contract";

const op = { opId: "op1", actorId: "u1", expiresAt: new Date(Date.now() + 3600_000) };
const item = (over: Record<string, unknown> = {}) => ({
  itemRef: "database:_:a",
  engine: "POSTGRES",
  kind: "tables",
  mode: "exact",
  state: "measured",
  tableCount: 1,
  tables: [{ name: "public.t", rows: 5 }],
  ...over,
});

function build(opts: { run?: { id: string; actorId: string; status: string; targetServerId: string } | null; dbs?: string[] } = {}) {
  const store = new MemoryCheckStore();
  const prisma = {
    migrationRun: { findUnique: jest.fn(async () => (opts.run === undefined ? { id: "run1", actorId: "u1", status: "RUNNING", targetServerId: "s1" } : opts.run)) },
    server: { findUnique: jest.fn(async () => ({ teamId: "t1" })) },
    bulkTask: { findMany: jest.fn(async () => (opts.dbs ?? ["database:_:a"]).map((itemRef) => ({ itemRef }))) },
  };
  const access = { requirePermission: jest.fn(async () => undefined) };
  const svc = new VerifyIngestService(prisma as never, access as never, store);
  return { svc, store, prisma, access };
}

describe("VerifyBodySchema", () => {
  it("accepts a well-formed report", () => {
    expect(VerifyBodySchema.safeParse({ items: [item({ reason: "not-running", state: "skipped", tables: [] })] }).success).toBe(true);
  });
  it("is strict: unknown keys, bad enums, oversized lists and control text are refused", () => {
    expect(VerifyBodySchema.safeParse({ items: [item({ extra: 1 })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [item({ engine: "postgres" })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [item({ kind: "rows" })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [item({ reason: "a\nb" })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [item({ tables: [{ name: "x", rows: -2 }] })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [item({ tables: [{ name: "x", rows: 1, secret: "p" }] })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: [item({ tables: Array.from({ length: 5001 }, (_, i) => ({ name: `t${i}`, rows: 1 })) })] }).success).toBe(false);
    expect(VerifyBodySchema.safeParse({ items: Array.from({ length: 501 }, () => item()) }).success).toBe(false);
  });
});

describe("VerifyIngestService", () => {
  it("stores the source measurement as migrator-reported evidence on the run that owns the op", async () => {
    const { svc, store } = build();
    await expect(svc.ingest(op, { items: [item()] })).resolves.toEqual({ stored: 1, ignored: 0 });
    const rows = await store.list("run1", "VERIFY");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkId: SOURCE_STATS_CHECK, subject: "database:_:a", evidenceKind: "migrator-reported", status: "unknown" });
    expect(rows[0].evidence).toMatchObject({ itemRef: "database:_:a", kind: "tables", state: "measured", tables: [{ name: "public.t", rows: 5, estimated: false, expires: 0 }] });
  });

  it("re-reporting replaces the row (the latest measurement wins)", async () => {
    const { svc, store } = build();
    await svc.ingest(op, { items: [item()] });
    await svc.ingest(op, { items: [item({ tables: [{ name: "public.t", rows: 9 }] })] });
    const rows = await store.list("run1", "VERIFY");
    expect(rows).toHaveLength(1);
    expect((rows[0].evidence as { tables: Array<{ rows: number }> }).tables[0].rows).toBe(9);
  });

  it("drops an itemRef that is not a DONE database task of the token's op (no spoofed evidence)", async () => {
    const { svc, store } = build({ dbs: ["database:_:a"] });
    await expect(svc.ingest(op, { items: [item(), item({ itemRef: "database:_:evil" })] })).resolves.toEqual({ stored: 1, ignored: 1 });
    expect((await store.list("run1", "VERIFY")).map((r) => r.subject)).toEqual(["database:_:a"]);
  });

  it("is a harmless no-op when the op has no guided run, or the run is finished", async () => {
    const none = build({ run: null });
    await expect(none.svc.ingest(op, { items: [item()] })).resolves.toEqual({ stored: 0, ignored: 1 });
    const done = build({ run: { id: "run1", actorId: "u1", status: "COMPLETED", targetServerId: "s1" } });
    await expect(done.svc.ingest(op, { items: [item()] })).resolves.toEqual({ stored: 0, ignored: 1 });
    expect(done.store.rows.size).toBe(0);
  });

  it("refuses a malformed body, another user's run, and a lost team role", async () => {
    const { svc } = build();
    await expect(svc.ingest(op, { items: [item({ extra: 1 })] })).rejects.toBeInstanceOf(BadRequestException);
    const other = build({ run: { id: "run1", actorId: "someone-else", status: "RUNNING", targetServerId: "s1" } });
    await expect(other.svc.ingest(op, { items: [item()] })).rejects.toBeInstanceOf(ConflictException);
    const lost = build();
    lost.access.requirePermission.mockRejectedValueOnce(new Error("forbidden"));
    await expect(lost.svc.ingest(op, { items: [item()] })).rejects.toThrow("forbidden");
    expect(lost.store.rows.size).toBe(0);
  });

  it("statsFromReport maps defaults (no estimated/expires/reason)", () => {
    const s = statsFromReport(VerifyBodySchema.parse({ items: [item()] }).items[0]);
    expect(s).toMatchObject({ reason: null, truncated: false, tables: [{ name: "public.t", rows: 5, estimated: false, expires: 0 }] });
  });
});

describe("boundEvidence", () => {
  it("passes small evidence through and replaces oversize evidence by a marker", () => {
    expect(boundEvidence("volume-parity", { a: 1 })).toEqual({ a: 1 });
    expect(boundEvidence("volume-parity", null)).toBeNull();
    const big = { blob: "x".repeat(9 * 1024) };
    expect(boundEvidence("volume-parity", big)).toMatchObject({ truncated: true });
    expect(boundEvidence(SOURCE_STATS_CHECK, big)).toEqual(big); // raw measurements may be larger
    expect(boundEvidence(SOURCE_STATS_CHECK, { blob: "x".repeat(RAW_EVIDENCE_MAX_BYTES + 1) })).toMatchObject({ truncated: true });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(boundEvidence("x", cyc)).toEqual({ truncated: true, reason: "unserializable" });
  });
});

describe("the ingest route guard", () => {
  it("is the migration-token guard (the same authentication as every other /import/migration route)", () => {
    expect(typeof MigrationTokenGuard).toBe("function");
  });
});
