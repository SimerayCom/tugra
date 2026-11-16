#!/usr/bin/env node
// HTTP pass-through for the migration lab (L8). Node stdlib only.
//
//   node http-tap.mjs --listen 4002 --target 127.0.0.1:3000 --busy-file PATH [--host ADDR]
//
// Forwards every request to the hub unchanged and streams request and response bodies (a part PUT is never buffered). The one
// thing it reads is the answer to `POST .../parts/<n>` (a small JSON): when the relay pool is full the hub answers
// {"busy":true}, which the migrator waits out silently. Each such answer appends one line "<epoch-ms>" to --busy-file, so a
// scenario can PROVE the migration seat pool was contended instead of inferring it from wall times.
import http from "node:http";
import { appendFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k.startsWith("--") || i + 1 >= process.argv.length) { console.error("usage: http-tap.mjs --listen PORT --target HOST:PORT --busy-file PATH [--host ADDR]"); process.exit(2); }
  args.set(k.slice(2), process.argv[i + 1]);
}
const listenPort = Number(args.get("listen"));
const [tHost, tPortS] = String(args.get("target") ?? "").split(":");
const tPort = Number(tPortS);
const busyFile = args.get("busy-file");
const bindHost = args.get("host") ?? "0.0.0.0";
if (!Number.isInteger(listenPort) || !tHost || !Number.isInteger(tPort) || !busyFile) {
  console.error("http-tap: bad --listen / --target / --busy-file");
  process.exit(2);
}

const PART_REGISTER = /\/parts\/\d+(\?.*)?$/;

const server = http.createServer((req, res) => {
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
