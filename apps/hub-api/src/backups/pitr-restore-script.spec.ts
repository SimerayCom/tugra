import {
  baseIntervals,
  buildPitrPrepareScript,
  buildPitrRecoveryWaitScript,
  buildPitrSeedScript,
  buildWalObjectListScript,
  buildWalRestoreCleanScript,
  buildWalStageScript,
  contiguousRun,
  WAL_LIST_PAGE,
  WAL_LIST_ROW_MAX_BYTES,
  nextSegmentName,
  parseLsn,
  parsePitrRestore,
  parsePitrSeed,
  parseSegmentName,
  parseWalObjects,
  parseWalStaged,
  pickBase,
  pitrRestoreExitHint,
  recoverableWindow,
  walSegmentName,
  type BaseCandidate,
  type WalObject,
} from "./pitr-restore-script";
import { LOCAL_DEST, type DestinationSpec } from "./destination";
import type { DbSpec } from "../databases/database-script";

const s3Dest: DestinationSpec = {
  type: "S3",
  s3: { bucket: "bk", region: "us-east-1", endpoint: "s3.amazonaws.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};
const s3Enc: DestinationSpec = { ...s3Dest, encryption: { enabled: true, key: "secretpass" } };
const spec: DbSpec = { id: "new1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: "s3cr3tPw", database: "appdb" } };

const obj = (name: string, mtimeIso: string, size = 16777216): WalObject => ({ name, size, mtime: new Date(mtimeIso) });

describe("pitr-restore-script — segment math", () => {
  it("parses an LSN and derives the 16 MiB segment name (TTTTTTTT XXXXXXXX SSSSSSSS)", () => {
    expect(parseLsn("0/2000028")).toEqual({ hi: 0, lo: 0x2000028 });
    expect(parseLsn("junk")).toBeNull();
    // 0/2000028 → low word 0x02000028 / 16MiB = 2
    expect(walSegmentName("0/2000028", 1)).toBe("000000010000000000000002");
    expect(walSegmentName("A/B0000000", 3)).toBe("000000030000000A000000B0");
    expect(walSegmentName("0/0", 0)).toBeNull();
  });

  it("steps to the next segment and wraps at 256 segments per high word", () => {
    expect(nextSegmentName("000000010000000000000002")).toBe("000000010000000000000003");
    expect(nextSegmentName("0000000100000000000000FF")).toBe("000000010000000100000000");
    expect(nextSegmentName("not-a-segment")).toBeNull();
    expect(parseSegmentName("000000010000000000000002")).toEqual({ timeline: 1, hi: 0, seg: 2 });
  });

  it("finds the maximal CONTIGUOUS run from the start segment (a gap ends it; a missing start = empty)", () => {
    const objs = [
      obj("000000010000000000000002", "2026-11-13T10:00:00Z"),
      obj("000000010000000000000003", "2026-11-13T10:05:00Z"),
      obj("000000010000000000000005", "2026-11-13T10:15:00Z"), // 04 missing → gap
    ];
    expect(contiguousRun("000000010000000000000002", objs).map((o) => o.name)).toEqual(["000000010000000000000002", "000000010000000000000003"]);
    expect(contiguousRun("000000010000000000000001", objs)).toEqual([]);
  });
});

describe("pitr-restore-script — base pick + window", () => {
  const bases: BaseCandidate[] = [
    { id: "b1", createdAt: new Date("2026-11-13T09:00:00Z"), completedAt: new Date("2026-11-13T09:02:00Z"), startLsn: "0/2000028", timeline: 1 },
    { id: "b2", createdAt: new Date("2026-11-13T11:00:00Z"), completedAt: new Date("2026-11-13T11:03:00Z"), startLsn: "0/6000028", timeline: 1 },
    { id: "bad", createdAt: new Date("2026-11-13T12:00:00Z"), completedAt: null, startLsn: null, timeline: null },
  ];
  const objs = ["02", "03", "04", "05", "06", "07", "08"].map((s, i) => obj(`0000000100000000000000${s}`, `2026-11-13T${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`));

  it("builds per-base intervals [completedAt, reach] and the overall window; unusable bases are excluded", () => {
    const picks = baseIntervals(bases, objs);
    expect(picks.map((p) => p.base.id)).toEqual(["b1", "b2"]);
    expect(picks[0].startSeg).toBe("000000010000000000000002");
    expect(picks[0].reach).toEqual(objs[objs.length - 1].mtime); // chain reaches the newest segment
    const w = recoverableWindow(picks);
    expect(w.earliest).toEqual(bases[0].completedAt);
    expect(w.latest).toEqual(objs[objs.length - 1].mtime);
    expect(recoverableWindow([])).toEqual({ earliest: null, latest: null });
  });

  it("picks the NEWEST base whose interval covers the target — completedAt (end), not createdAt (start)", () => {
    expect(pickBase(bases, objs, new Date("2026-11-13T11:30:00Z"))!.base.id).toBe("b2");
    expect(pickBase(bases, objs, new Date("2026-11-13T10:00:00Z"))!.base.id).toBe("b1");
    // between b2's start and end → b2 is not consistent yet, fall back to b1
    expect(pickBase(bases, objs, new Date("2026-11-13T11:01:00Z"))!.base.id).toBe("b1");
    expect(pickBase(bases, objs, new Date("2026-11-13T08:00:00Z"))).toBeNull(); // before any base finished
    expect(pickBase(bases, objs, new Date("2026-11-14T00:00:00Z"))).toBeNull(); // beyond the shipped WAL
  });
});

describe("pitr-restore-script — listing", () => {
  it("LOCAL: glob (no $(ls)), rejects symlinks/metacharacters, sorts, pages with a cursor, always trails", () => {
    const s = buildWalObjectListScript("db1", LOCAL_DEST, { after: "000000010000000000000003.gz", limit: 2 });
    expect(s).toContain("dir='/etc/tugra/backups/db1/wal'");
    expect(s).toContain("for f in *; do");
    expect(s).not.toContain("$(ls");
    expect(s).toContain('[ -f "$f" ] && [ ! -L "$f" ]');
    expect(s).toContain("sort -k2,2");
    expect(s).toContain("-v a='000000010000000000000003.gz' -v n=2");
    expect(s).toContain('"TUGRA_WAL_OBJ n=" c " more=" m " last=" l');
    expect(s).toContain('[ -d "$dir" ] || { echo "TUGRA_WAL_OBJ n=0 more=0 last="; exit 0; }');
  });

  it("S3: mc ls --json under <prefix>/<db>/wal/ with creds in env, order-independent JSON extraction", () => {
    const s = buildWalObjectListScript("db1", s3Dest);
    expect(s).toContain("mc ls --json tdest/bk/tugra/db1/wal/");
    expect(s).toContain("MC_HOST_tdest=");
    expect(s).toContain('"key":"');
    expect(s).toContain('"lastModified":"');
    expect(s.indexOf("command -v mc")).toBeLessThan(s.indexOf("mc ls")); // MC_INSTALL first
    // mc's OWN exit status is captured: a failed listing exits 1 with NO trailer (= unknown), never "empty"
    expect(s).toContain("OUT=$(MC_HOST_tdest=");
    expect(s).toMatch(/mc ls --json [^\n]*\) \|\| \{ echo "tugra: could not list[^\n]*exit 1; \}/);
    expect(s).toContain(`printf '%s\\n' "$OUT" |`);
  });

  it("a listing page can never approach the agent's 64KB output cap (the trailer comes last)", () => {
    expect(WAL_LIST_PAGE * WAL_LIST_ROW_MAX_BYTES).toBeLessThan(48 * 1024);
    const s = buildWalObjectListScript("db1", s3Enc, { limit: 5000 });
    expect(s).toContain(`-v n=${WAL_LIST_PAGE}`); // a larger limit is clamped
  });

  it("parses a page: strips the shipper suffix, re-validates names, drops .backup labels, null without a trailer", () => {
    const out = [
      "OBJ 000000010000000000000003.gz 16777216 1763028000",
      "OBJ 000000010000000000000002.gz 16777216 1763027700",
      "OBJ 00000002.history.gz 42 1763028100",
      "OBJ 000000010000000000000003.00000028.backup.gz 300 1763028000",
      "OBJ evil;rm.gz 1 1",
      "OBJ 000000010000000000000009.gz.gpg 1 1", // wrong suffix for an unencrypted dest
      "TUGRA_WAL_OBJ n=6 more=1 last=000000010000000000000009.gz.gpg",
    ].join("\n");
    const p = parseWalObjects(out, LOCAL_DEST)!;
    // sorted by name (plain string order: the 24-hex segments sort before "00000002.history")
    expect(p.objects.map((o) => o.name)).toEqual(["000000010000000000000002", "000000010000000000000003", "00000002.history"]);
    expect(p.objects[0].mtime.getTime()).toBe(1763027700 * 1000); // epoch seconds (LOCAL stat) → Date
    expect(p.more).toBe(true);
    expect(parseWalObjects("OBJ 000000010000000000000002.gz 1 1", LOCAL_DEST)).toBeNull(); // no trailer = UNKNOWN
    // encrypted destination: the .gz.gpg suffix is the one stripped; ISO mtimes (S3) parse too
    const e = parseWalObjects("OBJ 000000010000000000000002.gz.gpg 1 2026-11-13T10:00:00Z\nTUGRA_WAL_OBJ n=1 more=0 last=x", s3Enc)!;
    expect(e.objects[0].name).toBe("000000010000000000000002");
    expect(e.objects[0].mtime.toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });
});

describe("pitr-restore-script — prepare / stage", () => {
  it("prepare: pulls, refuses a moved PGDATA (22), resolves the postgres uid by NAME, df-guards, 0700 dir", () => {
    const s = buildPitrPrepareScript("new1", "postgres:16", 10);
    expect(s).toContain("docker pull");
    expect(s).toContain("printenv PGDATA");
    expect(s).toMatch(/expected \/var\/lib\/postgresql\/data[^\n]*exit 22/);
    expect(s).toContain("--entrypoint id \"$IMG\" -u postgres");
    expect(s).toMatch(/df -Pk \/etc\/tugra/);
    expect(s).toContain(`-lt ${Math.ceil((10 * 16777216) / 1024) + 1048576}`);
    expect(s).toContain("rm -rf '/etc/tugra/wal-restore/new1' && mkdir -p '/etc/tugra/wal-restore/new1' && chown \"$U:$G\" '/etc/tugra/wal-restore/new1' && chmod 700");
    expect(s).toContain("TUGRA_PITR_PREPARE ok");
  });

  it("stage: resumable, .part then mv, standalone subshell (errexit honored), stop at first failure, names validated", () => {
    const s = buildWalStageScript("db1", "new1", ["000000010000000000000002", "00000002.history"], s3Enc);
    expect(s.indexOf("command -v mc")).toBe(0);
    expect(s).toContain("if [ -s '/etc/tugra/wal-restore/new1/000000010000000000000002' ]; then echo \"TUGRA_WAL_STAGED 000000010000000000000002\"; else");
    expect(s).toContain("mc cat tdest/bk/tugra/db1/wal/000000010000000000000002.gz.gpg");
    expect(s).toContain("--decrypt | gunzip > '/etc/tugra/wal-restore/new1/000000010000000000000002.part'");
    expect(s).toContain("( set -e; set -o pipefail;");
    expect(s).not.toContain("if ( "); // never an if-condition subshell
    expect(s).toMatch(/TUGRA_WAL_STAGE_FAIL 000000010000000000000002"; exit 1/);
    expect(s).toContain("TUGRA_WAL_STAGED 00000002.history");
    expect(() => buildWalStageScript("db1", "new1", ["../etc/passwd"], LOCAL_DEST)).toThrow(/invalid WAL name/);
  });

  it("parses staged markers", () => {
    expect(parseWalStaged("TUGRA_WAL_STAGED a\nTUGRA_WAL_STAGED b\nTUGRA_WAL_STAGE_FAIL c")).toEqual({ staged: ["a", "b"], failed: "c" });
  });

  it("the staging dir is reclaimable (after a successful promote and on the failure reap)", () => {
    expect(buildWalRestoreCleanScript("new1")).toBe("rm -rf '/etc/tugra/wal-restore/new1' 2>/dev/null || true");
  });
});

describe("pitr-restore-script — seed", () => {
  it("creates the volume, refuses a non-empty one (20), streams the base tar into the image's own helper, proves the cluster", () => {
    const s = buildPitrSeedScript({ id: "new1", image: "postgres:16" }, { filename: "t.basebackup.tar.gz" }, "db1", LOCAL_DEST, "000000010000000000000002");
    expect(s).toContain("VOL='tugra_dbv_new1'");
    // the cluster must match the IMAGE's server major (not the row's version) and be PG12+
    expect(s).toContain('IMGV=$(postgres -V | cut -d" " -f3 | cut -d. -f1)');
    expect(s).toMatch(/image runs \$IMGV[^\n]*exit 21/);
    expect(s).toMatch(/12 or newer[^\n]*exit 25/);
    expect(s).toContain("docker volume create \"$VOL\"");
    expect(s).toMatch(/ls -A \/d[^\n]*exit 20/);
    expect(s).toContain("cat /etc/tugra/backups/db1/base/t.basebackup.tar.gz | gunzip | docker run --rm -i --user 0 --entrypoint sh -v \"$VOL\":/var/lib/postgresql/data \"$IMG\" -c ");
    expect(s).toContain("tar -xf - -C /var/lib/postgresql/data");
    expect(s).toContain("backup_label ] || { echo \"tugra: base tar has no backup_label\" >&2; exit 21; }");
    expect(s).toContain("'(file 000000010000000000000002)'");
    expect(s).toContain("exit 23");
    expect(s).toContain("touch /var/lib/postgresql/data/recovery.signal");
    expect(s).toContain("chown -R postgres:postgres /var/lib/postgresql/data; chmod 700 /var/lib/postgresql/data");
    expect(s).not.toContain("rm -f /var/lib/postgresql/data/backup_label"); // never delete the recovery anchor
    expect(s).not.toContain("postgresql.auto.conf"); // recovery settings are -c flags, never persisted
  });

  it("S3 seed uses mc cat (creds in env) and installs mc first", () => {
    const s = buildPitrSeedScript({ id: "new1", image: "postgres:16" }, { filename: "t.basebackup.tar.gz.gpg" }, "db1", s3Enc, "000000010000000000000002");
    expect(s).toContain("mc cat tdest/bk/tugra/db1/base/t.basebackup.tar.gz.gpg | gpg");
    expect(s.indexOf("command -v mc")).toBeLessThan(s.indexOf("mc cat"));
  });

  it("parses the seed marker", () => {
    expect(parsePitrSeed("x\nTUGRA_PITR_SEED ok pgver=16 start=000000010000000000000002")).toEqual({ pgver: "16", start: "000000010000000000000002" });
    expect(parsePitrSeed("tugra: base tar has no backup_label")).toBeNull();
  });
});

describe("pitr-restore-script — recovery wait", () => {
  const s = buildPitrRecoveryWaitScript(spec, 300);
  it("polls pg_is_in_recovery (readiness alone is NOT promotion), fails fast on exit/crash-loop, proves the stop point", () => {
    expect(s).toContain("select pg_is_in_recovery()");
    expect(s).toContain("{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}");
    expect(s).toMatch(/exited during recovery[^\n]*exit 31/);
    // PG13+ "recovery ended before configured recovery target" crash-loop is reported as 33 (same hint as PG12's silent promote)
    expect(s).toMatch(/recovery ended before configured recovery target[^\n]*exit 33/);
    expect(s).toContain("grep -Eq 'recovery stopping (before|after|at)'");
    expect(s).toMatch(/without reaching the target time[^\n]*exit 33/);
    expect(s).toMatch(/still running after 300s[^\n]*exit 32/);
    // lsn/timeline are captured into variables first and the success line is printed only when both are non-empty;
    // the timeline comes from the current WAL file name (pg_control_checkpoint lags after a fast promote)
    expect(s).toContain("TL=$(P 'select substr(pg_walfile_name(pg_current_wal_lsn()),1,8)'");
    expect(s).toContain('if [ -n "$L" ] && [ -n "$TL" ]; then echo "TUGRA_PITR_RESTORE ok lsn=$L tl=$TL"; exit 0; fi');
    expect(s).not.toContain("pg_control_checkpoint");
    expect(s).toContain("PGPASSWORD='s3cr3tPw'");
    expect(s).not.toContain("SELECT 1"); // the readiness prelude is deliberately NOT used here
  });
  it("parses the promote marker (timeline is 8-hex from the WAL file name) and maps exit hints per phase", () => {
    expect(parsePitrRestore("TUGRA_PITR_RESTORE ok lsn=0/9000028 tl=00000002")).toEqual({ lsn: "0/9000028", timeline: 2 });
    expect(parsePitrRestore("TUGRA_PITR_RESTORE ok lsn= tl=")).toBeNull(); // an empty capture is never a success
    expect(parsePitrRestore("nope")).toBeNull();
    expect(pitrRestoreExitHint(33, "wait")).toMatch(/earlier time/);
    expect(pitrRestoreExitHint(20, "seed")).toMatch(/already holds data/);
    expect(pitrRestoreExitHint(22, "prepare")).toMatch(/18\+/);
    expect(pitrRestoreExitHint(99, "stage")).toMatch(/exit 99/);
  });
});
