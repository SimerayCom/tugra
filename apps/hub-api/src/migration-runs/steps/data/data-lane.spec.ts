import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { DATA_CODES, type DbMeasureLite, type DataSnapshot } from "./data-contract";
import { DataSeedHandler } from "./data-seed.handler";
import { DataFinalHandler } from "./data-final.handler";
import {
  DEFAULT_STREAM_RESTORE_BYTES_PER_SEC,
  STREAM_RESTORE_BYTES_PER_SEC,
  dbLaneChecks,
  dbsNeedingMeasure,
  decideDbLane,
  decideLanes,
  estimateWindow,
  finalChecks,
  isMigratorDb,
  migratorWorkRemains,
  seedChecks,
} from "./data-logic";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { buildVerifySuite } from "./verify/verify-suite";
import { statsTimeoutMs } from "./adapters/db-stats.adapter";
import { SourceHostFake } from "./testing/source-host-fake";
import { BIG_MEASURE, FakeCaps, FakeDataPort, FakeObjectPort, SMALL_MEASURE, database, inspected, makeCtx, makeRun, makeSnap, volume, copied, NOW } from "./testing/fakes";
import { MemoryCheckStore } from "./verify/check-store";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const CAP = 256 * MiB;
const DB = "database:srv1:db-big";
const DUMP = "volume:srv1:db-big:dump";

const counted = (gz: number, raw = gz * 3): DbMeasureLite => ({ state: "measured", reason: null, dbBytes: raw * 2, dumpRawBytes: raw, dumpGzBytes: gz, measuredBy: "dump" });
const catalog = (dbBytes: number): DbMeasureLite => ({ state: "measured", reason: null, dbBytes, dumpRawBytes: null, dumpGzBytes: null, measuredBy: "catalog" });
const failedMeasure: DbMeasureLite = { state: "failed", reason: "size-exec", dbBytes: 0, dumpRawBytes: null, dumpGzBytes: null, measuredBy: "catalog" };

const input = (db: ReturnType<typeof database>, over: Partial<Parameters<typeof decideDbLane>[0]> = {}) => decideDbLane({ db, physical: null, largeDbMode: "stream-logical", capBytes: CAP, dumpEnabled: true, ...over });

describe("decideDbLane: only the DUMP size decides the cap", () => {
  it("a counted dump under the cap stays on the standard route, whatever the volume size (a volume a few MiB over the cap can dump under it)", () => {
    const d = database(DB, { measure: { ...counted(100 * MiB), dbBytes: 270 * MiB } }); // the volume is over 256 MiB, the dump (gzip) is not
    expect(input(d)).toMatchObject({ lane: "logical", reason: "small-dump", counted: true, gzBytes: 100 * MiB });
  });
  it("a counted dump over the cap goes to the stream lane when the owner allowed it, and is blocked (never silent) when not", () => {
    const d = database(DB, { measure: counted(300 * MiB) });
    expect(input(d)).toMatchObject({ lane: "stream", reason: "over-cap" });
    expect(input(d, { largeDbMode: "refuse" })).toMatchObject({ lane: "blocked", reason: "refused" });
  });
  it("the boundary is inclusive: exactly the cap fits, one byte more does not", () => {
    expect(input(database(DB, { measure: counted(CAP) })).lane).toBe("logical");
    expect(input(database(DB, { measure: counted(CAP + 1) })).lane).toBe("stream");
  });
  it("an uncounted database: certainly small is logical, anything bigger is treated as over the cap (the dump was not counted)", () => {
    expect(input(database(DB, { measure: catalog(10 * MiB) })).lane).toBe("logical");
    expect(input(database(DB, { measure: catalog(64 * MiB) })).lane).toBe("logical"); // a quarter of the cap
    expect(input(database(DB, { measure: catalog(65 * MiB) })).lane).toBe("stream");
    expect(input(database(DB, { measure: BIG_MEASURE })).lane).toBe("stream");
    expect(input(database(DB, { measure: BIG_MEASURE }), { largeDbMode: "refuse" })).toMatchObject({ lane: "blocked", reason: "refused" });
  });
  it("a database nobody measured is pending (nothing is decided on a guess); a failed measurement is pending with its own reason", () => {
    expect(input(database(DB, { measure: null }))).toMatchObject({ lane: "pending", reason: "unmeasured" });
    expect(input(database(DB, { measure: failedMeasure }))).toMatchObject({ lane: "pending", reason: "measure-failed" });
  });
  it("a hub with the lane switched off blocks a large database instead of failing later", () => {
    expect(input(database(DB, { measure: BIG_MEASURE }), { dumpEnabled: false })).toMatchObject({ lane: "blocked", reason: "stream-unavailable" });
    expect(input(database(DB, { measure: counted(1 * MiB) }), { dumpEnabled: false }).lane).toBe("logical"); // a small one never needed it
  });
  it("MariaDB and MySQL have the lane too (the 1.8 GB case); an engine without one keeps the standard route", () => {
    expect(input(database(DB, { engine: "MARIADB", measure: catalog(1.8 * GiB) })).lane).toBe("stream");
    expect(input(database(DB, { engine: "MYSQL", measure: counted(500 * MiB) })).lane).toBe("stream");
    expect(input(database(DB, { engine: "REDIS", measure: null }))).toMatchObject({ lane: "logical", reason: "engine-no-lane" });
  });
  it("a database already on the lane stays there (the choice is sticky once transfers exist)", () => {
    expect(input(database(DB, { plane: "stream", measure: counted(1 * MiB) }), { largeDbMode: "refuse" })).toMatchObject({ lane: "stream", reason: "sticky" });
  });
});

