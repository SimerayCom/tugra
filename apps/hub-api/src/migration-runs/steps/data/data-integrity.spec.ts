import { createHash } from "node:crypto";
import { RunReportSchema } from "../../core/dto";
import { buildDataIntegrity, partListChecksum, rowsVerdict, type IntegrityTask, type IntegrityTransfer } from "./data-integrity";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DB = "database:s:main";
const dbTask = (itemRef: string, id: string, name = "main-db"): IntegrityTask => ({ itemRef, kind: "database", status: "DONE", resourceType: "database", resourceId: id, name });
const parts = [
  { idx: 1, rawOffset: 100, rawLen: 100, rawSha256: sha("b") },
  { idx: 0, rawOffset: 0, rawLen: 100, rawSha256: sha("a") },
];
const parity = (status: string, params: Record<string, unknown>) => ({ subject: DB, status, evidence: { code: "verify.db-parity.match", params } });

describe("partListChecksum", () => {
  it("is one sha256 over the ordered part list: the same parts in any arrival order give the same digest, a changed part or a missing one does not", () => {
    const expected = sha(`0:0:100:${sha("a")}\n1:100:100:${sha("b")}\n`);
    expect(partListChecksum(parts)).toBe(expected);
    expect(partListChecksum([...parts].reverse())).toBe(expected);
    expect(partListChecksum([parts[0]])).not.toBe(expected);
    expect(partListChecksum([{ ...parts[0], rawSha256: sha("x") }, parts[1]])).not.toBe(expected);
  });
  it("has none without parts", () => {
    expect(partListChecksum([])).toBeNull();
  });
});

describe("rowsVerdict", () => {
  it("reads the stored parity check: match, close (a warning), mismatch, and everything else is unverified", () => {
    const p = { mode: "exact", relations: 12, differing: 0, sourceRows: 5000, targetRows: 5000, names: [] };
    expect(rowsVerdict(parity("pass", p))).toEqual({ status: "match", mode: "exact", relations: 12, differing: 0, sourceRows: 5000, targetRows: 5000, names: [] });
    expect(rowsVerdict(parity("warn", { ...p, mode: "estimate" })).status).toBe("close");
    expect(rowsVerdict(parity("fail", { ...p, differing: 2, names: ["public.orders", "public.items"] }))).toMatchObject({ status: "mismatch", differing: 2, names: ["public.orders", "public.items"] });
    expect(rowsVerdict(parity("unknown", {})).status).toBe("unverified");
    expect(rowsVerdict(undefined)).toMatchObject({ status: "unverified", relations: null, sourceRows: null, names: [] });
  });
  it("drops anything that is not a count or a name", () => {
    const r = rowsVerdict(parity("pass", { mode: "weird", relations: -3, differing: "7", sourceRows: 1.9, targetRows: 2, names: ["ok", 5, null] }));
    expect(r).toMatchObject({ mode: null, relations: null, differing: null, sourceRows: 1, targetRows: 2, names: ["ok"] });
  });
});

describe("buildDataIntegrity", () => {
  const engineOf = new Map([["db1", "POSTGRES"], ["db2", "MARIADB"], ["db3", "POSTGRES"]]);
  const none = new Set<string>();

  it("a one-dump copy carries the sha256 and size the hub computed while staging", () => {
    const digest = sha("artifact");
    const out = buildDataIntegrity({
      tasks: [dbTask(DB, "db1"), { itemRef: `data:${DB}`, kind: "volume", status: "DONE", resourceType: null, resourceId: null, name: null, result: { sha256: digest, bytes: 4096, status: "SUCCESS" } }],
      transfers: [],
      streamRefs: none,
      volumeRefs: none,
      parity: [parity("pass", { mode: "exact", relations: 3, differing: 0, sourceRows: 10, targetRows: 10, names: [] })],
      engineOf,
    });
    expect(out).toEqual([{ itemRef: DB, name: "main-db", engine: "POSTGRES", lane: "dump", bytes: 4096, parts: null, sha256: digest, rows: expect.objectContaining({ status: "match", relations: 3, sourceRows: 10, targetRows: 10 }) }]);
  });

  it("a streamed copy carries its size, part count and the checksum of the part list, and only once it is DONE", () => {
    const tr: IntegrityTransfer = { resourceId: "db2", destType: "db-dump", state: "DONE", partsDone: 2, rawBytesDone: BigInt(200), rawBytesFinal: BigInt(200), parts };
    const base = { tasks: [dbTask("database:s:big", "db2", "big-db")], streamRefs: new Set(["database:s:big"]), volumeRefs: none, parity: [], engineOf };
    expect(buildDataIntegrity({ ...base, transfers: [tr] })[0]).toMatchObject({ lane: "stream", engine: "MARIADB", bytes: 200, parts: 2, sha256: partListChecksum(parts), rows: { status: "unverified" } });
    expect(buildDataIntegrity({ ...base, transfers: [{ ...tr, state: "FAILED" }] })[0].sha256).toBeNull();
  });

  it("a file copy is matched to its own data-directory transfer, not to a dump of the same database", () => {
    const files: IntegrityTransfer = { resourceId: "db3", destType: "db-data", state: "DONE", partsDone: 1, rawBytesDone: 50, rawBytesFinal: null, parts: [parts[1]] };
    const dump: IntegrityTransfer = { ...files, destType: "db-dump", partsDone: 9 };
    const out = buildDataIntegrity({ tasks: [dbTask("database:s:pg", "db3")], transfers: [dump, files], streamRefs: none, volumeRefs: new Set(["database:s:pg"]), parity: [], engineOf });
    expect(out[0]).toMatchObject({ lane: "files", bytes: 50, parts: 1 });
  });

  it("skips what is not a finished database and never invents a checksum from a malformed one", () => {
    const out = buildDataIntegrity({
      tasks: [
        { ...dbTask("database:s:a", "db1"), status: "FAILED" },
        { itemRef: "app:s:x", kind: "app", status: "DONE", resourceType: "application", resourceId: "a1", name: "web" },
        dbTask("database:s:b", "db1"),
        { itemRef: "data:database:s:b", kind: "volume", status: "DONE", resourceType: null, resourceId: null, name: null, result: { sha256: "not-hex", bytes: -1 } },
      ],
      transfers: [],
      streamRefs: none,
      volumeRefs: none,
      parity: [],
      engineOf,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ itemRef: "database:s:b", sha256: null, bytes: null });
  });

  it("every item satisfies the report schema's shape", () => {
    const out = buildDataIntegrity({ tasks: [dbTask(DB, "db1")], transfers: [], streamRefs: none, volumeRefs: none, parity: [], engineOf });
    const shape = RunReportSchema.shape.dataIntegrity;
    expect(shape.safeParse(out).success).toBe(true);
    expect(shape.parse(undefined)).toEqual([]); // a report stored before this section existed still parses
  });
});
