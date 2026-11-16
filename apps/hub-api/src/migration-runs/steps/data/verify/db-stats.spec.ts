import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbStats, StatsTable } from "../data-contract";
import { buildDbStatsScript, compareDbStats, mysqlStatsBody, parseKeyspaceStats, parseTableStats, pgStatsSql, PARITY_CODES, statsFromOutput, statsKindOf } from "./db-stats";

// These two literals are ALSO asserted byte for byte in agent/internal/migrate/verify_test.go (TestVerifyStatementsMatchTheHub):
// the migrator measures the source with the same statements the hub runs on the target.
const GOLDEN_MYSQL_BODY = "T=$(printf '\\t'); L=$(mysql -u\"$1\" --protocol=TCP -h127.0.0.1 -N -B -e \"SELECT table_name, IFNULL(table_rows,0) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name\" \"$2\") || exit 1; [ -n \"$L\" ] || exit 0; printf '%s\\n' \"$L\" | while IFS=\"$T\" read -r t est; do case \"$t\" in ''|*[!A-Za-z0-9_$]*) printf '%s\\t-1\\t0\\n' \"$t\"; continue;; esac; if [ \"$3\" = estimate ] && [ \"$est\" -ge \"$4\" ]; then printf '%s\\t%s\\t1\\n' \"$t\" \"$est\"; continue; fi; n=$(mysql -u\"$1\" --protocol=TCP -h127.0.0.1 -N -B -e \"SELECT COUNT(*) FROM \\`$t\\`\" \"$2\") || { printf '%s\\t-1\\t0\\n' \"$t\"; continue; }; printf '%s\\t%s\\t0\\n' \"$t\" \"$n\"; done";
const GOLDEN_PG_ESTIMATE = "SELECT n.nspname || '.' || c.relname, CASE WHEN c.reltuples >= 250000 THEN c.reltuples::bigint::text ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text END, CASE WHEN c.reltuples >= 250000 THEN '1' ELSE '0' END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' ORDER BY 1";

describe("statements shared with the migrator", () => {
  it("the MySQL body equals the migrator's byte for byte", () => {
    expect(mysqlStatsBody("mysql")).toBe(GOLDEN_MYSQL_BODY);
    expect(mysqlStatsBody("mariadb")).toBe(GOLDEN_MYSQL_BODY.replaceAll("mysql -u", "mariadb -u"));
  });
  it("the Postgres statements equal the migrator's byte for byte", () => {
    expect(pgStatsSql("estimate", 250000)).toBe(GOLDEN_PG_ESTIMATE);
    expect(pgStatsSql("exact", 1)).not.toContain("reltuples");
    expect(pgStatsSql("exact", 1).startsWith("SELECT n.nspname || '.' || c.relname, (xpath(")).toBe(true);
  });
  it("refuses a bad threshold in estimate mode", () => {
    for (const bad of [0, -1, 1.5, 2e12, NaN]) expect(() => pgStatsSql("estimate", bad)).toThrow();
  });
});

describe("buildDbStatsScript", () => {
  const creds = { username: "app", password: "pw'with quote", database: "appdb" };
  it("builds a read-only command per engine and quotes the password", () => {
    const pg = buildDbStatsScript("POSTGRES", "tugra-db-abc", creds, "exact");
    expect(pg).toContain("docker exec -e PGPASSWORD='pw'\\''with quote' tugra-db-abc psql -X -q -A -t -F '\t'");
    expect(pg).toContain("-U 'app' -d 'appdb' -c ");
    const my = buildDbStatsScript("MYSQL", "tugra-db-abc", creds, "estimate", 500);
    expect(my).toContain("docker exec -e MYSQL_PWD='pw'\\''with quote' tugra-db-abc sh -c ");
    expect(my.endsWith(" tugra-verify 'app' 'appdb' estimate 500")).toBe(true);
    expect(buildDbStatsScript("MARIADB", "c", creds, "exact")).toContain("mariadb -u");
    expect(buildDbStatsScript("REDIS", "c", creds, "exact")).toBe("docker exec -e REDISCLI_AUTH='pw'\\''with quote' c redis-cli --no-auth-warning INFO keyspace");
    expect(buildDbStatsScript("KEYDB", "c", creds, "exact")).toContain("keydb-cli --no-auth-warning INFO keyspace");
    expect(buildDbStatsScript("DRAGONFLY", "c", creds, "exact")).toContain("redis-cli --no-auth-warning INFO keyspace");
    for (const s of [pg, my]) expect(s).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|ALTER)\b/i);
  });
  it("refuses an unsafe container, identifier or engine", () => {
    expect(() => buildDbStatsScript("POSTGRES", "x; id", creds, "exact")).toThrow();
    expect(() => buildDbStatsScript("POSTGRES", "c", { ...creds, username: "a;b" }, "exact")).toThrow();
    expect(() => buildDbStatsScript("MYSQL", "c", { ...creds, database: "d b" }, "exact")).toThrow();
    expect(() => buildDbStatsScript("MONGO", "c", creds, "exact")).toThrow();
    expect(statsKindOf("MONGO")).toBeNull();
    expect(statsKindOf("POSTGRES")).toBe("tables");
    expect(statsKindOf("KEYDB")).toBe("keys");
  });
});

