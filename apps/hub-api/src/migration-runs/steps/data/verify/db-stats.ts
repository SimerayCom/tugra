/**
 * DB logical parity (design 4.1): the statements the hub runs on the TARGET database, their parsers, and the comparison
 * with what the migrator measured on the SOURCE (`agent/internal/migrate/verify.go`, which builds the identical statements
 * and prints the identical shape). Both sides are pinned by goldens (`db-stats.spec.ts` here, `verify_test.go` there):
 * change one without the other and a test fails.
 *
 * Trust: the target numbers are `hub-verified` (the hub ran the statement itself through the target agent); the source
 * numbers come from an untrusted host (`migrator-reported`). A comparison therefore carries the weaker label.
 *
 * Output shape (both engines families):
 *  - tables: one line per relation `name<TAB>rows<TAB>estimated`, rows -1 = not counted,
 *  - keys (Redis family): `INFO keyspace`, `dbN:keys=K,expires=E,...` under a `# Keyspace` header.
 */
import type { CodeParams } from "../../../core/dto";
import type { CheckStatusValue, DbStats, StatsTable } from "../data-contract";
import { shq } from "../source-control/source-scripts";

export const STATS_TAB = "\t";
export const DEFAULT_EXACT_BELOW = 1_000_000;
export const MAX_STATS_TABLES = 5000;
/** In estimate mode a planner estimate may be off by this factor either way before it counts as a mismatch. */
export const ESTIMATE_TOLERANCE = 2;

// ───────────────────────────── statements (mirror of verify.go) ─────────────────────────────

const PG_COUNT_EXPR = `(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text`;
const PG_RELATIONS =
  " FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace" +
  " WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema')" +
  " AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' ORDER BY 1";

export function pgStatsSql(mode: "exact" | "estimate", below: number): string {
  if (mode === "exact") return `SELECT n.nspname || '.' || c.relname, ${PG_COUNT_EXPR}, '0'${PG_RELATIONS}`;
  assertThreshold(below);
  return `SELECT n.nspname || '.' || c.relname, CASE WHEN c.reltuples >= ${below} THEN c.reltuples::bigint::text ELSE ${PG_COUNT_EXPR} END, CASE WHEN c.reltuples >= ${below} THEN '1' ELSE '0' END${PG_RELATIONS}`;
}

/** The constant in-container script for MySQL (`mysql`) and MariaDB (`mariadb`). $1 user, $2 db, $3 mode, $4 threshold. */
export function mysqlStatsBody(client: "mysql" | "mariadb"): string {
  const c = `${client} -u"$1" --protocol=TCP -h127.0.0.1 -N -B`;
  return (
    `T=$(printf '\\t'); ` +
    `L=$(${c} -e "SELECT table_name, IFNULL(table_rows,0) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name" "$2") || exit 1; ` +
    `[ -n "$L" ] || exit 0; ` +
    `printf '%s\\n' "$L" | while IFS="$T" read -r t est; do ` +
    `case "$t" in ''|*[!A-Za-z0-9_$]*) printf '%s\\t-1\\t0\\n' "$t"; continue;; esac; ` +
    `if [ "$3" = estimate ] && [ "$est" -ge "$4" ]; then printf '%s\\t%s\\t1\\n' "$t" "$est"; continue; fi; ` +
    `n=$(${c} -e "SELECT COUNT(*) FROM \\\`$t\\\`" "$2") || { printf '%s\\t-1\\t0\\n' "$t"; continue; }; ` +
    `printf '%s\\t%s\\t0\\n' "$t" "$n"; done`
  );
}

function assertThreshold(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000_000_000) throw new Error("invalid threshold");
}

const IDENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,79}$/;
const CTR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface StatsCreds {
  username: string;
  password: string;
  database: string;
}

/**
 * The shell command that measures one TARGET database (run on the target agent under the `database` capability). The
 * password rides the `docker exec -e NAME=value` of the hub-built script exactly like every other database script the
 * hub builds (backup, restore); user/db/mode are validated and quoted.
 */
export function buildDbStatsScript(engine: string, container: string, creds: StatsCreds, mode: "exact" | "estimate", below = DEFAULT_EXACT_BELOW): string {
  if (!CTR_RE.test(container)) throw new Error("invalid container");
  switch (engine) {
    case "POSTGRES":
      assertIdents(creds);
      return `docker exec -e PGPASSWORD=${shq(creds.password)} ${container} psql -X -q -A -t -F ${shq(STATS_TAB)} -v ON_ERROR_STOP=1 -U ${shq(creds.username)} -d ${shq(creds.database)} -c ${shq(pgStatsSql(mode, below))}`;
    case "MYSQL":
    case "MARIADB": {
      assertIdents(creds);
      assertThreshold(below);
      const client = engine === "MARIADB" ? "mariadb" : "mysql";
      return `docker exec -e MYSQL_PWD=${shq(creds.password)} ${container} sh -c ${shq(mysqlStatsBody(client))} tugra-verify ${shq(creds.username)} ${shq(creds.database)} ${mode} ${below}`;
    }
    case "REDIS":
    case "DRAGONFLY":
      return `docker exec -e REDISCLI_AUTH=${shq(creds.password)} ${container} redis-cli --no-auth-warning INFO keyspace`;
    case "KEYDB":
      return `docker exec -e REDISCLI_AUTH=${shq(creds.password)} ${container} keydb-cli --no-auth-warning INFO keyspace`;
    default:
      throw new Error("engine has no stats statement");
  }
}

