import { buildVolumeTargets, dbVolumeModeRefs, parseVolumeItemRef, pgMajorOf, volumeItemRef } from "./vx-targets";
import { evaluateDbGates, firstBlockingGate, GATE_TEXT } from "./vx-gates";
import { buildVolumeView, etaSeconds } from "./vx-view";
import { VxBeginBodySchema, VxFinishBodySchema, VxInventoryBodySchema, VxPartBodySchema } from "./vx.dto";
import { vxEnabled, vxMaxBytes, vxPartRawBytes, vxMaxParts, vxStaleMs, migrationRelayConcurrency, tokenMaxLifeMs } from "./vx-constants";
import { APP_REF, APP_VOL_REF, DB_ID, DB_REF, DB_VOL_REF, RUN, appTask, dbTask, sha, target } from "./testing/vx-fixtures";

describe("volume itemRefs", () => {
  it("builds and parses volume:<serverRef|_>:<sourceRef>:<volName>", () => {
    expect(volumeItemRef(APP_REF, "data")).toBe(APP_VOL_REF);
    expect(volumeItemRef("app:_:abc", "x-1")).toBe("volume:_:abc:x-1");
    expect(parseVolumeItemRef(APP_VOL_REF)).toEqual({ serverRef: "srv1", sourceRef: "5f3a9c", volName: "data", appItemRef: APP_REF, databaseItemRef: "database:srv1:5f3a9c" });
  });
  it("rejects anything that is not exactly that shape (traversal, colons, uppercase volume names, shell text)", () => {
    for (const bad of ["volume:s:a:b:c", "volume:s:a", "app:s:a:data", "volume:s:../x:data", "volume:s:a:DATA", "volume:s:a;rm:data", "volume::a:data", "volume:s:-a:data"]) expect(parseVolumeItemRef(bad)).toBeNull();
    expect(volumeItemRef("app:srv1", "data")).toBeNull();
    expect(volumeItemRef("app:srv1:a:b", "data")).toBeNull();
    expect(volumeItemRef("app:srv1:a b", "data")).toBeNull();
  });
});

describe("buildVolumeTargets", () => {
  const dbs = new Map([[DB_ID, { id: DB_ID, engine: "POSTGRES", version: "16", image: "postgres:16-alpine" }]]);
  it("lists each declared app volume and (only in volume mode) a Postgres data volume, sorted", () => {
    const t = buildVolumeTargets({ tasks: [dbTask(), appTask()], dbs, dbVolumeRefs: new Set([DB_REF]) });
    expect(t.map((x) => x.itemRef)).toEqual([APP_VOL_REF, DB_VOL_REF]);
    expect(t[1]).toMatchObject({ destType: "db-data", name: "data", mountPath: "/var/lib/postgresql/data", engine: "POSTGRES", engineVersion: "16", sourceImage: "postgres:16-alpine", databaseItemRef: DB_REF });
    expect(buildVolumeTargets({ tasks: [dbTask(), appTask()], dbs, dbVolumeRefs: new Set() }).map((x) => x.itemRef)).toEqual([APP_VOL_REF]);
  });
  it("skips a failed volume declaration, a non-DONE task and a non-Postgres database", () => {
    const failed = appTask({ result: { volumes: { mounts: [{ path: "/x", name: "data" }], declared: 0, error: "boom" } } });
    expect(buildVolumeTargets({ tasks: [failed, appTask({ status: "FAILED" })], dbs, dbVolumeRefs: new Set() })).toEqual([]);
    const maria = new Map([[DB_ID, { id: DB_ID, engine: "MARIADB", version: "11", image: "mariadb:11" }]]);
    expect(buildVolumeTargets({ tasks: [dbTask()], dbs: maria, dbVolumeRefs: new Set([DB_REF]) })).toEqual([]);
  });
  it("marks an explicit exclusion on the target", () => {
    const t = buildVolumeTargets({ tasks: [appTask()], dbs, dbVolumeRefs: new Set(), excluded: { [APP_VOL_REF]: { reason: "signoz", at: "x", by: "u" } } });
    expect(t[0].excluded).toEqual({ reason: "signoz", at: "x", by: "u" });
  });
  it("dbVolumeModeRefs reads proposed.dataMode === 'volume' only", () => {
    expect([...dbVolumeModeRefs([{ itemRef: DB_REF, kind: "database", proposed: { dataMode: "volume" } }, { itemRef: "database:s:x", kind: "database", proposed: { dataMode: "dump" } }, { itemRef: "app:s:y", kind: "app", proposed: { dataMode: "volume" } }])]).toEqual([DB_REF]);
    expect(dbVolumeModeRefs(undefined).size).toBe(0);
  });
  it("pgMajorOf", () => {
    expect([pgMajorOf("16"), pgMajorOf("16.4"), pgMajorOf("17-alpine"), pgMajorOf("18"), pgMajorOf("latest"), pgMajorOf(null)]).toEqual(["16", "16", "17", "18", null, null]);
  });
});

