#!/usr/bin/env node
// Throttling TCP proxy for the migration lab (L3 mechanics). Node stdlib `net` only, no dependencies.
//
//   node throttle-proxy.mjs --listen 4001 --target 127.0.0.1:3000 --rate 10 [--host 0.0.0.0] [--down-rate MB/s]
//
// --rate is MB/s (10^6 bytes) in the UPLOAD direction (client -> target: the migrator's part PUTs), shared by every
// connection like one physical link; 0 = unlimited. --down-rate throttles the other way (default unlimited). On SIGTERM it
// prints the byte totals to stderr, so a scenario can compare the measured rate with the configured one.
// The pacing is by backpressure (the reader is paused until the budget catches up), so the sender sees a slow link, not a
// dropped one, and memory stays bounded to one chunk per connection.
import net from "node:net";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k.startsWith("--") || i + 1 >= process.argv.length) { console.error(`usage: throttle-proxy.mjs --listen PORT --target HOST:PORT --rate MBPS [--host ADDR] [--down-rate MBPS]`); process.exit(2); }
  args.set(k.slice(2), process.argv[i + 1]);
}
const listenPort = Number(args.get("listen"));
const [tHost, tPortS] = String(args.get("target") ?? "").split(":");
const tPort = Number(tPortS);
const upRate = Number(args.get("rate") ?? 0) * 1e6; // bytes per second
const downRate = Number(args.get("down-rate") ?? 0) * 1e6;
const bindHost = args.get("host") ?? "0.0.0.0";
if (!Number.isInteger(listenPort) || !tHost || !Number.isInteger(tPort) || !(upRate >= 0) || !(downRate >= 0)) {
  console.error("throttle-proxy: bad --listen / --target / --rate");
  process.exit(2);
}

// One shared budget per direction: `free` is the wall-clock time (ms) at which everything sent so far has "left the link".
function limiter(bytesPerSec) {
  let free = 0;
  return (n) => {
    if (bytesPerSec <= 0) return 0;
    const now = performance.now();
    free = Math.max(free, now) + (n / bytesPerSec) * 1000;
    return Math.max(0, free - now);
  };
}
const upLimit = limiter(upRate);
const downLimit = limiter(downRate);
let up = 0;
let down = 0;
let conns = 0;
const SLACK_MS = 4; // sub-timer-resolution debts are carried, not slept (high rates stay accurate)

function pipe(from, to, limit, count) {
  from.on("data", (chunk) => {
    count(chunk.length);
    to.write(chunk);
    const wait = limit(chunk.length);
    if (wait > SLACK_MS) {
      from.pause();
      setTimeout(() => from.resume(), wait - SLACK_MS);
    }
  });
  from.on("end", () => to.end());
  from.on("error", () => to.destroy());
  to.on("close", () => from.destroy());
}

const server = net.createServer((client) => {
  conns++;
  const upstream = net.connect(tPort, tHost);
  upstream.setNoDelay(true);
  client.setNoDelay(true);
  pipe(client, upstream, upLimit, (n) => { up += n; });
  pipe(upstream, client, downLimit, (n) => { down += n; });
  upstream.on("error", () => client.destroy());
});
server.listen(listenPort, bindHost, () => {
  console.error(`throttle-proxy: ${bindHost}:${listenPort} -> ${tHost}:${tPort} up=${upRate ? upRate / 1e6 + " MB/s" : "unlimited"} down=${downRate ? downRate / 1e6 + " MB/s" : "unlimited"}`);
});
const stats = () => { console.error(`throttle-proxy: connections=${conns} up=${up} bytes down=${down} bytes`); process.exit(0); };
process.on("SIGTERM", stats);
process.on("SIGINT", stats);
