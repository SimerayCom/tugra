import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CH_STATS_BODY,
  MONGO_PING_JS,
  MONGO_RESTORE_BODY,
  MONGO_SHELL_BODY,
  SAFE_DB_SCRIPTS,
  assertPasswordForConfigFile,
  clickhouseImportRestoreLines,
  mongoImportRestoreLines,
  safeStatsCommand,
} from "./safe-db-scripts";

const HUB = join(__dirname, "../../test/fixtures/safe-db-scripts.json");
const GO = join(__dirname, "../../../../agent/internal/migrate/testdata/safe-db-scripts.json");

describe("the argv-safe in-container scripts are shared with the Go migrator", () => {
  it("both fixture copies are byte-identical and equal the constants (a drift on either side fails here, and in the Go test)", () => {
    const hub = readFileSync(HUB, "utf8");
    expect(readFileSync(GO, "utf8")).toBe(hub);
    expect(JSON.parse(hub)).toEqual(SAFE_DB_SCRIPTS);
  });

  it("every script is one line, has no single quote (it sits in sh -c '...') and never takes the password from an argument", () => {
    for (const body of Object.values(SAFE_DB_SCRIPTS)) {
      expect(body).not.toMatch(/[\n\r\0]/);
      expect(body).not.toContain("'");
      expect(body).not.toMatch(/--password|MYSQL_PWD|PGPASSWORD/);
      expect(body.length).toBeGreaterThan(20);
    }
    // the password is read from the environment only where a config file is written; the file is owner-only, in the container's tmpfs
    // and removed on every exit
    for (const k of ["mongoDump", "mongoRestore", "chDump", "chRestore", "chStats", "chSize"] as const) {
      expect(SAFE_DB_SCRIPTS[k]).toContain("$TUGRA_DB_PW");
      expect(SAFE_DB_SCRIPTS[k]).toContain("umask 077");
      expect(SAFE_DB_SCRIPTS[k]).toContain("d=/dev/shm");
      expect(SAFE_DB_SCRIPTS[k]).toContain('trap "rm -f');
    }
  });
});

describe("host-side builders", () => {
  it("the Mongo restore lines: readiness probe then the archive, the password only in the caller's environment", () => {
    const [ready, restore] = mongoImportRestoreLines("tugra_db_x", "root", "p'w", "curl -fsSL 'https://x/y' | gunzip");
    expect(ready).toContain("TUGRA_DB_PW='p'\\''w' docker exec -e TUGRA_DB_PW tugra_db_x sh -c ");
    expect(ready).toContain("tugra-ready 'root' exact 1 ");
    expect(ready).toContain("tugra: mongo not ready");
    expect(ready).not.toContain("-e TUGRA_DB_PW=");
    expect(restore).toBe(`curl -fsSL 'https://x/y' | gunzip | TUGRA_DB_PW='p'\\''w' docker exec -i -e TUGRA_DB_PW tugra_db_x sh -c '${MONGO_RESTORE_BODY}' tugra-mongo 'root'`);
    expect(MONGO_PING_JS).toContain("ping:1");
  });

  it("the ClickHouse restore line carries user and database as parameters", () => {
    const [line] = clickhouseImportRestoreLines("tugra_db_x", "chu", "pw", "appdb", "SRC");
    expect(line.startsWith("SRC | TUGRA_DB_PW='pw' docker exec -i -e TUGRA_DB_PW tugra_db_x sh -c '")).toBe(true);
    expect(line.endsWith("' tugra-clickhouse 'chu' 'appdb'")).toBe(true);
  });

  it("refuses what could not be carried or would be read as an option", () => {
    expect(() => mongoImportRestoreLines("tugra_db_x", "-root", "pw", "SRC")).toThrow(/user/);
    expect(() => mongoImportRestoreLines("x; id", "root", "pw", "SRC")).toThrow(/container/);
    expect(() => mongoImportRestoreLines("tugra_db_x", "root", "a\nb", "SRC")).toThrow(/config file/);
    expect(() => mongoImportRestoreLines("tugra_db_x", "root", "", "SRC")).toThrow(/config file/);
    expect(() => clickhouseImportRestoreLines("tugra_db_x", "chu", "pw", "my.db", "SRC")).toThrow(/letters, digits/);
    expect(() => safeStatsCommand("CLICKHOUSE", "tugra_db_x", "chu", "pw", "a b", "exact", 1)).toThrow();
    expect(() => safeStatsCommand("MONGO", "tugra_db_x", "root", "pw", "", "exact", 0)).toThrow(/threshold/);
    expect(() => assertPasswordForConfigFile("x".repeat(257))).toThrow();
    expect(assertPasswordForConfigFile('ünï"code\\ok')).toBe('ünï"code\\ok');
  });
});

