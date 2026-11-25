#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY perf harness: measure what the agent-telemetry ingest path costs the DATABASE and the hub PROCESS.
 * Run while hub-boot.cjs is up with FAKE_TELEMETRY_SERVERS=N (see fake-telemetry.cjs); needs a scratch Postgres with
 * `shared_preload_libraries = 'pg_stat_statements'` (+ CREATE EXTENSION pg_stat_statements).
 *
 *   DATABASE_URL=postgresql://... node scripts/perf/ingest-measure.cjs --port 3100 --pid <hub pid> --label after \
 *       [--warmup 60] [--seconds 180] [--out result.json]
 *
 * Reports, over the measured window (after a warm-up that is excluded): DB statements/s (pg_stat_statements calls, this
 * script's own queries excluded) grouped by statement shape, per-table tuples inserted/updated/dead, and the hub's RSS
 * (kernel number, `ps`) min/avg/max plus CPU % of ONE core (user+system time delta / wall time).
 */
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");

const a = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(a("port", 3100));
const PID = Number(a("pid"));
const WARMUP = Number(a("warmup", 60));
const SECONDS = Number(a("seconds", 180));
const LABEL = a("label", "run");
const OUT = a("out", "");
const prisma = new PrismaClient();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = () => {
  const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(PID)]).toString().trim().split(/\s+/);
  const parts = time.split(":").map(Number); // [H:]M:SS.xx
  const cpuS = parts.reduce((acc, p) => acc * 60 + p, 0);
  return { rssMb: Number(rss) / 1024, cpuS };
};
const side = () =>
  new Promise((res) =>
    http
      .get({ host: "127.0.0.1", port: PORT + 1, path: "/", agent: false }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => res(JSON.parse(b)));
      })
      .on("error", () => res({})),
  );

const shape = (q) => {
  const s = q.replace(/\s+/g, " ").trim();
  let m = /^(INSERT INTO|UPDATE|DELETE FROM|SELECT)\b/i.exec(s);
  const verb = m ? m[1].toUpperCase().replace(" INTO", "").replace(" FROM", "") : s.slice(0, 12);
  const t = /(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+(?:"public"\.)?"?([A-Za-z_]+)"?/i.exec(s);
  return `${verb} ${t ? t[1] : "?"}`;
};

(async () => {
  console.log(`[${LABEL}] warm-up ${WARMUP}s (excluded) ...`);
  await sleep(WARMUP * 1000);
  await prisma.$queryRawUnsafe("SELECT 1 AS ok FROM (SELECT pg_stat_statements_reset()) x");
  const tabs0 = await prisma.$queryRawUnsafe(`SELECT relname, n_tup_ins::int ins, n_tup_upd::int upd, n_tup_hot_upd::int hot, n_tup_del::int del FROM pg_stat_user_tables`);
  const db0 = (await prisma.$queryRawUnsafe(`SELECT xact_commit::int c, xact_rollback::int r FROM pg_stat_database WHERE datname = current_database()`))[0];
  const side0 = await side();
  const p0 = ps();
  const t0 = Date.now();
  const rss = [p0.rssMb];
  const heap = [];
  console.log(`[${LABEL}] measuring ${SECONDS}s ...`);
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(1000);
    rss.push(ps().rssMb);
    const s = await side();
    if (s.heapUsed) heap.push(s.heapUsed / 1048576);
  }
  const secs = (Date.now() - t0) / 1000;
  const p1 = ps();
  const side1 = await side();
  const stm = await prisma.$queryRawUnsafe(
    `SELECT query, calls::int calls, rows::int rows, round(total_exec_time::numeric, 1)::float ms FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT ILIKE '%pg_stat_%'`,
  );
  const tabs1 = await prisma.$queryRawUnsafe(`SELECT relname, n_tup_ins::int ins, n_tup_upd::int upd, n_tup_hot_upd::int hot, n_tup_del::int del, n_dead_tup::int dead FROM pg_stat_user_tables`);
  const db1 = (await prisma.$queryRawUnsafe(`SELECT xact_commit::int c, xact_rollback::int r FROM pg_stat_database WHERE datname = current_database()`))[0];

  const groups = new Map();
  let total = 0;
  let fkChecks = 0; // Postgres' own per-row foreign-key probes (SELECT ... FROM ONLY "Server" ... FOR KEY SHARE): not client statements
  for (const r of stm) {
    if (/FROM ONLY/i.test(r.query)) {
      fkChecks += r.calls;
      continue;
    }
    const k = shape(r.query);
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT \?|SET|SHOW|DEALLOCATE)/i.test(k)) continue;
    total += r.calls;
    const g = groups.get(k) || { calls: 0, rows: 0, ms: 0 };
    g.calls += r.calls;
    g.rows += r.rows;
    g.ms += r.ms;
    groups.set(k, g);
  }
  const top = [...groups.entries()].sort((x, y) => y[1].calls - x[1].calls).slice(0, 14).map(([k, g]) => ({ shape: k, perSec: +(g.calls / secs).toFixed(2), rowsPerSec: +(g.rows / secs).toFixed(1), dbMsPerSec: +(g.ms / secs).toFixed(1) }));
  const t0m = new Map(tabs0.map((t) => [t.relname, t]));
  const tables = tabs1
    .map((t) => {
      const b = t0m.get(t.relname) || { ins: 0, upd: 0, hot: 0, del: 0 };
      return { table: t.relname, insPerSec: +((t.ins - b.ins) / secs).toFixed(2), updPerSec: +((t.upd - b.upd) / secs).toFixed(2), hotPct: t.upd - b.upd ? Math.round(((t.hot - b.hot) / (t.upd - b.upd)) * 100) : null, dead: t.dead };
    })
    .filter((t) => t.insPerSec > 0 || t.updPerSec > 0)
    .sort((x, y) => y.insPerSec + y.updPerSec - (x.insPerSec + x.updPerSec))
    .slice(0, 10);
  const result = {
    label: LABEL,
    windowSec: Math.round(secs),
    sent: side1.sent && side0.sent ? Object.fromEntries(Object.keys(side1.sent).map((k) => [k, side1.sent[k] - side0.sent[k]])) : undefined,
    dbStatementsPerSec: +(total / secs).toFixed(2),
    fkChecksPerSecInternal: +(fkChecks / secs).toFixed(2),
    dbTransactionsPerSec: +((db1.c + db1.r - db0.c - db0.r) / secs).toFixed(2),
    topStatements: top,
    tables,
    hub: {
      rssMb: { min: +Math.min(...rss).toFixed(0), avg: +(rss.reduce((s, v) => s + v, 0) / rss.length).toFixed(0), max: +Math.max(...rss).toFixed(0) },
      heapUsedMb: heap.length ? { avg: +(heap.reduce((s, v) => s + v, 0) / heap.length).toFixed(0), max: +Math.max(...heap).toFixed(0) } : undefined,
      cpuPctOfOneCore: +(((p1.cpuS - p0.cpuS) / secs) * 100).toFixed(1),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
