import { assertSafeFlags, canonicalJson, checkKey, classifyDbTaskFailure, classifyTransferError, estimateEquals, estimateWindow, finalChecks, ASSUMED_BYTES_PER_SEC, migratorFlags, migratorWorkRemains, objectFinalChecks, objectSeedChecks, seedChecks, sha256Hex, subjectKey } from "./data-logic";
import { VX_409 } from "../../../importer/volume-stream/vx-constants";
import { DATA_CODES } from "./data-contract";
import { answered, copied, database, inspected, makeRun, makeSnap, volume, NOW } from "./testing/fakes";

const ids = (checks: Array<{ id: string }>) => checks.map((c) => c.id);
const by = <T extends { id: string }>(checks: T[], prefix: string): T[] => checks.filter((c) => c.id.startsWith(prefix));

describe("hashing helpers", () => {
  it("canonicalJson ignores key order and undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(canonicalJson({ a: [2, { c: undefined, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
  it("check keys are stable, short and unique per subject", () => {
    const long = `volume:${"x".repeat(200)}`;
    expect(checkKey("volume-parity", long).length).toBeLessThanOrEqual(80);
    expect(checkKey("volume-parity", long)).toBe(checkKey("volume-parity", long));
    expect(checkKey("volume-parity", "a")).not.toBe(checkKey("volume-parity", "b"));
    expect(checkKey("coverage", "")).toBe("coverage");
    expect(subjectKey("a")).toHaveLength(10);
    expect(sha256Hex("a")).toHaveLength(64);
  });
});

describe("classifyTransferError / classifyDbTaskFailure", () => {
  it("maps the importer's literals to fixed classes", () => {
    expect(classifyTransferError(null)).toBeNull();
    expect(classifyTransferError(VX_409.diverged)).toBe("diverged");
    expect(classifyTransferError(`error: ${VX_409.partLost}`)).toBe("diverged");
    expect(classifyTransferError(VX_409.destDirty)).toBe("dest-dirty");
    expect(classifyTransferError(VX_409.fingerprintChanged)).toBe("fingerprint-changed");
    expect(classifyTransferError(VX_409.diskInsufficient)).toBe("disk-insufficient");
    expect(classifyTransferError("aborted by the owner")).toBe("aborted");
    expect(classifyTransferError("something odd")).toBe("other");
  });
  it("classifies database task failures without surfacing the text", () => {
    expect(classifyDbTaskFailure(null)).toBe("restore-failed");
    expect(classifyDbTaskFailure("the staged artifact differs from the restored one")).toBe("restored-differs");
    expect(classifyDbTaskFailure("destination is dirty")).toBe("dest-dirty");
    expect(classifyDbTaskFailure("pg_restore exploded password=hunter2")).toBe("restore-failed");
  });
});

describe("seedChecks", () => {
  const run = makeRun();

  it("a volume nobody inspected is `unknown` (fails closed), a missing source is `fail`, an inspected one passes", () => {
    const snap = makeSnap({ volumes: [volume("volume:s:a:data"), inspected("volume:s:b:data"), volume("volume:s:c:data", { inventory: { found: false, rawBytes: 0, entries: 0, running: false, mountType: "volume" } })] });
    const c = seedChecks(run, snap, []);
    expect(by(c, checkKey("volume-inspected", "volume:s:a:data")).map((x) => x.status)).toEqual(["unknown"]);
    expect(by(c, checkKey("volume-inspected", "volume:s:b:data")).map((x) => x.status)).toEqual(["pass"]);
    const missing = by(c, checkKey("volume-inspected", "volume:s:c:data"))[0]
    expect(missing).toMatchObject({ status: "fail", code: DATA_CODES.seedVolumeMissing });
  });

  it("the disk verdict: ok passes, unknown/absent is unknown, not ok fails", () => {
    const snap = makeSnap({
      volumes: [
        inspected("volume:s:a:data", 1, 1, { disk: { ok: false, unknown: false } }),
        inspected("volume:s:b:data", 1, 1, { disk: { ok: true, unknown: true } }),
        inspected("volume:s:c:data", 1, 1, { disk: null }),
        inspected("volume:s:d:data"),
      ],
    });
    const c = seedChecks(run, snap, []);
    const disk = (ref: string) => by(c, checkKey("volume-disk", ref))[0]
    expect(disk("volume:s:a:data")).toMatchObject({ status: "fail", code: DATA_CODES.seedDiskInsufficient });
    expect(disk("volume:s:b:data").status).toBe("unknown");
    expect(disk("volume:s:c:data").status).toBe("unknown");
    expect(disk("volume:s:d:data").status).toBe("pass");
  });

  it("an excluded volume is a warning with operator-attested evidence, never a blocker", () => {
    const c = seedChecks(run, makeSnap({ volumes: [volume("volume:s:a:data", { excluded: true, state: "EXCLUDED" })] }), []);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ status: "warn", evidence: "operator-attested" });
  });

  it("Postgres physical-copy gates are evaluated at seed time, except `quiesced` (it fails until the freeze)", () => {
    const v = inspected("volume:s:db:data", 1, 1, {
      destType: "db-data",
      gates: [
        { id: "major", status: "fail" },
        { id: "image", status: "pass" },
        { id: "quiesced", status: "fail" },
      ],
    });
    const c = seedChecks(run, makeSnap({ volumes: [v] }), []);
    expect(by(c, "pg-gate-major")[0].status).toBe("fail");
    expect(by(c, "pg-gate-image")[0].status).toBe("pass");
    expect(by(c, "pg-gate-quiesced")).toHaveLength(0);
  });

  it("structural blockers: vx disabled with volumes, and the agent runner off the same host", () => {
    const snap = makeSnap({ vxEnabled: false, volumes: [inspected("volume:s:a:data")] });
    expect(ids(seedChecks(run, snap, []))).toContain("vx-disabled");
    expect(ids(seedChecks(makeRun({ options: { sourceRunner: "agent" }, topology: "two-box" }), makeSnap(), []))).toContain("agent-same-host");
    expect(ids(seedChecks(makeRun({ options: { sourceRunner: "agent" }, topology: "swap-proxy" }), makeSnap(), []))).not.toContain("agent-same-host");
    expect(ids(seedChecks(run, makeSnap({ vxEnabled: false }), []))).not.toContain("vx-disabled"); // nothing to stream
  });

  it("the warm database seed is only demanded when the option is on", () => {
    const snap = makeSnap({ databases: [database("database:s:a", { task: "none" }), database("database:s:b", { task: "done" }), database("database:s:u", { plane: "unsupported", engine: "MONGO" })] });
    expect(by(seedChecks(run, snap, []), "warm-db")).toHaveLength(0);
    const c = seedChecks(makeRun({ options: { warmDbSeed: true } }), snap, []);
    expect(by(c, checkKey("warm-db", "database:s:a"))[0].status).toBe("unknown");
    expect(by(c, checkKey("warm-db", "database:s:b"))[0].status).toBe("pass");
    expect(by(c, "warm-db")).toHaveLength(2); // the unsupported engine is not asked for
  });
});

