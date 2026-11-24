import { dumpDiskVerdict, dumpRawEstimate, dumpStagedBytes, dumpRestoreTimeoutMs, dumpWasCounted } from "./vx-dump";
import { diskShortfall } from "./vx-dump";
import { artifactCapBytes, isStreamDumpEngine, vxDumpCapIsOperatorSet, vxDumpEnabled, vxMaxDumpBytes } from "./vx-constants";
import { dbStreamModeRefs, buildVolumeTargets } from "./vx-targets";
import { VxDbSizesBodySchema } from "./vx.dto";

const GiB = 1024 ** 3;

describe("dumpRawEstimate / dumpWasCounted", () => {
  it("is the counted dump, else the catalog size, else null (only a measured entry counts)", () => {
    expect(dumpRawEstimate({ state: "measured", dbBytes: 100, dumpRawBytes: 40 })).toBe(40);
    expect(dumpRawEstimate({ state: "measured", dbBytes: 100 })).toBe(100);
    expect(dumpRawEstimate({ state: "failed", dbBytes: 0 })).toBeNull();
    expect(dumpRawEstimate({ state: "skipped", dbBytes: 9 })).toBeNull();
    expect(dumpRawEstimate(undefined)).toBeNull();
    expect(dumpWasCounted({ state: "measured", dumpRawBytes: 0 })).toBe(true);
    expect(dumpWasCounted({ state: "measured" })).toBe(false);
    expect(dumpWasCounted({ state: "failed", dumpRawBytes: 3 })).toBe(false);
  });
});

describe("dumpDiskVerdict", () => {
  const base = { rawDumpBytes: 30 * GiB, dbBytes: 32 * GiB, targetStagingFreeBytes: 500 * GiB, targetDockerFreeBytes: 500 * GiB, targetSameDevice: true };
  it("needs the staged parts (the raw size while the gzip size is unknown, never the decoded dump) plus the restored database", () => {
    const v = dumpDiskVerdict(base);
    expect(v.ok).toBe(true);
    expect(v.details).toMatchObject({ lane: "dump", stagedBytes: 30 * GiB, databaseBytes: Math.ceil(32 * GiB * 1.1 + GiB) });
    const staged = 30 * GiB;
    const db = Math.ceil(32 * GiB * 1.1 + GiB);
    expect(dumpDiskVerdict({ ...base, targetStagingFreeBytes: staged + db - 1 }).ok).toBe(false); // one filesystem: both add up
    expect(dumpDiskVerdict({ ...base, targetStagingFreeBytes: staged + db }).ok).toBe(true);
  });
  it("an incompressible dump cannot slip past the check: without a counted gzip size the staged parts are budgeted at the raw size", () => {
    const stagingOnly = { ...base, targetSameDevice: false, targetDockerFreeBytes: 500 * GiB };
    expect(dumpDiskVerdict({ ...stagingOnly, targetStagingFreeBytes: 20 * GiB }).ok).toBe(false); // 0.6x would have been 18 GiB
    expect(dumpDiskVerdict({ ...stagingOnly, targetStagingFreeBytes: 30 * GiB }).ok).toBe(true);
  });
  it("a COUNTED dump is budgeted at its real gzip size plus 5%, whatever its raw size", () => {
    const counted = { ...base, targetSameDevice: false, targetDockerFreeBytes: 500 * GiB, countedGzBytes: 29 * GiB };
    const need = Math.ceil(29 * GiB * 1.05);
    expect(dumpDiskVerdict({ ...counted, targetStagingFreeBytes: need - 1 })).toMatchObject({ ok: false, details: { stagedBytes: need } });
    expect(dumpDiskVerdict({ ...counted, targetStagingFreeBytes: need }).ok).toBe(true);
    const small = { ...counted, countedGzBytes: 3 * GiB, targetStagingFreeBytes: 4 * GiB };
    expect(dumpDiskVerdict(small).ok).toBe(true); // a well-compressed dump needs far less than its raw size
    expect(dumpStagedBytes(100, 0)).toBe(0);
    expect(dumpStagedBytes(100, null)).toBe(100);
    expect(dumpStagedBytes(100)).toBe(100);
  });
  it("on separate filesystems staging and the docker root are judged on their own", () => {
    const sep = { ...base, targetSameDevice: false };
    expect(dumpDiskVerdict({ ...sep, targetStagingFreeBytes: 30 * GiB, targetDockerFreeBytes: Math.ceil(32 * GiB * 1.1 + GiB) }).ok).toBe(true);
    expect(dumpDiskVerdict({ ...sep, targetDockerFreeBytes: 10 * GiB }).ok).toBe(false);
    expect(dumpDiskVerdict({ ...sep, targetStagingFreeBytes: 1 * GiB }).ok).toBe(false);
  });
  it("an unreadable probe is unknown, never ok (fail closed)", () => {
    expect(dumpDiskVerdict({ ...base, targetStagingFreeBytes: null })).toMatchObject({ ok: false, unknown: true });
    expect(dumpDiskVerdict({ ...base, targetDockerFreeBytes: null })).toMatchObject({ ok: false, unknown: true });
  });
  it("a database bigger than its dump is what the target has to hold", () => {
    expect(dumpDiskVerdict({ ...base, rawDumpBytes: 1 * GiB, dbBytes: 40 * GiB, targetStagingFreeBytes: 20 * GiB, targetSameDevice: false, targetDockerFreeBytes: 20 * GiB }).ok).toBe(false);
  });
});