function assertIdents(c: StatsCreds): void {
  if (!IDENT_RE.test(c.username) || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/.test(c.database)) throw new Error("invalid database identifier");
}

export const statsKindOf = (engine: string): "tables" | "keys" | null => (["REDIS", "KEYDB", "DRAGONFLY"].includes(engine) ? "keys" : ["POSTGRES", "MYSQL", "MARIADB"].includes(engine) ? "tables" : null);

// ───────────────────────────── parsers (mirror of verify.go) ─────────────────────────────

export type StatsParseError = "unparseable" | "no-keyspace";

/** `name<TAB>rows<TAB>estimated` lines. One malformed line fails the whole answer. */
export function parseTableStats(out: string): StatsTable[] | StatsParseError {
  const tables: StatsTable[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const f = line.split(STATS_TAB);
    if (f.length !== 3 || !f[0] || f[0].length > 300) return "unparseable";
    if (!/^-?[0-9]{1,18}$/.test(f[1])) return "unparseable";
    const rows = Number(f[1]);
    if (rows < -1) return "unparseable";
    if (f[2] !== "0" && f[2] !== "1") return "unparseable";
    tables.push({ name: f[0].replace(/[\u0000-\u001f\u007f]/g, ""), rows, estimated: f[2] === "1", expires: 0 });
  }
  return tables;
}

/** `INFO keyspace`: the `# Keyspace` header is REQUIRED (a NOAUTH reply is not an empty keyspace). */
export function parseKeyspaceStats(out: string): StatsTable[] | StatsParseError {
  let seen = false;
  const tables: StatsTable[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    if (line.startsWith("# Keyspace")) {
      seen = true;
      continue;
    }
    const m = /^(db[0-9]{1,5}):(.*)$/.exec(line);
    if (!m) return "unparseable";
    let keys = -1;
    let expires = 0;
    for (const kv of m[2].split(",")) {
      const [k, v] = kv.split("=");
      if (k === "keys" && /^[0-9]{1,18}$/.test(v ?? "")) keys = Number(v);
      else if (k === "expires" && /^[0-9]{1,18}$/.test(v ?? "")) expires = Number(v);
    }
    if (keys < 0) return "unparseable";
    tables.push({ name: m[1], rows: keys, estimated: false, expires });
  }
  return seen ? tables : "no-keyspace";
}

/** Build a {@link DbStats} from a raw answer (the target side). */
export function statsFromOutput(input: { itemRef: string; engine: string; mode: "exact" | "estimate"; output: string; exitCode: number }): DbStats {
  const kind = statsKindOf(input.engine);
  const base = { itemRef: input.itemRef, engine: input.engine, kind: kind ?? "tables", mode: input.mode, tableCount: 0, truncated: false, tables: [] as StatsTable[] } as const;
  if (!kind) return { ...base, state: "skipped", reason: "no-verify" };
  if (input.exitCode !== 0) return { ...base, state: "failed", reason: "verify-exec" };
  const parsed = kind === "keys" ? parseKeyspaceStats(input.output) : parseTableStats(input.output);
  if (typeof parsed === "string") return { ...base, state: "failed", reason: "verify-parse" };
  const truncated = parsed.length > MAX_STATS_TABLES;
  return { ...base, state: "measured", reason: null, tableCount: parsed.length, truncated, tables: truncated ? parsed.slice(0, MAX_STATS_TABLES) : parsed };
}

// ───────────────────────────── comparison ─────────────────────────────

export const PARITY_CODES = {
  match: "verify.db-parity.match",
  mismatch: "verify.db-parity.mismatch",
  tableMissing: "verify.db-parity.table-missing",
  targetExtra: "verify.db-parity.target-extra",
  estimateWithin: "verify.db-parity.estimate-within-tolerance",
  estimateOut: "verify.db-parity.estimate-out-of-tolerance",
  ttlInFlight: "verify.db-parity.ttl-in-flight",
  uncounted: "verify.db-parity.uncounted",
  sourceUnavailable: "verify.db-parity.source-unavailable",
  targetUnavailable: "verify.db-parity.target-unavailable",
  truncated: "verify.db-parity.truncated",
} as const;