describe("parsers", () => {
  it("parse table lines", () => {
    expect(parseTableStats("public.users\t42\t0\r\npublic.ticks\t9000000\t1\n\nsales.o\t-1\t0\n")).toEqual([
      { name: "public.users", rows: 42, estimated: false, expires: 0 },
      { name: "public.ticks", rows: 9000000, estimated: true, expires: 0 },
      { name: "sales.o", rows: -1, estimated: false, expires: 0 },
    ]);
    expect(parseTableStats("")).toEqual([]);
    for (const bad of ["x\n", "a\tb\t0\n", "a\t5\t2\n", "a\t-2\t0\n", "\t5\t0\n", "a\t5\t0\tx\n", "psql: error: boom\n"]) expect(parseTableStats(bad)).toBe("unparseable");
  });
  it("parse the keyspace and require the header", () => {
    expect(parseKeyspaceStats("# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=1000\r\ndb2:keys=1,expires=0,avg_ttl=0,subexpiry=0\r\n")).toEqual([
      { name: "db0", rows: 12, estimated: false, expires: 3 },
      { name: "db2", rows: 1, estimated: false, expires: 0 },
    ]);
    expect(parseKeyspaceStats("# Keyspace\r\n")).toEqual([]);
    expect(parseKeyspaceStats("NOAUTH Authentication required.\n")).toBe("unparseable");
    expect(parseKeyspaceStats("")).toBe("no-keyspace");
    expect(parseKeyspaceStats("# Keyspace\ndb0:expires=3\n")).toBe("unparseable");
    expect(parseKeyspaceStats("# Keyspace\ndbx:keys=1\n")).toBe("unparseable");
  });
  it("statsFromOutput fails closed: non-zero exit, unparseable or no recipe never become a measurement", () => {
    const base = { itemRef: "database:_:a", engine: "POSTGRES", mode: "exact" as const };
    expect(statsFromOutput({ ...base, output: "a.b\t1\t0\n", exitCode: 0 })).toMatchObject({ state: "measured", tableCount: 1, kind: "tables" });
    expect(statsFromOutput({ ...base, output: "a.b\t1\t0\n", exitCode: 2 })).toMatchObject({ state: "failed", reason: "verify-exec", tables: [] });
    expect(statsFromOutput({ ...base, output: "garbage", exitCode: 0 })).toMatchObject({ state: "failed", reason: "verify-parse" });
    expect(statsFromOutput({ ...base, engine: "MONGO", output: "", exitCode: 0 })).toMatchObject({ state: "skipped", reason: "no-verify" });
    expect(statsFromOutput({ ...base, engine: "REDIS", output: "NOAUTH\n", exitCode: 0 })).toMatchObject({ state: "failed", reason: "verify-parse", kind: "keys" });
  });
});

const tbl = (name: string, rows: number, extra: Partial<StatsTable> = {}): StatsTable => ({ name, rows, estimated: false, expires: 0, ...extra });
const stats = (tables: StatsTable[], over: Partial<DbStats> = {}): DbStats => ({
  itemRef: "database:_:a",
  engine: "POSTGRES",
  kind: "tables",
  mode: "exact",
  state: "measured",
  reason: null,
  tableCount: tables.length,
  truncated: false,
  tables,
  ...over,
});