describe("evaluateDbGates (physical Postgres copy)", () => {
  const inv = { itemRef: DB_VOL_REF, found: true, mountType: "volume" as const, rawBytes: 1, entries: 1, specials: { sockets: 0, fifos: 0, devices: 0 }, running: false, exitCode: 0, image: "postgres:16-alpine", pgMajor: "16", pgLayout: "root" as const, mountDest: "/var/lib/postgresql/data" };
  const rec = { version: "16", image: "postgres:16-alpine", status: "NEW", restores: 0, backups: 0 };
  const gates = (over: Partial<Parameters<typeof evaluateDbGates>[0]> = {}) => evaluateDbGates({ credentialsCarried: true, record: rec, inventory: inv, ...over });
  const byId = (g: ReturnType<typeof gates>) => Object.fromEntries(g.map((x) => [x.id, x]));

  it("every gate passes with evidence on a matching alpine 16 volume", () => {
    const g = gates();
    expect(g.every((x) => x.status === "pass")).toBe(true);
    expect(firstBlockingGate(g)).toBeNull();
    expect(byId(g).quiesced.text).toContain("reported by the migrator");
  });
  it("O1: with no inventory (the servet image is unknown) the physical copy fails closed", () => {
    const g = gates({ inventory: undefined });
    expect(byId(g).inventory.status).toBe("unknown");
    expect(["major", "layout", "image", "quiesced"].map((k) => byId(g)[k as "major"].status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(firstBlockingGate(g)!.text).toBe(GATE_TEXT.inventoryMissing);
  });
  it("credentials not carried -> the exact refusal text", () => {
    expect(byId(gates({ credentialsCarried: false })).credentials).toEqual({ id: "credentials", status: "fail", text: "this database's credentials were not carried from the source, so a copied data directory would not match them; use the logical dump" });
    expect(byId(gates({ credentialsCarried: undefined })).credentials.status).toBe("fail");
  });
  it("major mismatch / unreadable PG_VERSION", () => {
    expect(byId(gates({ inventory: { ...inv, pgMajor: "15" } })).major.text).toContain("source PostgreSQL major (15) differs");
    expect(byId(gates({ inventory: { ...inv, pgMajor: undefined } })).major.status).toBe("fail");
  });
  it("PG 18 nested layout -> the exact refusal; no data dir; wrong mount", () => {
    expect(byId(gates({ inventory: { ...inv, pgLayout: "nested", pgMajor: "18" }, record: { ...rec, version: "18" } })).layout.text).toBe("PostgreSQL 18 data layout is not supported by Tugra database volumes yet");
    expect(byId(gates({ inventory: { ...inv, pgLayout: "none" } })).layout.status).toBe("fail");
    expect(byId(gates({ inventory: { ...inv, mountDest: "/data" } })).layout.text).toContain("/data");
  });
  it("alpine -> debian image substitution is refused (same image only)", () => {
    expect(byId(gates({ record: { ...rec, image: "postgres:16" } })).image.text).toContain("needs the same image");
  });
  it("a started / restored / backed-up destination is refused with the dirty-destination text", () => {
    for (const r of [{ ...rec, status: "RUNNING" }, { ...rec, restores: 1 }, { ...rec, backups: 2 }]) expect(byId(gates({ record: r })).state.text).toBe("the destination was started or holds data not restored by this migration");
  });
  it("a running source is refused", () => {
    expect(byId(gates({ inventory: { ...inv, running: true } })).quiesced.status).toBe("fail");
  });
});

describe("volume view", () => {
  const base = { target: target(), resourceName: "web", destVolume: "data", transfer: null, inventory: undefined, disk: null, gates: null, steps: null };
  it("a volume with no transfer is NONE, labelled as reported by the migrator", () => {
    const v = buildVolumeView(base);
    expect(v).toMatchObject({ state: "NONE", partsDone: 0, canAbort: false, canReset: false, evidenceNote: "reported by the migrator", etaSec: null });
  });
  it("an excluded volume with no transfer is EXCLUDED", () => {
    expect(buildVolumeView({ ...base, target: target({ excluded: { reason: "58 GB ClickHouse", at: "x", by: "u" } }) })).toMatchObject({ state: "EXCLUDED", excluded: { reason: "58 GB ClickHouse" } });
  });
  it("progress math: bigint columns -> numbers, ETA from the rate", () => {
    const v = buildVolumeView({ ...base, transfer: { state: "COPYING", phase: "streaming", partsDone: 3, bytesDone: 30n, rawBytesDone: 400n, rawBytesTotal: 1000n, bps: 100n, error: null, startedAt: new Date() } });
    expect(v).toMatchObject({ state: "COPYING", partsDone: 3, bytesDone: 30, rawBytesDone: 400, rawBytesTotal: 1000, bps: 100, etaSec: 6, canAbort: true, canReset: true });
  });
  it("etaSeconds never goes negative or NaN", () => {
    expect(etaSeconds(10, 5, 100)).toBe(0);
    expect(etaSeconds(0, null, 100)).toBeNull();
    expect(etaSeconds(0, 100, 0)).toBeNull();
    expect(etaSeconds(0, 100, 30)).toBe(4);
  });
  it("reset is not offered while applying or once DONE", () => {
    const row = (state: string) => buildVolumeView({ ...base, transfer: { state, phase: null, partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesTotal: null, bps: null, error: null, startedAt: null } });
    expect([row("APPLYING").canReset, row("DONE").canReset, row("FAILED").canReset, row("ABORTED").canReset]).toEqual([false, false, true, true]);
    expect([row("APPLYING").canAbort, row("DONE").canAbort, row("COPIED").canAbort]).toEqual([true, false, true]);
  });
});

describe("DTOs are strict", () => {
  const inv = { itemRef: APP_VOL_REF, found: true, mountType: "volume", rawBytes: 5, entries: 2, specials: { sockets: 0, fifos: 0, devices: 0 }, running: false };
  it("inventory: accepts a valid body; rejects unknown keys, bad refs, control characters, > 1000 items", () => {
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: [inv] }).success).toBe(true);
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: [{ ...inv, extra: 1 }] }).success).toBe(false);
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: [{ ...inv, itemRef: "volume:a" }] }).success).toBe(false);
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: [{ ...inv, reason: "a\nb" }] }).success).toBe(false);
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: [{ ...inv, image: "x; rm -rf /" }] }).success).toBe(false);
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: Array.from({ length: 1001 }, () => inv) }).success).toBe(false);
    expect(VxInventoryBodySchema.safeParse({ runId: "short", items: [inv] }).success).toBe(false);
    expect(VxInventoryBodySchema.safeParse({ runId: RUN, items: [] }).success).toBe(false);
  });
  it("begin/part/finish are strict and typed", () => {
    const fp = { containerId: "a".repeat(64), startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-02T00:00:00Z", exitCode: 0, mountType: "volume", imageId: "sha256:abc" };
    expect(VxBeginBodySchema.safeParse({ runId: RUN, partRawBytes: 134217728, fingerprint: fp }).success).toBe(true);
    expect(VxBeginBodySchema.safeParse({ runId: RUN, partRawBytes: 134217728, fingerprint: { ...fp, containerId: "nothex" } }).success).toBe(false);
    expect(VxBeginBodySchema.safeParse({ runId: RUN, partRawBytes: 1, fingerprint: fp, extra: true }).success).toBe(false);
    const part = { runId: RUN, rawOffset: 0, rawLen: 10, rawSha256: sha("a"), size: 5, sha256: sha("b") };
    expect(VxPartBodySchema.safeParse(part).success).toBe(true);
    expect(VxPartBodySchema.safeParse({ ...part, rawLen: 0 }).success).toBe(false);
    expect(VxPartBodySchema.safeParse({ ...part, sha256: "x" }).success).toBe(false);
    const fin = { runId: RUN, parts: 1, rawBytes: 10, entries: 3, fingerprintAfter: { containerId: "a".repeat(64), startedAt: "x", finishedAt: "y", running: false } };
    expect(VxFinishBodySchema.safeParse(fin).success).toBe(true);
    expect(VxFinishBodySchema.safeParse({ ...fin, parts: 0 }).success).toBe(false);
  });
});