describe("object checks", () => {
  const view = (status: string, bucketStatus: string, extra: Record<string, unknown> = {}) => ({
    id: "om1",
    status,
    phase: null,
    cancelRequested: false,
    blockers: 0,
    buckets: [{ srcBucket: "media", selected: true, status: bucketStatus, diffMissing: null, diffDiffer: null, diffExtra: null }],
    ...extra,
  });
  it("seed: seeded passes, active is unknown, idle-but-unseeded fails, no selection fails, blockers fail", () => {
    expect(objectSeedChecks([view("SEEDED", "SEEDED")]).map((c) => c.status)).toEqual(["pass"]);
    expect(objectSeedChecks([view("SEEDING", "SEEDING")]).map((c) => c.status)).toEqual(["unknown"]);
    expect(objectSeedChecks([view("PREFLIGHTED", "PENDING")]).map((c) => c.status)).toEqual(["fail"]);
    expect(objectSeedChecks([view("PREFLIGHTED", "PENDING", { buckets: [] })]).map((c) => c.status)).toEqual(["fail"]);
    const blocked = objectSeedChecks([view("PREFLIGHTED", "PENDING", { blockers: 2 })]);
    expect(blocked[0]).toMatchObject({ status: "fail", code: DATA_CODES.seedObjectBlocked });
  });
  it("final: only VERIFIED passes; DIFFERS fails with the counters", () => {
    expect(objectFinalChecks([view("DONE", "VERIFIED")]).map((c) => c.status)).toEqual(["pass"]);
    const d = objectFinalChecks([view("FINAL", "DIFFERS", { buckets: [{ srcBucket: "m", selected: true, status: "DIFFERS", diffMissing: 3, diffDiffer: 1, diffExtra: 0 }] })])[0];
    expect(d).toMatchObject({ status: "fail", code: DATA_CODES.finalObjectDiffers, params: { missing: 3, differ: 1, extra: 0 } });
    expect(objectFinalChecks([view("FINAL", "FINAL")]).map((c) => c.status)).toEqual(["fail"]);
    expect(objectFinalChecks([view("FINALIZING", "FINALIZING")]).map((c) => c.status)).toEqual(["unknown"]);
    expect(objectFinalChecks([view("DONE", "VERIFIED", { buckets: [{ srcBucket: "x", selected: false, status: "PENDING", diffMissing: null, diffDiffer: null, diffExtra: null }] })])).toEqual([]);
  });
});