describe("decideDbLane: the physical copy (PG18 nested layout, an Alpine image under Tugra's Debian one)", () => {
  const physical = (gates: Array<{ id: string; status: "pass" | "fail" | "unknown" }>) => volume("volume:srv1:db-big:data", { destType: "db-data", ownerItemRef: DB, engine: "POSTGRES", gates });
  const pg = database(DB, { plane: "volume", measure: BIG_MEASURE });
  it("a physical copy whose gates pass (or are only unknown / quiesced) keeps its lane", () => {
    expect(input(pg, { physical: physical([{ id: "layout", status: "pass" }, { id: "quiesced", status: "fail" }, { id: "inventory", status: "unknown" }]) })).toMatchObject({ lane: "physical", reason: "physical-planned" });
  });
  it.each(["layout", "major", "image", "credentials"])("a failed %s gate falls back to the stream lane when allowed", (gate) => {
    expect(input(pg, { physical: physical([{ id: gate, status: "fail" }]) })).toMatchObject({ lane: "stream", reason: "physical-gate", gate });
  });
  it("the same failure without the owner's consent is a verdict naming the gate, not a silent switch", () => {
    expect(input(pg, { physical: physical([{ id: "layout", status: "fail" }]), largeDbMode: "refuse" })).toMatchObject({ lane: "blocked", reason: "refused", gate: "layout" });
  });
  it("a failed `state` gate is not something another lane can fix: the physical lane keeps it (the gate reports it)", () => {
    expect(input(pg, { physical: physical([{ id: "state", status: "fail" }]) }).lane).toBe("physical");
  });
  it("the fallback waits for the size when the database was never measured", () => {
    expect(input(database(DB, { plane: "volume", measure: null }), { physical: physical([{ id: "layout", status: "fail" }]) })).toMatchObject({ lane: "pending", reason: "unmeasured", gate: "layout" });
  });
});

