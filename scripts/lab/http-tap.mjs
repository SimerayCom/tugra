#!/usr/bin/env node
// HTTP pass-through for the migration lab (L8). Node stdlib only.
//
//   node http-tap.mjs --listen 4002 --target 127.0.0.1:3000 --busy-file PATH [--host ADDR]
//                     [--barrier N --barrier-file PATH [--barrier-timeout SECONDS]]
//
// Forwards every request to the hub unchanged and streams request and response bodies (a part PUT is never buffered). The one
// thing it reads is the answer to `POST .../parts/<n>` (a small JSON): when the relay pool is full the hub answers
// {"busy":true}, which the migrator waits out silently. Each such answer appends one line "<epoch-ms>" to --busy-file, so a
// scenario can PROVE the migration seat pool was contended instead of inferring it from wall times.
//
// --barrier N holds every `GET .../targets` (the migrator's last hub call before it removes helper containers on its docker host)
// until N DIFFERENT bearer tokens (N migrators) have asked, then releases them all at once; after that it passes everything. The
// migrator's startup removes every container labelled tugra.vx=1 on its docker host, not just its own, so several migrators on one
// host must all pass that point before any of them starts a helper: the barrier lines them up. --barrier-timeout (default 120 s)
// releases a short group anyway. One line is appended to --barrier-file: "released all <n>" or "released timeout <seen>/<n>".
import http from "node:http";
import { appendFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k.startsWith("--") || i + 1 >= process.argv.length) { console.error("usage: http-tap.mjs --listen PORT --target HOST:PORT --busy-file PATH [--host ADDR] [--barrier N --barrier-file PATH [--barrier-timeout SECONDS]]"); process.exit(2); }
  args.set(k.slice(2), process.argv[i + 1]);
}
const listenPort = Number(args.get("listen"));
const [tHost, tPortS] = String(args.get("target") ?? "").split(":");
const tPort = Number(tPortS);
const busyFile = args.get("busy-file");
const bindHost = args.get("host") ?? "0.0.0.0";
const barrierN = args.has("barrier") ? Number(args.get("barrier")) : 0;
const barrierFile = args.get("barrier-file");
const barrierTimeoutMs = (args.has("barrier-timeout") ? Number(args.get("barrier-timeout")) : 120) * 1000;
if (!Number.isInteger(barrierN) || barrierN < 0 || (barrierN > 0 && !barrierFile) || !(barrierTimeoutMs > 0)) {
  console.error("http-tap: bad --barrier / --barrier-file / --barrier-timeout");
  process.exit(2);
}
if (!Number.isInteger(listenPort) || !tHost || !Number.isInteger(tPort) || !busyFile) {
  console.error("http-tap: bad --listen / --target / --busy-file");
  process.exit(2);
}

const PART_REGISTER = /\/parts\/\d+(\?.*)?$/;
const TARGETS = /\/targets(\?.*)?$/;

// the barrier: resolves once barrierN distinct tokens waited at it (or the timeout passed); resolved forever after
const waiting = new Set();
let barrierOpen = barrierN === 0;
let barrierWake;
const barrierDone = new Promise((r) => { barrierWake = r; });
let barrierTimer;
function openBarrier(how) {
  if (barrierOpen) return;
  barrierOpen = true;
  clearTimeout(barrierTimer);
  try { appendFileSync(barrierFile, how === "all" ? `released all ${waiting.size}\n` : `released timeout ${waiting.size}/${barrierN}\n`); } catch { /* the file is the scenario's proof only */ }
  barrierWake();
}
function pass(req) {
  if (barrierOpen || req.method !== "GET" || !TARGETS.test(req.url ?? "")) return Promise.resolve();
  waiting.add(String(req.headers.authorization ?? ""));
  if (waiting.size >= barrierN) openBarrier("all");
  else if (!barrierTimer) barrierTimer = setTimeout(() => openBarrier("timeout"), barrierTimeoutMs);
  return barrierDone;
}

const server = http.createServer(async (req, res) => {
  await pass(req);
  const watch = req.method === "POST" && PART_REGISTER.test(req.url ?? "");
  const up = http.request({ host: tHost, port: tPort, path: req.url, method: req.method, headers: req.headers }, (back) => {
    res.writeHead(back.statusCode ?? 502, back.headers);
    if (!watch) { back.pipe(res); return; }
    const chunks = [];
    back.on("data", (c) => { chunks.push(c); res.write(c); });
    back.on("end", () => {
      res.end();
      try { if (JSON.parse(Buffer.concat(chunks).toString("utf8")).busy === true) appendFileSync(busyFile, `${Date.now()}\n`); } catch { /* not JSON: nothing to count */ }
    });
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on("close", () => up.destroy());
  req.pipe(up);
});
server.listen(listenPort, bindHost);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