/**
 * The REAL bodies through a real sh with stub clients: the quoting of a hostile password is a property of the shell, so it is proven
 * here, not argued (the Go migrator's test runs the very same bytes).
 */
describe("the scripts under sh with stub clients", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tugra-safe-"));
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    stub(
      "mongorestore",
      'case "$*" in *--help*) echo "  --config=  file"; exit 0;; esac; f=""; while [ $# -gt 0 ]; do case "$1" in --config) f="$2"; shift;; esac; shift; done; printf "CFG=[%s]\\n" "$(/bin/cat "$f")" > "$CAP"; /bin/cat > "$CAP.stdin"',
    );
    stub(
      "clickhouse-client",
      'cfg=""; q=""; while [ $# -gt 0 ]; do case "$1" in --config-file) cfg="$2"; shift;; --query) q="$2"; shift;; esac; shift; done; printf "CFG=[%s]\\n" "$(/bin/cat "$cfg")" >> "$CAP"; case "$q" in "SELECT 1") echo 1;; *"FROM system.tables"*) printf "events\\t41\\n";; *"count()"*) echo 41;; *"sum(bytes_on_disk)"*) echo 4096;; esac',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const sh = (body: string, pw: string, args: string[], stdin = ""): { out: string; code: number; cap: string; stdin: string } => {
    const cap = join(dir, `cap-${Math.random().toString(36).slice(2)}`);
    const r = spawnSync("/bin/sh", ["-c", body, "tugra-test", ...args], { encoding: "utf8", input: stdin, env: { PATH: `${dir}:/usr/bin:/bin`, TUGRA_DB_PW: pw, CAP: cap } });
    return { out: r.stdout, code: r.status ?? -1, cap: existsSync(cap) ? readFileSync(cap, "utf8") : "", stdin: existsSync(`${cap}.stdin`) ? readFileSync(`${cap}.stdin`, "utf8") : "" };
  };

  it("mongorestore: YAML-escaped password in a config file, the archive on stdin, nothing hostile executed", () => {
    const pw = "p\"a\\ss$(id)'`x";
    const r = sh(MONGO_RESTORE_BODY, pw, ["root"], "ARCHIVE-BYTES");
    expect(r.code).toBe(0);
    expect(r.cap).toContain('CFG=[password: "p\\"a\\\\ss$(id)\'`x"]');
    expect(r.stdin).toBe("ARCHIVE-BYTES");
  });

  it("the ClickHouse statements: the table counts, the size, and the password XML-escaped in the config file", () => {
    const stats = sh(CH_STATS_BODY, 'p<&>"w', ["chu", "appdb", "exact", "10"]);
    expect(stats.code).toBe(0);
    expect(stats.out).toBe("events\t41\t0\n");
    expect(stats.cap).toContain('CFG=[<clickhouse><user>chu</user><password>p&lt;&amp;&gt;"w</password></clickhouse>]');
    const size = sh(SAFE_DB_SCRIPTS.chSize, "pw", ["chu", "appdb"]);
    expect(size.out.trim()).toBe("4096");
  });

  it("the Mongo shell wrapper hands user, mode, threshold and script over as parameters", () => {
    writeFileSync(join(dir, "mongosh"), '#!/bin/sh\nprintf "%s\\n" "$*"\nprintf "PW=%s\\n" "$TUGRA_DB_PW"\n');
    chmodSync(join(dir, "mongosh"), 0o755);
    const r = sh(MONGO_SHELL_BODY, "secret", ["root", "estimate", "500", "SCRIPT"]);
    expect(r.out).toContain('--quiet --norc --eval var U="root",M="estimate",B=500; SCRIPT');
    expect(r.out).toContain("PW=secret");
  });
});