describe("finalChecks", () => {
  const find = (snap: ReturnType<typeof makeSnap>, prefix: string) => by(finalChecks(snap, []), prefix);

  it("a restored database passes, a failed one fails with its class, a pending one is unknown, an unsupported engine only warns", () => {
    const snap = makeSnap({
      databases: [
        database("database:s:ok", { task: "done" }),
        database("database:s:bad", { task: "failed", taskFailure: "restored-differs" }),
        database("database:s:bad2", { task: "failed", taskFailure: "restore-failed" }),
        database("database:s:wait", { task: "running" }),
        database("database:s:mongo", { plane: "unsupported", engine: "MONGO", unsupportedReason: "no recipe" }),
        database("database:s:phys", { plane: "volume" }),
      ],
    });
    expect(find(snap, checkKey("db-restored", "database:s:ok"))[0].status).toBe("pass");
    expect(find(snap, checkKey("db-restored", "database:s:bad"))[0]).toMatchObject({ status: "fail", code: DATA_CODES.finalDbRestoredDiffers });
    expect(find(snap, checkKey("db-restored", "database:s:bad2"))[0]).toMatchObject({ status: "fail", code: DATA_CODES.finalDbFailed });
    expect(find(snap, checkKey("db-restored", "database:s:wait"))[0].status).toBe("unknown");
    expect(find(snap, checkKey("db-unsupported", "database:s:mongo"))[0].status).toBe("warn");
    expect(by(finalChecks(snap, []), "db-restored").length + by(finalChecks(snap, []), "db-unsupported").length).toBe(5); // the physical one has no logical row
  });

  it("a copied volume passes; entries that differ from the inspection fail (migrator-reported)", () => {
    const snap = makeSnap({ volumes: [copied("volume:s:ok:data", 10, 100), inspected("volume:s:diff:data", 10, 100, { state: "DONE", entries: 99 })] });
    expect(find(snap, checkKey("volume-copied", "volume:s:ok:data"))[0].status).toBe("pass");
    expect(find(snap, checkKey("volume-entries", "volume:s:diff:data"))[0]).toMatchObject({ status: "fail", code: DATA_CODES.finalEntriesMismatch, params: { inspected: 100, copied: 99 } });
  });

  it("failed transfers carry their class: diverged, destination dirty, other", () => {
    const f = (error: string) => makeSnap({ volumes: [volume("volume:s:a:data", { state: "FAILED", error })] });
    expect(find(f(VX_409.diverged), "volume-copied")[0].code).toBe(DATA_CODES.finalVolumeDiverged);
    expect(find(f(VX_409.destDirty), "volume-copied")[0].code).toBe(DATA_CODES.finalDestDirty);
    expect(find(f("boom"), "volume-copied")[0].code).toBe(DATA_CODES.finalVolumeFailed);
    expect(find(makeSnap({ volumes: [volume("volume:s:a:data", { state: "ABORTED" })] }), "volume-copied")[0].status).toBe("fail");
  });

  it("a volume still moving is unknown; every Postgres gate other than pass is reported", () => {
    const snap = makeSnap({ volumes: [volume("volume:s:a:data", { state: "COPYING", rawBytesDone: 5, rawBytesTotal: 10 })] });
    expect(find(snap, "volume-copied")[0]).toMatchObject({ status: "unknown", params: { state: "COPYING" } });
    const g = makeSnap({ volumes: [copied("volume:s:db:data")].map((v) => ({ ...v, destType: "db-data" as const, gates: [{ id: "quiesced", status: "fail" as const }, { id: "major", status: "pass" as const }] })) });
    expect(by(finalChecks(g, []), "pg-gate-quiesced")).toHaveLength(1);
    expect(by(finalChecks(g, []), "pg-gate-major")).toHaveLength(0);
  });

  it("migratorWorkRemains tracks logical databases and non-excluded volumes", () => {
    expect(migratorWorkRemains(makeSnap())).toBe(false);
    expect(migratorWorkRemains(makeSnap({ databases: [database("d", { task: "none" })] }))).toBe(true);
    expect(migratorWorkRemains(makeSnap({ databases: [database("d", { task: "done" }), database("u", { plane: "unsupported" }), database("p", { plane: "volume" })] }))).toBe(false);
    expect(migratorWorkRemains(makeSnap({ volumes: [copied("v")] }))).toBe(false);
    expect(migratorWorkRemains(makeSnap({ volumes: [inspected("v")] }))).toBe(true);
    expect(migratorWorkRemains(makeSnap({ volumes: [volume("v", { excluded: true, state: "EXCLUDED" })] }))).toBe(false);
  });
});