describe("decideLanes / dbsNeedingMeasure / dbLaneChecks", () => {
  const snapWith = (...dbs: ReturnType<typeof database>[]) => makeSnap({ databases: dbs });
  const run = (mode?: "refuse" | "stream-logical") => makeRun({ options: mode ? { largeDbMode: mode } : {} });

  it("the run option defaults to refuse (fail closed): a large database is a blocker until the owner opts in", () => {
    const snap = snapWith(database(DB, { measure: BIG_MEASURE }));
    expect(decideLanes(run(), snap).get(DB)).toMatchObject({ lane: "blocked" });
    expect(decideLanes(run("stream-logical"), snap).get(DB)).toMatchObject({ lane: "stream" });
  });
  it("leaves out an unsupported database; includes a database already on the stream lane", () => {
    const snap = snapWith(database("database:s:x", { plane: "unsupported", measure: null }), database("database:s:y", { plane: "stream", engine: "MARIADB" }));
    expect([...decideLanes(run(), snap).keys()]).toEqual(["database:s:y"]);
  });
  it("only a dump-capable engine is ever asked to be measured; a physical copy that passes its gates is not", () => {
    const snap = snapWith(database("database:s:a", { measure: null }), database("database:s:b", { engine: "REDIS", measure: null }), database("database:s:c", { plane: "volume", measure: null }));
    expect(dbsNeedingMeasure(run(), snap).map((d) => d.itemRef)).toEqual(["database:s:a"]);
  });
  it("a failed measurement is re-asked only on an explicit retry (no relaunch loop)", () => {
    const snap = snapWith(database("database:s:a", { measure: failedMeasure }));
    expect(dbsNeedingMeasure(run(), snap)).toEqual([]);
    expect(dbsNeedingMeasure(run(), snap, true).map((d) => d.itemRef)).toEqual(["database:s:a"]);
  });
  it("the checks: pass for a lane, unknown for an unmeasured database, fail (with a code per reason) for a blocked one", () => {
    const snap = snapWith(database("database:s:ok", { measure: SMALL_MEASURE }), database("database:s:unm", { measure: null }), database("database:s:big", { measure: BIG_MEASURE }), database("database:s:bad", { measure: failedMeasure }));
    const checks = dbLaneChecks(run(), snap, CAP);
    const bySubject = Object.fromEntries(checks.map((c) => [c.subject, c]));
    expect(bySubject["database:s:ok"]).toMatchObject({ status: "pass", code: DATA_CODES.seedDbLane, params: { lane: "logical", engine: "POSTGRES", capBytes: CAP } });
    expect(bySubject["database:s:unm"]).toMatchObject({ status: "unknown", code: DATA_CODES.seedDbUnmeasured });
    expect(bySubject["database:s:bad"]).toMatchObject({ status: "fail", code: DATA_CODES.seedDbUnmeasured });
    expect(bySubject["database:s:big"]).toMatchObject({ status: "fail", code: DATA_CODES.seedDbOverCapRefused, params: { engine: "POSTGRES", capBytes: CAP } });
    expect(dbLaneChecks(run("stream-logical"), snap, CAP).find((c) => c.subject === "database:s:big")).toMatchObject({ status: "pass", params: { lane: "stream", reason: "uncounted-over-cap" } });
    for (const c of checks) expect(c.id.length).toBeLessThanOrEqual(80);
  });
  it("a hub without the lane names it; a refused physical fallback names the gate", () => {
    const off = makeSnap({ dumpEnabled: false, databases: [database(DB, { measure: BIG_MEASURE })] });
    expect(dbLaneChecks(run("stream-logical"), off, CAP)[0]).toMatchObject({ status: "fail", code: DATA_CODES.seedDbStreamUnavailable });
    const snap = makeSnap({ databases: [database(DB, { plane: "volume", measure: BIG_MEASURE })], volumes: [volume("volume:srv1:db-big:data", { destType: "db-data", ownerItemRef: DB, gates: [{ id: "layout", status: "fail" }] })] });
    expect(dbLaneChecks(run(), snap, CAP)[0]).toMatchObject({ status: "fail", code: DATA_CODES.seedDbPhysicalRefused, params: { gate: "layout" } });
  });
  it("seedChecks carries them (the gate blocks on a large database that has no lane)", () => {
    const snap = snapWith(database(DB, { measure: BIG_MEASURE }));
    expect(seedChecks(run(), snap, []).some((c) => c.code === DATA_CODES.seedDbOverCapRefused && c.status === "fail")).toBe(true);
  });
  it("isMigratorDb: logical and stream databases are the migrator's, a physical copy is not", () => {
    expect([isMigratorDb({ plane: "logical" }), isMigratorDb({ plane: "stream" }), isMigratorDb({ plane: "volume" }), isMigratorDb({ plane: "unsupported" })]).toEqual([true, true, false, false]);
  });
});