describe("dumpRestoreTimeoutMs", () => {
  it("is a floor plus a generous allowance per GiB, at most a day", () => {
    expect(dumpRestoreTimeoutMs(0)).toBe(15 * 60_000);
    expect(dumpRestoreTimeoutMs(30 * GiB)).toBe(15 * 60_000 + 30 * 6 * 60_000);
    expect(dumpRestoreTimeoutMs(10_000 * GiB)).toBe(24 * 3600_000);
  });
});

describe("constants", () => {
  afterEach(() => {
    delete process.env.MIGRATION_VX_DUMP_ENABLED;
    delete process.env.MIGRATION_VX_ENABLED;
    delete process.env.MIGRATION_VX_MAX_DUMP_BYTES;
    delete process.env.MIGRATION_MAX_ARTIFACT_BYTES;
  });
  it("the artifact cap is the importer's 256 MiB unless configured (the one the route enforces)", () => {
    expect(artifactCapBytes()).toBe(256 * 1024 ** 2);
    process.env.MIGRATION_MAX_ARTIFACT_BYTES = "1000";
    expect(artifactCapBytes()).toBe(1000);
    process.env.MIGRATION_MAX_ARTIFACT_BYTES = "garbage";
    expect(artifactCapBytes()).toBe(256 * 1024 ** 2);
  });
  it("the dump has no size cap unless the operator sets one: the structural bound (parts x part size) is the only limit", () => {
    const structural = 100_000 * 128 * 1024 ** 2;
    expect(vxMaxDumpBytes()).toBe(structural);
    expect(vxDumpCapIsOperatorSet()).toBe(false);
    process.env.MIGRATION_VX_MAX_DUMP_BYTES = "5";
    expect(vxMaxDumpBytes()).toBe(1 * GiB);
    expect(vxDumpCapIsOperatorSet()).toBe(true);
    process.env.MIGRATION_VX_MAX_DUMP_BYTES = String(500 * GiB);
    expect(vxMaxDumpBytes()).toBe(500 * GiB);
    process.env.MIGRATION_VX_MAX_DUMP_BYTES = String(99999 * 1024 * GiB);
    expect(vxMaxDumpBytes()).toBe(structural);
    expect(vxDumpCapIsOperatorSet()).toBe(false);
    process.env.MIGRATION_VX_MAX_DUMP_BYTES = "garbage";
    expect(vxMaxDumpBytes()).toBe(structural);
  });
  it("the lane has its own kill switch, and follows the volume stream's", () => {
    expect(vxDumpEnabled()).toBe(true);
    process.env.MIGRATION_VX_DUMP_ENABLED = "no";
    expect(vxDumpEnabled()).toBe(false);
    delete process.env.MIGRATION_VX_DUMP_ENABLED;
    process.env.MIGRATION_VX_ENABLED = "false";
    expect(vxDumpEnabled()).toBe(false);
  });
  it("only the engines with a pinned dump recipe are lane engines", () => {
    for (const e of ["POSTGRES", "MARIADB", "MYSQL"]) expect(isStreamDumpEngine(e)).toBe(true);
    for (const e of ["REDIS", "MONGO", "CLICKHOUSE", "KEYDB", "DRAGONFLY", "LIBSQL", "", "postgres"]) expect(isStreamDumpEngine(e)).toBe(false);
  });
});