describe("estimateWindow", () => {
  it("is the copy time at the observed rate plus the extract time plus fixed overheads, with the basis shown", () => {
    const snap = makeSnap({ databases: [database("d1"), database("d2")], volumes: [inspected("v1", 30 * 1024 ** 3, 10, { bps: 100 * 1024 ** 2 })] });
    const e = estimateWindow(snap, NOW);
    const copy = Math.ceil((30 * 1024 ** 3) / (100 * 1024 ** 2));
    expect(e.freezeToFlipSec).toBe(copy + 15 * 60 + 2 * 60 + 120);
    expect(e.basis.map((b) => b.code)).toEqual(["data-seed.estimate.bytes", "data-seed.estimate.rate-observed", "data-seed.estimate.extract", "data-seed.estimate.databases"]);
    expect(e.estimatedAt).toBe(NOW.toISOString());
  });
  it("uses a conservative assumed rate when nothing was measured, and says so", () => {
    const e = estimateWindow(makeSnap({ volumes: [inspected("v1", 2 * 1024 ** 3)] }), NOW);
    expect(e.basis[1]).toMatchObject({ code: "data-seed.estimate.rate-assumed", params: { bytesPerSec: ASSUMED_BYTES_PER_SEC } });
    expect(e.freezeToFlipSec).toBeGreaterThan(0);
  });
  it("an unknown volume size makes the estimate unknown (null), never a guess", () => {
    expect(estimateWindow(makeSnap({ volumes: [volume("v1")] }), NOW).freezeToFlipSec).toBeNull();
    expect(estimateWindow(makeSnap(), NOW).freezeToFlipSec).toBe(120);
  });
  it("excluded volumes do not count, and estimateEquals ignores the timestamp", () => {
    const a = estimateWindow(makeSnap({ volumes: [inspected("v1", 1024 ** 3), volume("v2", { excluded: true, rawBytesTotal: 99 * 1024 ** 3 })] }), NOW);
    const b = estimateWindow(makeSnap({ volumes: [inspected("v1", 1024 ** 3)] }), new Date(NOW.getTime() + 60_000));
    expect(estimateEquals(a, b)).toBe(true);
    expect(estimateEquals(null, b)).toBe(false);
    expect(estimateEquals(a, estimateWindow(makeSnap({ volumes: [inspected("v1", 2 * 1024 ** 3)] }), NOW))).toBe(false);
  });
});

describe("migratorFlags", () => {
  const snap = makeSnap({ volumes: [inspected("v1")] });
  it("inspect and warm-db are read-only / databases-only", () => {
    expect(migratorFlags("inspect", makeRun(), snap)).toEqual(["--arms", "all", "--dry-run"]);
    expect(migratorFlags("warm-db", makeRun(), snap)).toEqual(["--arms", "databases"]);
  });
  it("final resyncs, verifies and follows the run's options", () => {
    expect(migratorFlags("final", makeRun(), snap)).toEqual(["--arms", "all", "--resync", "--verify", "--verify-mode", "estimate", "--hub-outage-wait", "30m"]);
    const f = migratorFlags("final", makeRun({ options: { stopSource: true, certs: "seed", rowCountMode: "exact" }, inputs: { allowBind: answered(true) } }), snap);
    expect(f).toEqual(expect.arrayContaining(["--verify-mode", "exact", "--stop-source", "--allow-bind", "--certs"]));
  });
  it("allow-bind needs the owner's yes AND a volume to copy; the default refuses", () => {
    expect(migratorFlags("final", makeRun({ inputs: { allowBind: answered(true) } }), makeSnap())).not.toContain("--allow-bind");
    expect(migratorFlags("final", makeRun({ inputs: { allowBind: answered("unknown" as never) } }), snap)).not.toContain("--allow-bind");
  });
  it("every flag word is charset-checked", () => {
    expect(() => assertSafeFlags(["--arms", "all"])).not.toThrow();
    for (const bad of ["--x;id", "a b", "$(x)", "`x`", "--x\n", ""]) expect(() => assertSafeFlags([bad])).toThrow();
  });
});
