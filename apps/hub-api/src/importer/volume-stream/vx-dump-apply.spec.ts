import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MOVE_STAGING_ROOT } from "../../app-moves/app-move-scripts";
import type { DbSpec } from "../../databases/database-script";
import { MIGRATION_EXIT, buildDumpApplyScript, parseMigrationApplyOk } from "./vx-scripts";

const ID = "cktransferabcdefghijklmnopq";
const spec = (engine: DbSpec["engine"], over: Partial<DbSpec> = {}): DbSpec => ({
  id: "ckdb000000000000000000001",
  engine,
  image: engine === "POSTGRES" ? "postgres:16" : engine === "MONGO" ? "mongo:7" : engine === "CLICKHOUSE" ? "clickhouse/clickhouse-server:24" : "mariadb:11",
  port: engine === "POSTGRES" ? 5432 : engine === "MONGO" ? 27017 : engine === "CLICKHOUSE" ? 9000 : 3306,
  credentials: { username: "app", password: "p'w d", database: "appdb" },
  ...over,
});

describe("buildDumpApplyScript (goldens)", () => {
  it("restores a Postgres custom archive with the SAME pipeline a URL import runs, fed by the staged parts", () => {
    const s = buildDumpApplyScript({ transferId: ID, rawBytes: 3000, db: spec("POSTGRES") });
    expect(s).toContain(`ROOT=${MOVE_STAGING_ROOT}/${ID}`);
    expect(s).toContain('vx_stream() { cat "$DIR"/p.* | gunzip | head -c 3000; }');
    expect(s).toContain("vx_stream | docker exec -i -e PGPASSWORD='p'\\''w d' tugra_db_ckdb000000000000000000001 pg_restore --no-owner --clean --if-exists --single-transaction -U 'app' -d 'appdb'");
    expect(s).not.toContain("curl"); // the URL fetch was replaced, none of it survives
    expect(s).not.toContain("dump-stream.invalid");
    expect(s).toContain('echo "TUGRA_VX_APPLY_OK entries=0"');
    // order: the marker is written after the pipeline and before the parts are removed
    expect(s.indexOf("pg_restore")).toBeLessThan(s.indexOf(': > "$ROOT/applied"'));
    expect(s.indexOf(': > "$ROOT/applied"')).toBeLessThan(s.indexOf('rm -rf "$DIR"'));
    expect(s).toContain("exit 67");
    expect(s).toContain('trap \'rm -f "$ROOT/applying.lock"\' EXIT');
  });

  it("the MySQL family loads the SQL dump as root (an import: DEFINERs and privilege gaps of another installation must not abort it)", () => {
    const s = buildDumpApplyScript({ transferId: ID, rawBytes: 10, db: spec("MARIADB") });
    expect(s).toContain("vx_stream | docker exec -i -e MYSQL_PWD='p'\\''w d' tugra_db_ckdb000000000000000000001 mariadb -u'root' --protocol=TCP -h127.0.0.1 'appdb'");
    const my = buildDumpApplyScript({ transferId: ID, rawBytes: 10, db: spec("MYSQL") });
    expect(my).toContain(" mysql -u'root' --protocol=TCP");
  });

  it("MongoDB restores the archive through a config file: the password is in the environment, never on an argv", () => {
    const s = buildDumpApplyScript({ transferId: ID, rawBytes: 3000, db: spec("MONGO", { credentials: { username: "root", password: "p'w d", database: "appdb" } }) });
    expect(s).toContain("vx_stream | TUGRA_DB_PW='p'\\''w d' docker exec -i -e TUGRA_DB_PW tugra_db_ckdb000000000000000000001 sh -c ");
    expect(s).toContain(" tugra-mongo 'root'");
    expect(s).toContain('--archive --drop --nsExclude "admin.*"'); // a foreign dump never replaces the target's own root user
    expect(s).not.toContain("--password");
    expect(s).not.toContain("curl");
  });

  it("ClickHouse restores the backup through a config file, stage-then-swap, the source database read from the archive", () => {
    const s = buildDumpApplyScript({ transferId: ID, rawBytes: 3000, db: spec("CLICKHOUSE", { credentials: { username: "chu", password: "pw", database: "appdb" } }) });
    expect(s).toContain("vx_stream | TUGRA_DB_PW='pw' docker exec -i -e TUGRA_DB_PW tugra_db_ckdb000000000000000000001 sh -c ");
    expect(s).toContain(" tugra-clickhouse 'chu' 'appdb'");
    expect(s).toContain("RESTORE DATABASE");
    expect(s).not.toContain("--password");
    expect(s).not.toContain("dump-stream.invalid");
  });

  it("refuses a database name the restore cannot read back from an archive, and a password a config file cannot carry", () => {
    expect(() => buildDumpApplyScript({ transferId: ID, rawBytes: 1, db: spec("CLICKHOUSE", { credentials: { username: "chu", password: "pw", database: "my.db" } }) })).toThrow();
    expect(() => buildDumpApplyScript({ transferId: ID, rawBytes: 1, db: spec("MONGO", { credentials: { username: "root", password: "a\nb", database: "x" } }) })).toThrow(/config file/);
  });

  it("refuses an engine with no dump lane, a bad transfer id and a bad size", () => {
    expect(() => buildDumpApplyScript({ transferId: ID, rawBytes: 1, db: spec("REDIS") })).toThrow(/does not restore REDIS/);
    expect(() => buildDumpApplyScript({ transferId: "a b", rawBytes: 1, db: spec("POSTGRES") })).toThrow();
    expect(() => buildDumpApplyScript({ transferId: ID, rawBytes: 0, db: spec("POSTGRES") })).toThrow();
    expect(() => buildDumpApplyScript({ transferId: ID, rawBytes: 1.5, db: spec("POSTGRES") })).toThrow();
  });

  it("the database's own values never reach the script unquoted (a hostile name stays one shell word)", () => {
    const s = buildDumpApplyScript({ transferId: ID, rawBytes: 1, db: spec("POSTGRES", { credentials: { username: "a;rm -rf /", password: "x", database: "d$(id)" } }) });
    expect(s).toContain("-U 'a;rm -rf /'");
    expect(s).toContain("-d 'd$(id)'");
  });
});

