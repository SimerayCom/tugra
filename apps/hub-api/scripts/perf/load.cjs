#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY perf harness: drive the panel endpoints the way the web app polls them and record the hub's memory.
 *
 *   node scripts/perf/load.cjs --port 3100 --pid <hub pid> --label before --out result.json [--seconds 20] [--browsers 6]
 *                              [--phases home,server,apps,scan,logs,slowlog,soak] [--snapshot-dir dir]
 *
 * Each phase starts from a forced GC (hub needs --expose-gc) and reports: RSS before / peak / after (MB), heapUsed peak,
 * request count, errors and per-endpoint p50/p95/max latency + bytes. RSS is the kernel number (`ps`), i.e. what the OOM
 * killer looks at. A browser = one simulated open tab polling its page at the web app's real refetch intervals.
 */
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { SignJWT } = require("jose");

const a = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(a("port", 3100));
const PID = Number(a("pid"));
const SECONDS = Number(a("seconds", 20));
const BROWSERS = Number(a("browsers", 6));
const PHASES = a("phases", "home,server,scan,logs,slowlog,soak").split(",");
const LABEL = a("label", "run");
const OUT = a("out", "");
const SERVERS = Number(a("servers", 27));
const SECRET = process.env.JWT_ACCESS_SECRET || "test-jwt-access-secret-0123456789";
// No keep-alive: the hub closes idle sockets after 5 s, and a reused one racing that close shows up as a bogus ECONNRESET.
const agent = new http.Agent({ keepAlive: false, maxSockets: 256 });

const rssMb = () => Number(execFileSync("ps", ["-o", "rss=", "-p", String(PID)]).toString().trim()) / 1024;
const side = (p) =>
  new Promise((res, rej) =>
    http.get({ host: "127.0.0.1", port: PORT + 1, path: p, agent: false }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(JSON.parse(b || "{}")));
    }).on("error", rej),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = (i) => `perf-srv-${i}`;
const rnd = (n) => 1 + Math.floor(Math.random() * n);
const cname = (s, c) => `c${String(s).padStart(2, "0")}${String(c).padStart(2, "0")}x7kq9w3-${100000000000 + s * 1000 + c}`;

let token;
const stats = new Map(); // endpoint -> {n, err, bytes, lat[]}
function rec(name, ms, bytes, ok) {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { n: 0, err: 0, bytes: 0, lat: [], codes: {} }));
  s.n++;
  s.bytes += bytes;
  s.lat.push(ms);
  if (!ok.ok) {
    s.err++;
    s.codes[ok.code] = (s.codes[ok.code] || 0) + 1;
  }
}
function req(name, method, p) {
  return new Promise((resolve) => {
    const t = Date.now();
    const r = http.request({ host: "127.0.0.1", port: PORT, path: `/api/v1${p}`, method, agent, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let bytes = 0;
      res.on("data", (c) => (bytes += c.length));
      res.on("end", () => {
        rec(name, Date.now() - t, bytes, { ok: res.statusCode < 400, code: res.statusCode });
        resolve();
      });
    });
    r.on("error", () => {
      rec(name, Date.now() - t, 0, { ok: false, code: "ECONN" });
      resolve();
    });
    r.setTimeout(120_000, () => r.destroy());
    r.end();
  });
}
/** Open an SSE stream and hold it for `ms`; `slow` = stop reading (pause) to test server-side back-pressure. */
function sse(name, p, ms, slow = false) {
  return new Promise((resolve) => {
    const t = Date.now();
    const r = http.request({ host: "127.0.0.1", port: PORT, path: `/api/v1${p}`, method: "GET", agent: false, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }, (res) => {
      let bytes = 0;
      res.on("data", (c) => (bytes += c.length));
      if (slow) res.pause();
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        rec(name, Date.now() - t, bytes, { ok: res.statusCode < 400, code: res.statusCode });
        resolve();
      };
      res.on("close", done);
      // A paused reader may never see 'close' on destroy: do not let the phase hang on it.
      setTimeout(() => { r.destroy(); setTimeout(done, 1000); }, ms);
    });
    r.on("error", () => resolve());
    r.end();
  });
}