export interface ParityResult {
  status: CheckStatusValue;
  code: string;
  params: CodeParams;
  /** Names that did not match (capped), for the evidence row. */
  names: string[];
}

const RANK: Record<CheckStatusValue, number> = { pass: 0, warn: 1, unknown: 2, fail: 3 };

interface TableVerdict {
  status: CheckStatusValue;
  code: string;
  name: string;
}

function compareTable(kind: "tables" | "keys", name: string, s: StatsTable | undefined, t: StatsTable | undefined): TableVerdict {
  if (!s && t) return { status: "warn", code: PARITY_CODES.targetExtra, name };
  if (s && !t) return { status: s.rows === 0 ? "pass" : "fail", code: s.rows === 0 ? PARITY_CODES.match : PARITY_CODES.tableMissing, name };
  if (!s || !t) return { status: "pass", code: PARITY_CODES.match, name };
  if (s.rows < 0 || t.rows < 0) return { status: "unknown", code: PARITY_CODES.uncounted, name };
  if (kind === "keys") {
    if (t.rows === s.rows) return { status: "pass", code: PARITY_CODES.match, name };
    // a key with a TTL may expire between the two measurements (and an RDB load skips already-expired keys)
    if (t.rows < s.rows && s.rows - t.rows <= s.expires) return { status: "warn", code: PARITY_CODES.ttlInFlight, name };
    if (t.rows > s.rows) return { status: "warn", code: PARITY_CODES.targetExtra, name };
    return { status: "fail", code: PARITY_CODES.mismatch, name };
  }
  if (!s.estimated && !t.estimated) {
    if (t.rows === s.rows) return { status: "pass", code: PARITY_CODES.match, name };
    // more rows on the target: a dark app that already runs may have written (never a LOSS)
    if (t.rows > s.rows) return { status: "warn", code: PARITY_CODES.targetExtra, name };
    return { status: "fail", code: PARITY_CODES.mismatch, name };
  }
  if (s.rows === 0 && t.rows === 0) return { status: "pass", code: PARITY_CODES.match, name };
  const lo = s.rows / ESTIMATE_TOLERANCE;
  const hi = s.rows * ESTIMATE_TOLERANCE;
  return t.rows >= lo && t.rows <= hi ? { status: "warn", code: PARITY_CODES.estimateWithin, name } : { status: "fail", code: PARITY_CODES.estimateOut, name };
}

/** Compare the two sides of ONE database. `unknown` whenever either side did not measure (it never passes by default). */
export function compareDbStats(source: DbStats | undefined, target: DbStats | undefined): ParityResult {
  if (!source) return { status: "unknown", code: PARITY_CODES.sourceUnavailable, params: { reason: "not-reported" }, names: [] };
  if (source.state !== "measured") return { status: "unknown", code: PARITY_CODES.sourceUnavailable, params: { reason: source.reason ?? source.state }, names: [] };
  if (!target) return { status: "unknown", code: PARITY_CODES.targetUnavailable, params: { reason: "not-measured" }, names: [] };
  if (target.state !== "measured") return { status: "unknown", code: PARITY_CODES.targetUnavailable, params: { reason: target.reason ?? target.state }, names: [] };
  if (source.kind !== target.kind) return { status: "unknown", code: PARITY_CODES.targetUnavailable, params: { reason: "kind-differs" }, names: [] };

  const sm = new Map(source.tables.map((x) => [x.name, x]));
  const tm = new Map(target.tables.map((x) => [x.name, x]));
  const names = [...new Set([...sm.keys(), ...tm.keys()])].sort();
  const verdicts = names.map((n) => compareTable(source.kind, n, sm.get(n), tm.get(n)));
  let worst: TableVerdict = { status: "pass", code: PARITY_CODES.match, name: "" };
  for (const v of verdicts) if (RANK[v.status] > RANK[worst.status]) worst = v;
  // a truncated report cannot prove parity beyond what it carried
  if ((source.truncated || target.truncated) && RANK[worst.status] < RANK.unknown) worst = { status: "unknown", code: PARITY_CODES.truncated, name: "" };
  const bad = verdicts.filter((v) => v.status !== "pass");
  const total = (list: StatsTable[]) => list.reduce((a, b) => a + Math.max(0, b.rows), 0);
  return {
    status: worst.status,
    code: worst.code,
    params: {
      mode: source.mode === "exact" && target.mode === "exact" ? "exact" : "estimate",
      relations: names.length,
      differing: bad.length,
      sourceRows: total(source.tables),
      targetRows: total(target.tables),
      names: bad.slice(0, 10).map((v) => v.name),
    },
    names: bad.slice(0, 10).map((v) => v.name),
  };
}
