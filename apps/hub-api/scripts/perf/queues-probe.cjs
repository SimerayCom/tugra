#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY perf harness: what the hub's BullMQ layer costs in Redis.
 *
 *   REDIS_URL=redis://127.0.0.1:6379 node scripts/perf/queues-probe.cjs [--pid <hub pid>] [--label before] [--json]
 *
 * Prints the number of Redis client sockets (CLIENT LIST, minus this probe), the BullMQ queues found (`bull:<name>:meta`)
 * with their repeat-key / delayed / wait counts, and, with --pid, the hub's RSS. Run it against a Redis that only the
 * hub under test uses, otherwise the socket count includes other programs.
 */
const Redis = require("ioredis");
const { execFileSync } = require("node:child_process");
const a = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
(async () => {
  const r = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  const list = String(await r.client("LIST")).trim().split("\n").filter(Boolean);
  const me = list.length; // this probe is one of them
  const byName = {};
  for (const l of list) {
    const n = /name=(\S*)/.exec(l)?.[1] || "(unnamed)";
    const key = n.replace(/:[0-9a-f-]{8,}.*$/, "").replace(/:\d+$/, "");
    byName[key] = (byName[key] || 0) + 1;
  }
  const queues = {};
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", "bull:*:meta", "COUNT", 500);
    cursor = next;
    for (const k of keys) {
      const q = k.slice(5, -5);
      queues[q] = {
        repeat: await r.zcard(`bull:${q}:repeat`),
        delayed: await r.zcard(`bull:${q}:delayed`),
        wait: await r.llen(`bull:${q}:wait`),
        completed: await r.zcard(`bull:${q}:completed`),
        failed: await r.zcard(`bull:${q}:failed`),
      };
    }
  } while (cursor !== "0");
  const info = await r.info("memory");
  const out = {
    label: a("label", ""),
    redisClients: me - 1,
    clientNames: byName,
    queues: Object.keys(queues).length,
    queueDetail: queues,
    redisUsedMemoryMB: Number(/used_memory:(\d+)/.exec(info)[1]) / 1048576,
  };
  if (a("pid")) out.hubRssMB = Number(execFileSync("ps", ["-o", "rss=", "-p", a("pid")]).toString().trim()) / 1024;
  if (process.argv.includes("--json")) console.log(JSON.stringify(out));
  else {
    console.log(`redis clients (excluding probe): ${out.redisClients}`);
    console.log(`bull queues in redis: ${out.queues}`);
    console.table(queues);
    if (out.hubRssMB) console.log(`hub RSS: ${out.hubRssMB.toFixed(1)} MB`);
    console.log(`redis used_memory: ${out.redisUsedMemoryMB.toFixed(2)} MB`);
  }
  r.disconnect();
})();