/**
 * Shell lab: the REAL script executed by bash against a stubbed docker, so the glue (the staged-parts reader, the exit codes, the
 * marker order, the lock) is proven without a daemon. The stub's `docker exec ... pg_restore|mariadb` captures stdin to a file.
 */
const DOCKER = `#!/bin/bash
cmd="$1"; shift
case "$cmd" in
  exec)
    flat="$*"
    if [[ "$flat" == *pg_restore* || "$flat" == *" mariadb "* || "$flat" == *" mysql "* || "$flat" == *mongorestore* || "$flat" == *"RESTORE DATABASE"* ]]; then
      echo "$flat" > "$CAPTURE.args"
      echo "pw=\${TUGRA_DB_PW-}" > "$CAPTURE.env"
      cat > "$CAPTURE"
      [ -n "$FAIL_RESTORE" ] && exit 1
      exit 0
    fi
    exit 0 ;;
esac
exit 1
`;

describe("the dump apply script executed against a stubbed docker", () => {
  let root: string;
  let bin: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tugra-vxdump-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let n = 0;
  function host() {
    const base = join(root, `h${n++}`);
    mkdirSync(join(base, "app-moves"), { recursive: true });
    const capture = join(base, "stdin.bin");
    const stage = join(base, "app-moves", ID);
    const run = (script: string, env: Record<string, string> = {}) => {
      const r = spawnSync("bash", ["-c", script.replaceAll(MOVE_STAGING_ROOT, join(base, "app-moves"))], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, ...env } });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };
    /** Stage `dump` as independent gzip members of `slice` raw bytes, named p.00000, p.00001, ... (what the target's receive script leaves). */
    const stageParts = (dump: Buffer, slice = 1000) => {
      mkdirSync(join(stage, "0"), { recursive: true });
      let i = 0;
      for (let o = 0; o < dump.length; o += slice) writeFileSync(join(stage, "0", `p.${String(i++).padStart(5, "0")}`), gzipSync(dump.subarray(o, o + slice), { level: 1 }));
      return i;
    };
    return { base, capture, stage, run, stageParts };
  }
  const dump = (len: number) => Buffer.from(Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff));

  it("streams the decoded parts, in order, into the engine's restore and nothing else; then marks it applied and removes the parts", () => {
    const h = host();
    const d = dump(3500);
    h.stageParts(d);
    const r = h.run(buildDumpApplyScript({ transferId: ID, rawBytes: d.length, db: spec("POSTGRES") }));
    expect(r.code).toBe(0);
    expect(parseMigrationApplyOk(r.out)).toBe(0);
    expect(readFileSync(h.capture).equals(d)).toBe(true); // byte-identical to the dump, no decoded copy needed on disk
    expect(readFileSync(`${h.capture}.args`, "utf8")).toContain("pg_restore --no-owner --clean --if-exists --single-transaction");
    expect(existsSync(join(h.stage, "applied"))).toBe(true);
    expect(existsSync(join(h.stage, "0"))).toBe(false);
    expect(existsSync(join(h.stage, "applying.lock"))).toBe(false);
  });

  it("a failing restore ends non-zero with NO applied marker, the parts kept and the lock gone (the next begin re-applies them)", () => {
    const h = host();
    const d = dump(2500);
    const parts = h.stageParts(d);
    const r = h.run(buildDumpApplyScript({ transferId: ID, rawBytes: d.length, db: spec("POSTGRES") }), { FAIL_RESTORE: "1" });
    expect(r.code).not.toBe(0);
    expect(parseMigrationApplyOk(r.out)).toBeNull();
    expect(existsSync(join(h.stage, "applied"))).toBe(false);
    expect(readdirSync(join(h.stage, "0")).filter((f) => /^p\.\d{5}$/.test(f))).toHaveLength(parts);
    expect(existsSync(join(h.stage, "applying.lock"))).toBe(false);
  });

  it("no staged parts is exit 67, before anything touches the database", () => {
    const h = host();
    const r = h.run(buildDumpApplyScript({ transferId: ID, rawBytes: 10, db: spec("POSTGRES") }));
    expect(r.code).toBe(MIGRATION_EXIT.noParts);
    expect(existsSync(h.capture)).toBe(false);
  });

  it("the decoded stream is cut at the recorded size (a gzip bomb cannot feed the restore more than the migrator declared)", () => {
    const h = host();
    const d = dump(5000);
    h.stageParts(d);
    h.run(buildDumpApplyScript({ transferId: ID, rawBytes: 3000, db: spec("POSTGRES") }));
    expect(readFileSync(h.capture).length).toBe(3000);
  });

  it("the MySQL family receives the same stream through its own client", () => {
    const h = host();
    const d = Buffer.from("-- Dump completed\n".repeat(200));
    h.stageParts(d, 777);
    const r = h.run(buildDumpApplyScript({ transferId: ID, rawBytes: d.length, db: spec("MARIADB") }));
    expect(r.code).toBe(0);
    expect(readFileSync(h.capture).equals(d)).toBe(true);
    expect(readFileSync(`${h.capture}.args`, "utf8")).toContain("mariadb -uroot");
  });

  it("MongoDB: the staged parts reach the restore body's stdin, the readiness probe runs first, the password only in the environment", () => {
    const h = host();
    const d = dump(2600);
    h.stageParts(d);
    const r = h.run(buildDumpApplyScript({ transferId: ID, rawBytes: d.length, db: spec("MONGO", { credentials: { username: "root", password: "s3'cret", database: "appdb" } }) }));
    expect(r.code).toBe(0);
    expect(parseMigrationApplyOk(r.out)).toBe(0);
    expect(readFileSync(h.capture).equals(d)).toBe(true);
    expect(readFileSync(`${h.capture}.env`, "utf8").trim()).toBe("pw=s3'cret");
    const argv = readFileSync(`${h.capture}.args`, "utf8");
    expect(argv).toContain("mongorestore --config");
    expect(argv).not.toContain("s3'cret");
  });

  it("ClickHouse: the staged parts reach the restore body's stdin", () => {
    const h = host();
    const d = dump(1800);
    h.stageParts(d);
    const r = h.run(buildDumpApplyScript({ transferId: ID, rawBytes: d.length, db: spec("CLICKHOUSE", { credentials: { username: "chu", password: "pw", database: "appdb" } }) }));
    expect(r.code).toBe(0);
    expect(readFileSync(h.capture).equals(d)).toBe(true);
    expect(readFileSync(`${h.capture}.args`, "utf8")).not.toContain("--password");
  });
});