describe("compareDbStats", () => {
  it("equal counts pass", () => {
    const r = compareDbStats(stats([tbl("a", 5), tbl("b", 0)]), stats([tbl("a", 5), tbl("b", 0)]));
    expect(r).toMatchObject({ status: "pass", code: PARITY_CODES.match });
    expect(r.params).toMatchObject({ mode: "exact", relations: 2, differing: 0, sourceRows: 5, targetRows: 5 });
  });
  it("fewer rows on the target is a failure (a loss) and names the table", () => {
    const r = compareDbStats(stats([tbl("a", 5), tbl("b", 9)]), stats([tbl("a", 5), tbl("b", 8)]));
    expect(r).toMatchObject({ status: "fail", code: PARITY_CODES.mismatch, names: ["b"] });
  });
  it("more rows on the target is only a warning (a dark app may have written), never a pass", () => {
    expect(compareDbStats(stats([tbl("a", 5)]), stats([tbl("a", 7)]))).toMatchObject({ status: "warn", code: PARITY_CODES.targetExtra });
  });
  it("a table missing on the target fails, an extra one warns, an empty missing one is fine", () => {
    expect(compareDbStats(stats([tbl("a", 5), tbl("b", 1)]), stats([tbl("a", 5)]))).toMatchObject({ status: "fail", code: PARITY_CODES.tableMissing, names: ["b"] });
    expect(compareDbStats(stats([tbl("a", 5)]), stats([tbl("a", 5), tbl("z", 3)]))).toMatchObject({ status: "warn", code: PARITY_CODES.targetExtra });
    expect(compareDbStats(stats([tbl("a", 5), tbl("e", 0)]), stats([tbl("a", 5)]))).toMatchObject({ status: "pass" });
  });
  it("an uncounted relation on either side is unknown, never a pass", () => {
    expect(compareDbStats(stats([tbl("a", -1)]), stats([tbl("a", 5)]))).toMatchObject({ status: "unknown", code: PARITY_CODES.uncounted });
    expect(compareDbStats(stats([tbl("a", 5)]), stats([tbl("a", -1)]))).toMatchObject({ status: "unknown", code: PARITY_CODES.uncounted });
  });
  it("estimates compare with a tolerance and are labelled", () => {
    const src = stats([tbl("big", 5_000_000, { estimated: true })], { mode: "estimate" });
    expect(compareDbStats(src, stats([tbl("big", 6_000_000)], { mode: "estimate" }))).toMatchObject({ status: "warn", code: PARITY_CODES.estimateWithin });
    expect(compareDbStats(src, stats([tbl("big", 100_000)], { mode: "estimate" }))).toMatchObject({ status: "fail", code: PARITY_CODES.estimateOut });
    expect(compareDbStats(src, stats([tbl("big", 6_000_000)], { mode: "estimate" })).params.mode).toBe("estimate");
    expect(compareDbStats(stats([tbl("t", 0, { estimated: true })]), stats([tbl("t", 0, { estimated: true })]))).toMatchObject({ status: "pass" });
  });
  it("redis: a key with a TTL may expire in flight (warn), a real loss fails", () => {
    const k = (rows: number, expires = 0): DbStats => stats([tbl("db0", rows, { expires })], { engine: "REDIS", kind: "keys" });
    expect(compareDbStats(k(10), k(10))).toMatchObject({ status: "pass" });
    expect(compareDbStats(k(10, 3), k(8))).toMatchObject({ status: "warn", code: PARITY_CODES.ttlInFlight });
    expect(compareDbStats(k(10, 1), k(8))).toMatchObject({ status: "fail", code: PARITY_CODES.mismatch });
    expect(compareDbStats(k(10), k(12))).toMatchObject({ status: "warn", code: PARITY_CODES.targetExtra });
  });
  it("anything not measured on either side is unknown with the reason", () => {
    const ok = stats([tbl("a", 1)]);
    expect(compareDbStats(undefined, ok)).toMatchObject({ status: "unknown", code: PARITY_CODES.sourceUnavailable });
    expect(compareDbStats(stats([], { state: "skipped", reason: "not-running" }), ok)).toMatchObject({ status: "unknown", params: { reason: "not-running" } });
    expect(compareDbStats(ok, undefined)).toMatchObject({ status: "unknown", code: PARITY_CODES.targetUnavailable });
    expect(compareDbStats(ok, stats([], { state: "failed", reason: "verify-exec" }))).toMatchObject({ status: "unknown", code: PARITY_CODES.targetUnavailable });
    expect(compareDbStats(ok, stats([], { kind: "keys" }))).toMatchObject({ status: "unknown", params: { reason: "kind-differs" } });
  });
  it("a truncated report cannot prove parity", () => {
    expect(compareDbStats(stats([tbl("a", 1)], { truncated: true }), stats([tbl("a", 1)]))).toMatchObject({ status: "unknown", code: PARITY_CODES.truncated });
    // ...but a real failure still wins over truncation
    expect(compareDbStats(stats([tbl("a", 3)], { truncated: true }), stats([tbl("a", 1)]))).toMatchObject({ status: "fail" });
  });
});

describe("the MySQL body runs under sh with a fake client (same script as the migrator's)", () => {
  it("counts small tables exactly, estimates big ones, reports exotic names uncounted and fails on a failed listing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-mysql-"));
    try {
      writeFileSync(
        join(dir, "mysql"),
        `#!/bin/sh
sql=""; while [ $# -gt 0 ]; do if [ "$1" = -e ]; then sql="$2"; shift; fi; shift; done
case "$sql" in
  *information_schema.tables*)
    [ -n "$FAKE_FAIL_LIST" ] && exit 1
    printf 'users\\t10\\nbig_ticks\\t5000000\\nweird-name\\t3\\nfailing\\t1\\n';;
  *COUNT*users*) echo 11;;
  *COUNT*big_ticks*) echo 5000001;;
  *COUNT*failing*) exit 1;;
  *) exit 9;;
esac
`,
      );
      chmodSync(join(dir, "mysql"), 0o755);
      const run = (mode: string, fail = false) =>
        spawnSync("/bin/sh", ["-c", mysqlStatsBody("mysql"), "tugra-verify", "app", "appdb", mode, "1000000"], { env: { PATH: `${dir}:/usr/bin:/bin`, ...(fail ? { FAKE_FAIL_LIST: "1" } : {}) }, encoding: "utf8" });
      const exact = run("exact");
      expect(parseTableStats(exact.stdout)).toEqual([tbl("users", 11), tbl("big_ticks", 5000001), tbl("weird-name", -1), tbl("failing", -1)]);
      const est = run("estimate");
      expect(parseTableStats(est.stdout)).toEqual([tbl("users", 11), tbl("big_ticks", 5000000, { estimated: true }), tbl("weird-name", -1), tbl("failing", -1)]);
      expect(run("exact", true).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