describe("estimateWindow: a streamed dump runs INSIDE the freeze and says so", () => {
  const dumpVol = (bytes: number, engine = "POSTGRES") => volume(DUMP, { destType: "db-dump", ownerItemRef: DB, engine, rawBytesTotal: bytes, inventory: { found: true, rawBytes: bytes, entries: 0, running: true, mountType: "volume" }, disk: { ok: true, unknown: false } });
  it("adds the transfer at the assumed rate and the restore at its own (slower) rate, and explains both", () => {
    const bytes = 30 * GiB;
    const e = estimateWindow(makeSnap({ volumes: [dumpVol(bytes)] }), NOW);
    const transfer = Math.ceil(bytes / (20 * MiB));
    const restore = Math.ceil(bytes / STREAM_RESTORE_BYTES_PER_SEC.POSTGRES);
    expect(e.freezeToFlipSec).toBe(transfer + restore + 120);
    const codes = e.basis.map((b) => b.code);
    expect(codes).toContain("data-seed.estimate.stream-databases");
    expect(codes).toContain("data-seed.estimate.stream-in-freeze");
    expect(e.basis.find((b) => b.code === "data-seed.estimate.stream-databases")!.params).toEqual({ count: 1, bytes, restoreSeconds: restore });
    // the dump is not counted as a tar (no extract allowance for it)
    expect(e.basis.find((b) => b.code === "data-seed.estimate.bytes")!.params).toMatchObject({ bytes: 0, volumes: 0 });
  });
  it("uses the measured relay rate for the transfer half, never for the restore half", () => {
    const fast = { ...dumpVol(10 * GiB), bps: 100 * MiB };
    const e = estimateWindow(makeSnap({ volumes: [fast] }), NOW);
    expect(e.freezeToFlipSec).toBe(Math.ceil((10 * GiB) / (100 * MiB)) + Math.ceil((10 * GiB) / STREAM_RESTORE_BYTES_PER_SEC.POSTGRES) + 120);
    expect(e.basis.map((b) => b.code)).toContain("data-seed.estimate.rate-observed");
  });
  it("MariaDB restores slower than Postgres; an unknown engine gets the conservative default", () => {
    const sec = (engine: string) => estimateWindow(makeSnap({ volumes: [dumpVol(2 * GiB, engine)] }), NOW).freezeToFlipSec!;
    expect(sec("MARIADB")).toBeGreaterThan(sec("POSTGRES"));
    expect(STREAM_RESTORE_BYTES_PER_SEC.MARIADB).toBe(DEFAULT_STREAM_RESTORE_BYTES_PER_SEC);
    expect(sec("SOMETHING")).toBe(sec("MARIADB"));
  });
  it("combines with files and the artifact route without double counting; unknown size is unknown", () => {
    const e = estimateWindow(makeSnap({ databases: [database("database:s:a")], volumes: [inspected("volume:s:a:data", 1 * GiB), dumpVol(1 * GiB)] }), NOW);
    expect(e.basis.find((b) => b.code === "data-seed.estimate.bytes")!.params).toMatchObject({ bytes: 1 * GiB, volumes: 1 });
    const unknown = volume(DUMP, { destType: "db-dump", ownerItemRef: DB, engine: "POSTGRES" });
    expect(estimateWindow(makeSnap({ volumes: [unknown] }), NOW).freezeToFlipSec).toBeNull();
  });
  it("no dump, no stream basis (the existing estimate is unchanged)", () => {
    const e = estimateWindow(makeSnap({ volumes: [inspected("volume:s:a:data")] }), NOW);
    expect(e.basis).toHaveLength(5); // bytes, hub bytes, rate, extract, databases: no stream rows
  });
});

describe("the DATA_FINAL checks of a streamed database", () => {
  const streamDb = (over = {}) => database(DB, { plane: "stream", measure: BIG_MEASURE, ...over });
  const dumpRow = (over = {}) => volume(DUMP, { destType: "db-dump", ownerItemRef: DB, engine: "POSTGRES", rawBytesTotal: 30 * GiB, inventory: { found: true, rawBytes: 30 * GiB, entries: 0, running: true, mountType: "volume" }, ...over });
  const snapOf = (v: ReturnType<typeof volume>) => makeSnap({ databases: [streamDb()], volumes: [v] });

  it("the database row has no evidence of its own; the dump row's transfer is its evidence", () => {
    const checks = finalChecks(snapOf(dumpRow({ state: "DONE", entries: 0, rawBytesDone: 30 * GiB })), []);
    expect(checks.filter((c) => c.subject === DB)).toEqual([]);
    expect(checks.find((c) => c.subject === DUMP)).toMatchObject({ status: "pass" });
  });
  it("a dump that is not DONE is unknown, a failed one fails with its class, a diverged one says so", () => {
    expect(finalChecks(snapOf(dumpRow({ state: "COPYING", rawBytesDone: 1 })), []).find((c) => c.subject === DUMP)).toMatchObject({ status: "unknown", code: DATA_CODES.finalVolumeNotDone });
    expect(finalChecks(snapOf(dumpRow({ state: "FAILED", error: "restoring the dump into the database failed" })), []).find((c) => c.subject === DUMP)).toMatchObject({ status: "fail", code: DATA_CODES.finalVolumeFailed });
    expect(finalChecks(snapOf(dumpRow({ state: "FAILED", error: "vx-fingerprint-changed" })), []).find((c) => c.subject === DUMP)).toMatchObject({ status: "fail" });
  });
  it("no entry comparison applies to a dump (entries are meaningless there)", () => {
    const c = finalChecks(snapOf(dumpRow({ state: "DONE", entries: 0, inventory: { found: true, rawBytes: 1, entries: 7, running: true, mountType: "volume" } })), []).find((x) => x.subject === DUMP)!;
    expect(c).toMatchObject({ status: "pass" });
  });
  it("the migrator still has work until the dump is DONE", () => {
    expect(migratorWorkRemains(snapOf(dumpRow({ state: "NONE" })), null)).toBe(true);
    expect(migratorWorkRemains(snapOf(dumpRow({ state: "DONE", entries: 0 })), null)).toBe(false);
  });
});