const pages = {
  // /fleet + /dashboard: servers (5s), fleet/metrics/latest (5s/10s), trend, hottest containers, insights (10s), costs
  home: async (end) => {
    while (Date.now() < end) {
      await Promise.all([
        req("GET /servers", "GET", "/servers"),
        req("GET /fleet/metrics/latest", "GET", "/fleet/metrics/latest"),
        req("GET /fleet/metrics/trend", "GET", "/fleet/metrics/trend?minutes=30"),
        req("GET /fleet/containers/hottest", "GET", "/fleet/containers/hottest?limit=10"),
        req("GET /dashboard/insights", "GET", "/dashboard/insights"),
        req("GET /costs", "GET", "/costs"),
        req("GET /costs/advice", "GET", "/costs/advice"),
      ]);
      await sleep(5000);
    }
  },
  // server detail: server, metrics ranges, containers inventory, scan view, gpus view, disk usage
  server: async (end) => {
    const s = srv(rnd(SERVERS));
    const ranges = ["1h", "6h", "24h", "7d"];
    while (Date.now() < end) {
      await Promise.all([
        req("GET /servers/:id", "GET", `/servers/${s}`),
        req("GET /servers/:id/metrics (recent)", "GET", `/servers/${s}/metrics?limit=60`),
        ...ranges.map((r) => req(`GET /servers/:id/metrics?range=${r}`, "GET", `/servers/${s}/metrics?range=${r}`)),
        req("GET /servers/:id/metrics/containers", "GET", `/servers/${s}/metrics/containers`),
        req("GET /servers/:id/containers/all", "GET", `/servers/${s}/containers/all`),
        req("GET /servers/:id/scan", "GET", `/servers/${s}/scan`),
        req("GET /servers/:id/gpus", "GET", `/servers/${s}/gpus`),
      ]);
      await sleep(5000);
    }
  },
  // "Scan again" + GPU refresh clicks (the hub throttles each server to one real run per 10 s) plus the refetches the page does after
  scan: async (end) => {
    const s = srv(rnd(SERVERS));
    while (Date.now() < end) {
      await Promise.all([req("POST /servers/:id/scan", "POST", `/servers/${s}/scan`), req("POST /servers/:id/gpus/refresh", "POST", `/servers/${s}/gpus/refresh`)]);
      await Promise.all([
        req("GET /servers/:id/scan", "GET", `/servers/${s}/scan`),
        req("GET /fleet/metrics/latest", "GET", "/fleet/metrics/latest"),
        req("GET /dashboard/insights", "GET", "/dashboard/insights"),
      ]);
      await sleep(11_000);
    }
  },
  // Containers tab with a live tail-2000 stream open + log download + the tab's own polling
  logs: async (end) => {
    const s = rnd(SERVERS);
    const c = cname(s, rnd(17));
    const lifetime = end - Date.now();
    const stream = sse("SSE containers/logs/stream tail=2000", `/servers/${srv(s)}/containers/logs/stream?container=${c}&tail=2000&follow=1`, lifetime);
    await sleep(500);
    while (Date.now() < end) {
      await Promise.all([
        req("GET /servers/:id/metrics/containers", "GET", `/servers/${srv(s)}/metrics/containers`),
        req("GET /servers/:id/containers/all", "GET", `/servers/${srv(s)}/containers/all`),
        req("GET /servers/:id/containers/logs/download", "GET", `/servers/${srv(s)}/containers/logs/download?container=${c}&tail=10000`),
      ]);
      await sleep(5000);
    }
    await stream;
  },
  // An app page and a database page (needs `seed.cjs --apps`): the Metrics tab's per-container history at every range, plus the
  // app/database/backup/deploy lists the dashboard sections read.
  apps: async (end) => {
    const s = rnd(SERVERS);
    const app = `perfapp${s}x${rnd(3)}`;
    const db = `perfdb${s}`;
    const ranges = ["1h", "6h", "24h", "7d"];
    while (Date.now() < end) {
      await Promise.all([
        ...ranges.map((r) => req(`GET /applications/:id/metrics/containers?range=${r}`, "GET", `/applications/${app}/metrics/containers?range=${r}`)),
        ...ranges.map((r) => req(`GET /databases/:id/metrics/containers?range=${r}`, "GET", `/databases/${db}/metrics/containers?range=${r}`)),
        req("GET /applications", "GET", "/applications"),
        req("GET /databases", "GET", "/databases"),
        req("GET /dashboard/insights", "GET", "/dashboard/insights"),
      ]);
      await sleep(5000);
    }
  },
  // A browser tab that stops reading the stream (background tab / stalled proxy): the hub must not buffer it without bound.
  slowlog: async (end) => {
    const s = rnd(SERVERS);
    await sse("SSE slow reader tail=2000", `/servers/${srv(s)}/containers/logs/stream?container=${cname(s, rnd(17))}&tail=2000&follow=1`, end - Date.now(), true);
  },
};