describe("env limits clamp and default", () => {
  const keys = ["MIGRATION_VX_ENABLED", "MIGRATION_VX_PART_MIB", "MIGRATION_VX_MAX_BYTES", "MIGRATION_VX_MAX_PARTS", "MIGRATION_VX_STALE_MS", "MIGRATION_TOKEN_MAX_LIFE_HOURS", "MIGRATION_RELAY_CONCURRENCY"];
  afterEach(() => keys.forEach((k) => delete process.env[k]));
  it("defaults", () => {
    expect([vxEnabled(), vxPartRawBytes(), vxMaxBytes(), vxMaxParts(), vxStaleMs(), tokenMaxLifeMs(), migrationRelayConcurrency()]).toEqual([true, 128 * 1024 ** 2, 256 * GiB_(), 100000, 300000, 72 * 3600000, 2]);
  });
  it("clamps", () => {
    process.env.MIGRATION_VX_PART_MIB = "8";
    expect(vxPartRawBytes()).toBe(32 * 1024 ** 2);
    process.env.MIGRATION_VX_PART_MIB = "9999";
    expect(vxPartRawBytes()).toBe(512 * 1024 ** 2);
    process.env.MIGRATION_VX_PART_MIB = "garbage";
    expect(vxPartRawBytes()).toBe(128 * 1024 ** 2);
    process.env.MIGRATION_VX_MAX_BYTES = String(10 * GiB_() * 1024);
    expect(vxMaxBytes()).toBe(2048 * GiB_());
    for (const off of ["false", "0", "off", "no", "FALSE"]) {
      process.env.MIGRATION_VX_ENABLED = off;
      expect(vxEnabled()).toBe(false);
    }
  });
});
function GiB_(): number {
  return 1024 ** 3;
}