describe("VERIFY of a streamed database", () => {
  const runtime = { apps: [], databases: [], hosts: [], incomplete: [] };
  const flip = { planHash: "h", hosts: [], statefulHosts: [], unavailable: null };
  const base = { snap: makeSnap(), runtime, objects: [], sourceStats: new Map(), targetStats: new Map(), drift: "same" as const, flip };
  const stat = (rows: number) => ({ itemRef: DB, engine: "POSTGRES", kind: "tables" as const, mode: "exact" as const, state: "measured" as const, reason: null, tableCount: 1, truncated: false, tables: [{ name: "public.t", rows, estimated: false, expires: 0 }] });
  const dumpRow = volume(DUMP, { destType: "db-dump", ownerItemRef: DB, engine: "POSTGRES", state: "DONE", entries: 0, inventory: { found: true, rawBytes: 5, entries: 0, running: true, mountType: "volume" } });

  it("the dump transfer is hub-verified parity of the copy, and the rows are compared like any migrator-copied database", () => {
    const snap = makeSnap({ databases: [database(DB, { plane: "stream", task: "done" })], volumes: [dumpRow] });
    const suite = buildVerifySuite({ ...base, snap, sourceStats: new Map([[DB, stat(10)]]), targetStats: new Map([[DB, stat(10)]]) });
    expect(suite.find((c) => c.checkId === "volume-parity" && c.subject === DUMP)).toMatchObject({ status: "pass", evidence: "hub-verified" });
    expect(suite.find((c) => c.checkId === "db-logical-parity" && c.subject === DB)).toMatchObject({ status: "pass" });
    expect(suite.some((c) => c.checkId === "pg-physical")).toBe(false);
  });
  it("a missing source report is NOT waved through for a streamed database (unlike a stopped physical copy): it is unknown", () => {
    const snap = makeSnap({ databases: [database(DB, { plane: "stream", task: "done" })], volumes: [dumpRow] });
    const c = buildVerifySuite({ ...base, snap, targetStats: new Map([[DB, stat(10)]]) }).find((x) => x.checkId === "db-logical-parity")!;
    expect(c.status).not.toBe("pass");
    expect(c.status).not.toBe("warn");
  });
  it("fewer rows on the target is a loss and never passes", () => {
    const snap = makeSnap({ databases: [database(DB, { plane: "stream", task: "done" })], volumes: [dumpRow] });
    const c = buildVerifySuite({ ...base, snap, sourceStats: new Map([[DB, stat(10)]]), targetStats: new Map([[DB, stat(9)]]) }).find((x) => x.checkId === "db-logical-parity")!;
    expect(c.status).toBe("fail");
  });
  it("a dump that is not DONE fails the volume check", () => {
    const snap = makeSnap({ databases: [database(DB, { plane: "stream" })], volumes: [{ ...dumpRow, state: "APPLYING" }] });
    expect(buildVerifySuite({ ...base, snap }).find((c) => c.checkId === "volume-parity")).toMatchObject({ status: "fail" });
  });
});