async function phase(name, fn, browsers) {
  stats.clear();
  await side("/gc");
  await sleep(1500);
  await side("/gc");
  const before = rssMb();
  const heap0 = (await side("/mem")).heapUsed / 1048576;
  let peak = before;
  let heapPeak = heap0;
  const end = Date.now() + SECONDS * 1000;
  const sampler = setInterval(async () => {
    peak = Math.max(peak, rssMb());
    try {
      heapPeak = Math.max(heapPeak, (await side("/mem")).heapUsed / 1048576);
    } catch {}
  }, 250);
  await Promise.all(Array.from({ length: browsers }, () => fn(end)));
  clearInterval(sampler);
  const afterNoGc = rssMb();
  await side("/gc");
  await sleep(1000);
  await side("/gc");
  const mem = await side("/mem");
  const endpoints = {};
  for (const [k, v] of stats) {
    const l = v.lat.sort((x, y) => x - y);
    endpoints[k] = { n: v.n, err: v.err, codes: v.codes, kbPerReq: Math.round(v.bytes / v.n / 1024), p50: l[Math.floor(l.length * 0.5)], p95: l[Math.floor(l.length * 0.95)], max: l[l.length - 1] };
  }
  const row = { phase: name, browsers, rssBeforeMb: Math.round(before), rssPeakMb: Math.round(peak), rssEndNoGcMb: Math.round(afterNoGc), rssAfterGcMb: Math.round(rssMb()), heapUsedBeforeMb: Math.round(heap0), heapUsedPeakMb: Math.round(heapPeak), heapUsedAfterGcMb: Math.round(mem.heapUsed / 1048576), endpoints };
  console.log(`[${LABEL}] ${name} x${browsers}: rss ${row.rssBeforeMb} -> peak ${row.rssPeakMb} MB (after gc ${row.rssAfterGcMb}); heapUsed peak ${row.heapUsedPeakMb} MB`);
  return row;
}

(async () => {
  token = await new SignJWT({ sub: "perf-user", type: "access" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("6h").sign(new TextEncoder().encode(SECRET));
  const results = [];
  const run = async (n, fn, b) => results.push(await phase(n, fn, b));
  for (const p of PHASES) {
    if (p.startsWith("url:")) {
      // One endpoint hammered back to back by every browser (finds which single call allocates): --phases url:/servers/perf-srv-3/metrics?range=24h
      const u = p.slice(4);
      await run(`url ${u}`, async (end) => {
        while (Date.now() < end) await req(`GET ${u}`, "GET", u);
      }, BROWSERS);
    }
    if (p === "home") await run("home", pages.home, BROWSERS);
    if (p === "server") await run("server", pages.server, BROWSERS);
    if (p === "scan") await run("scan", pages.scan, 3);
    if (p === "apps") await run("apps", pages.apps, BROWSERS);
    if (p === "logs") await run("logs", pages.logs, 3);
    if (p === "slowlog") await run("slowlog", pages.slowlog, 3);
    if (p === "soak") {
      await run(
        "soak",
        async (end) => {
          const fns = [pages.home, pages.server, pages.scan, pages.logs];
          await fns[Math.floor(Math.random() * fns.length)](end);
        },
        BROWSERS * 2,
      );
    }
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, seconds: SECONDS, browsers: BROWSERS, results }, null, 2));
  process.exit(0);
})();