describe("dbStreamModeRefs / buildVolumeTargets", () => {
  it("reads well-formed database itemRefs from meta.vxStream and nothing else", () => {
    expect([...dbStreamModeRefs({ vxStream: { "database:s:a": {}, "database:s:b": {}, "app:s:c": {}, "database:bad ref:x": {} } })].sort()).toEqual(["database:s:a", "database:s:b"]);
    expect(dbStreamModeRefs(undefined).size).toBe(0);
    expect(dbStreamModeRefs({ vxStream: [] }).size).toBe(0);
    expect(dbStreamModeRefs({ vxStream: "x" }).size).toBe(0);
  });
  it("a stream database yields one db-dump target for any dump engine, none for another engine, and never a db-data target", () => {
    const task = (ref: string, id: string) => ({ itemRef: ref, kind: "database", status: "DONE", resourceType: "database", resourceId: id, result: null });
    const out = buildVolumeTargets({
      tasks: [task("database:s:pg", "1"), task("database:s:my", "2"), task("database:s:rd", "3")],
      dbs: new Map([
        ["1", { id: "1", engine: "POSTGRES", version: "18", image: "postgres:18-alpine" }],
        ["2", { id: "2", engine: "MARIADB", version: "11", image: "mariadb:11" }],
        ["3", { id: "3", engine: "REDIS", version: "7", image: "redis:7" }],
      ]),
      dbVolumeRefs: new Set(["database:s:pg", "database:s:rd"]),
      dbStreamRefs: new Set(["database:s:pg", "database:s:my", "database:s:rd"]),
    });
    expect(out.map((t) => [t.itemRef, t.destType, t.engine])).toEqual([
      ["volume:s:my:dump", "db-dump", "MARIADB"],
      ["volume:s:pg:dump", "db-dump", "POSTGRES"],
    ]);
  });
});

describe("VxDbSizesBodySchema", () => {
  const ok = { runId: "run_abcdef12", items: [{ itemRef: "database:s:a", engine: "POSTGRES", state: "measured", dbBytes: 5, measuredBy: "catalog" }] };
  it("accepts a well-formed report and refuses anything loose (strict, bounded)", () => {
    expect(VxDbSizesBodySchema.safeParse(ok).success).toBe(true);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: [] }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: [{ ...ok.items[0], engine: "REDIS" }] }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: [{ ...ok.items[0], itemRef: "volume:s:a:data" }] }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: [{ ...ok.items[0], dbBytes: -1 }] }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: [{ ...ok.items[0], note: "x" }] }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: [{ ...ok.items[0], reason: "bad\nline" }] }).success).toBe(false);
    expect(VxDbSizesBodySchema.safeParse({ ...ok, items: Array.from({ length: 501 }, () => ok.items[0]) }).success).toBe(false);
  });
});

describe("diskShortfall: the tightest place and what it has", () => {
  const MiB = 1024 ** 2;
  it("a dump on one disk needs the staged parts plus the restored database, and is judged against the staging free space", () => {
    expect(diskShortfall({ lane: "dump", stagedBytes: 10 * GiB, databaseBytes: 30 * GiB, targetStagingFreeBytes: 20 * GiB, targetDockerFreeBytes: 20 * GiB, targetSameDevice: true })).toEqual({ needBytes: 40 * GiB, freeBytes: 20 * GiB });
  });
  it("a dump on two disks names the disk that is short: staging first, then the docker root", () => {
    const base = { lane: "dump", stagedBytes: 10 * GiB, databaseBytes: 30 * GiB, targetSameDevice: false };
    expect(diskShortfall({ ...base, targetStagingFreeBytes: 5 * GiB, targetDockerFreeBytes: 100 * GiB })).toEqual({ needBytes: 10 * GiB, freeBytes: 5 * GiB });
    expect(diskShortfall({ ...base, targetStagingFreeBytes: 50 * GiB, targetDockerFreeBytes: 20 * GiB })).toEqual({ needBytes: 30 * GiB, freeBytes: 20 * GiB });
  });
  it("a volume copy uses the same rule as the app move check", () => {
    expect(diskShortfall({ totalBytes: 10 * GiB, targetStagingFreeBytes: 1 * GiB, targetDockerFreeBytes: 100 * GiB, targetSameDevice: false })).toEqual({ needBytes: Math.ceil(1.02 * 10 * GiB + 512 * MiB), freeBytes: 1 * GiB });
    expect(diskShortfall({ totalBytes: 10 * GiB, targetStagingFreeBytes: 5 * GiB, targetDockerFreeBytes: 100 * GiB, targetSameDevice: true })).toEqual({ needBytes: Math.ceil(2.05 * 10 * GiB + GiB), freeBytes: 5 * GiB });
  });
  it("is null when the disk could not be read", () => {
    expect(diskShortfall(null)).toBeNull();
    expect(diskShortfall({ lane: "dump", stagedBytes: 1, databaseBytes: 1, targetStagingFreeBytes: null, targetDockerFreeBytes: 5, targetSameDevice: false })).toBeNull();
  });
});