describe("statsTimeoutMs: counting a huge table needs more than ten minutes", () => {
  it("ten minutes plus three per GiB of the measured database, capped at three hours", () => {
    expect(statsTimeoutMs({ measure: null })).toBe(10 * 60_000);
    expect(statsTimeoutMs({ measure: SMALL_MEASURE })).toBe(10 * 60_000 + 1 * 3 * 60_000);
    expect(statsTimeoutMs({ measure: { ...BIG_MEASURE, dbBytes: 32 * GiB } })).toBe(10 * 60_000 + 32 * 3 * 60_000);
    expect(statsTimeoutMs({ measure: { ...BIG_MEASURE, dbBytes: 5000 * GiB } })).toBe(3 * 3600_000);
    expect(statsTimeoutMs({ measure: failedMeasure })).toBe(10 * 60_000);
  });
});

// ───────────────────────────── the handlers ─────────────────────────────

function build(snap: DataSnapshot, mode?: "refuse" | "stream-logical") {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(snap);
  const objects = new FakeObjectPort();
  const host = new SourceHostFake({ containers: [] });
  const runner = new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs"));
  const seed = new DataSeedHandler(registry, data, objects, runner);
  seed.onModuleInit();
  const run = makeRun({ options: mode ? { largeDbMode: mode } : {} });
  const ctx = (extra: Partial<Parameters<typeof makeCtx>[0]> = {}) => makeCtx({ key: "DATA_SEED", run, ...extra });
  return { seed, data, ctx, run, registry, objects, runner };
}

describe("DataSeedHandler: the lane of every database", () => {
  const dumpRow = () => inspected(DUMP, 30 * GiB, 0, { destType: "db-dump", ownerItemRef: DB, engine: "POSTGRES" });

  it("puts a large database on the streamed lane (when the owner allowed it) and re-reads the world before doing anything else", async () => {
    const { seed, data, ctx } = build(makeSnap({ databases: [database(DB, { measure: BIG_MEASURE })], volumes: [] }), "stream-logical");
    const h = ctx();
    const obs = await seed.observe(h.ctx);
    const res = await seed.act(h.ctx, obs);
    expect(res).toEqual({ outcome: "continue", pollAfterMs: 1_000 });
    expect(data.streamed).toEqual([DB]);
    expect(h.events.some((e) => e.code === "data-seed.db-stream-enabled" && e.params?.engine === "POSTGRES")).toBe(true);
    // idempotent: the next tick (the snapshot now shows the lane) does not ask again
    const obs2 = await seed.observe(ctx().ctx);
    expect(data.snap.databases[0].plane).toBe("stream");
    await seed.act(ctx().ctx, obs2);
    expect(data.streamed).toEqual([DB]);
  });

  it("without the owner's consent nothing is switched; the gate says why", async () => {
    const { seed, data, ctx } = build(makeSnap({ databases: [database(DB, { measure: BIG_MEASURE })], volumes: [] }));
    const h = ctx();
    const obs = await seed.observe(h.ctx);
    const res = await seed.act(h.ctx, obs);
    expect(data.streamed).toEqual([]);
    expect(res).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.seedDbOverCapRefused } });
    expect(seed.postGate(h.ctx, obs).passed).toBe(false);
  });

  it("asks the operator for the inspect pass while a dump-capable database has no measurement, with --measure-dbs in the flags", async () => {
    const { seed, ctx } = build(makeSnap({ databases: [database(DB, { measure: null })], volumes: [] }), "stream-logical");
    const h = ctx();
    const obs = await seed.observe(h.ctx);
    const res = await seed.act(h.ctx, obs);
    expect(res).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: DATA_CODES.runMigrator, params: { phase: "inspect", flags: expect.arrayContaining(["--measure-dbs", "--dry-run"]) } } });
  });

  it("the gate passes once the large database is on the lane with its dump row inspected and its disk verdict in", async () => {
    const { seed, ctx } = build(makeSnap({ databases: [database(DB, { plane: "stream", measure: BIG_MEASURE })], volumes: [dumpRow()] }), "stream-logical");
    const h = ctx();
    const obs = await seed.observe(h.ctx);
    expect(seed.postGate(h.ctx, obs).passed).toBe(true);
    expect(await seed.act(h.ctx, obs)).toEqual({ outcome: "done" });
    const est = h.patches[0].windowEstimate as { basis: Array<{ code: string }> };
    expect(est.basis.map((b) => b.code)).toContain("data-seed.estimate.stream-in-freeze");
  });

  it("a physical copy that cannot run (PG18 layout) falls back to the stream lane, once, and only with consent", async () => {
    const snap = () =>
      makeSnap({ databases: [database(DB, { plane: "volume", measure: BIG_MEASURE })], volumes: [volume("volume:srv1:db-big:data", { destType: "db-data", ownerItemRef: DB, engine: "POSTGRES", inventory: { found: true, rawBytes: 1, entries: 1, running: true, mountType: "volume", pgLayout: "nested" }, disk: { ok: true, unknown: false }, gates: [{ id: "layout", status: "fail" }] })] });
    const yes = build(snap(), "stream-logical");
    const h = yes.ctx();
    expect(await yes.seed.act(h.ctx, await yes.seed.observe(h.ctx))).toEqual({ outcome: "continue", pollAfterMs: 1_000 });
    expect(yes.data.streamed).toEqual([DB]);
    const no = build(snap());
    const h2 = no.ctx();
    await no.seed.act(h2.ctx, await no.seed.observe(h2.ctx));
    expect(no.data.streamed).toEqual([]);
  });

  it("a refused switch (already restored by the artifact route, or the hub says no) is a retryable failure, not a pass", async () => {
    const { seed, data, ctx } = build(makeSnap({ databases: [database(DB, { measure: BIG_MEASURE })], volumes: [] }), "stream-logical");
    data.streamRefused = true;
    const h = ctx();
    const res = await seed.act(h.ctx, await seed.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "fail", code: DATA_CODES.seedDbStreamUnavailable, retryable: true });
  });

  it("the dry run projects each database's lane without touching anything", async () => {
    const { seed, data, ctx } = build(makeSnap({ databases: [database(DB, { measure: BIG_MEASURE }), database("database:s:small", { measure: SMALL_MEASURE })], volumes: [] }), "stream-logical");
    const items = await seed.dryRun(ctx({ run: makeRun({ dryRun: true, options: { largeDbMode: "stream-logical" } }) }).ctx);
    const lanes = items.filter((i) => i.code === "data-seed.dry.db-lane");
    expect(lanes.map((i) => [i.subject, i.params?.lane])).toEqual([[DB, "stream"], ["database:s:small", "logical"]]);
    expect(data.streamed).toEqual([]);
  });
});

describe("DataFinalHandler: the streamed database", () => {
  function buildFinal(snap: DataSnapshot) {
    const registry = new StepHandlerRegistryService();
    const data = new FakeDataPort(snap);
    const host = new SourceHostFake({ containers: [] });
    const caps = new FakeCaps();
    const runner = new MigratorRunner(host, data, caps, join(host.dir, "runs"));
    const checks = new MemoryCheckStore();
    const handler = new DataFinalHandler(registry, data, new FakeObjectPort(), caps, runner, checks);
    handler.onModuleInit();
    return { handler, data, checks };
  }
  const frozen = { FREEZE: { status: "PASSED" as const } };

  it("waits for the operator's migrator run while the dump is not DONE, and counts the dump row as an item of its own", async () => {
    const { handler } = buildFinal(makeSnap({ databases: [database(DB, { plane: "stream", measure: BIG_MEASURE })], volumes: [volume(DUMP, { destType: "db-dump", ownerItemRef: DB, engine: "POSTGRES", rawBytesTotal: 5 })] }));
    const h = makeCtx({ key: "DATA_FINAL", run: makeRun(), steps: frozen });
    const obs = await handler.observe(h.ctx);
    expect(obs.progress).toEqual({ done: 0, total: 1, unit: "item" });
    const res = await handler.act(h.ctx, obs);
    expect(res).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.runMigrator, params: { phase: "final", pending: 1 } } });
  });

  it("holds the wrap-up for the source-side verify report of a streamed database, like a logical one", async () => {
    const { handler } = buildFinal(makeSnap({ databases: [database(DB, { plane: "stream", task: "done", finishedAt: NOW.toISOString(), measure: BIG_MEASURE })], volumes: [copied(DUMP, 5, 0)].map((v) => ({ ...v, destType: "db-dump" as const, ownerItemRef: DB })) }));
    const h = makeCtx({ key: "DATA_FINAL", run: { ...makeRun(), freezeStartedAt: new Date(NOW.getTime() - 60_000) }, steps: frozen });
    const obs = await handler.observe(h.ctx);
    expect(obs.reportedStats.size).toBe(0);
    const res = await handler.act(h.ctx, obs);
    expect(res).toMatchObject({ outcome: "continue" }); // the report is still due: the token is not revoked under the migrator
  });
});
