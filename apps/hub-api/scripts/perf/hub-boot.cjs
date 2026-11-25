#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY perf harness: boot the REAL hub (full AppModule, all schedulers, real HTTP stack) from a compiled dist
 * directory and replace ONLY the agent socket with an in-process fake agent, so the scan / gpu-refresh / container
 * list / live-log-stream / log-download endpoints can be driven without a real host.
 *
 *   DIST=dist/after PORT=3100 DATABASE_URL=... REDIS_URL=... node [--heapsnapshot-signal=SIGUSR2] scripts/perf/hub-boot.cjs
 *
 * Fake agent knobs (env): FAKE_LOG_LINES_PER_SEC (follow rate, default 200), FAKE_LOG_LINE_BYTES (default 220),
 * FAKE_TAIL_BYTES_CAP unused. The fake mimics the real agent's output caps (64 KB command output).
 */
require("reflect-metadata");
const path = require("node:path");
const dist = path.resolve(process.cwd(), process.env.DIST || "dist/after");
const { Test } = require("@nestjs/testing");
const { AppModule } = require(path.join(dist, "app.module"));
const { configureApp } = require(path.join(dist, "app-config"));
const { AgentWsServer } = require(path.join(dist, "agent-gateway/agent-ws.server"));

const LOG_RATE = Number(process.env.FAKE_LOG_LINES_PER_SEC || 200);
const LOG_LINE = Number(process.env.FAKE_LOG_LINE_BYTES || 220);

const line = (n) => `2026-11-25T07:00:00.${String(n % 1000).padStart(3, "0")}Z INFO request id=${n} ` + "x".repeat(Math.max(0, LOG_LINE - 60)) + "\n";

function dockerScan() {
  const rows = [];
  for (let c = 1; c <= 120; c++) {
    rows.push(JSON.stringify([`/svc-${c}-x7kq9w3-1000000${c}`, `nginx:1.27`, "running", c % 4 ? `proj-${c % 7}` : "", "web", "/data/coolify/applications/x", c % 2 ? "true" : "", "", c % 5 ? "8080 " : ""]));
  }
  return ["TUGRA_SCAN_DOCKER_BEGIN", ...rows, "TUGRA_SCAN_DOCKER_END"].join("\n");
}
function hostScan() {
  const j = { v: 1, markers: ["docker", "nginx"], pm2: [], sites: [], services: [{ unit: "nginx.service", kind: "web", enabled: true, running: true }], ports: [{ port: 22, proto: "tcp", scope: "public" }, { port: 443, proto: "tcp", scope: "public" }] };
  return `TUGRA_SCAN_HOST_BEGIN\n${JSON.stringify(j)}\nTUGRA_SCAN_HOST_END`;
}

(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  const ws = app.get(AgentWsServer);

  // ── fake agent: the only thing replaced ──
  ws.isOnline = () => true;
  ws.isCapabilityGranted = async () => true;
  ws.sendCommand = async (serverId, script) => {
    await new Promise((r) => setTimeout(r, 30));
    if (script.includes("TUGRA_SCAN_DOCKER_BEGIN")) return { exitCode: 0, output: dockerScan() };
    if (script.includes("TUGRA_SCAN_HOST_BEGIN")) return { exitCode: 0, output: hostScan() };
    if (script.includes("TUGRA_GPU_PROBE")) return { exitCode: 0, output: "TUGRA_GPU_PROBE v1\nTUGRA_GPU_PROBE_END" };
    if (script.startsWith("docker ps -a")) {
      let out = "";
      for (let c = 1; c <= 17; c++) out += `c${String(Number(serverId.replace(/\D/g, ""))).padStart(2, "0")}${String(c).padStart(2, "0")}x7kq9w3-${100000000000 + Number(serverId.replace(/\D/g, "")) * 1000 + c}\trunning\n`;
      return { exitCode: 0, output: out };
    }
    if (script.startsWith("docker logs")) {
      const m = /--tail (\d+)/.exec(script);
      const n = m ? Number(m[1]) : 1000;
      let out = "";
      for (let i = 0; i < n; i++) out += line(i);
      return { exitCode: 0, output: out };
    }
    return { exitCode: 0, output: "" };
  };
  const streams = new Map();
  let seq = 0;
  ws.startLogStream = async (serverId, params, listener) => {
    const id = `fake-${++seq}`;
    let tail = "";
    for (let i = 0; i < params.tail; i++) tail += line(i);
    setImmediate(() => listener.onChunk(tail));
    let n = 0;
    const t = setInterval(() => {
      let c = "";
      for (let i = 0; i < Math.max(1, Math.round(LOG_RATE / 10)); i++) c += line(n++);
      listener.onChunk(c);
    }, 100);
    streams.set(id, t);
    return id;
  };
  ws.stopLogStream = (serverId, id) => {
    clearInterval(streams.get(id));
    streams.delete(id);
  };

  const port = Number(process.env.PORT || 3100);
  await app.listen(port);
  // Side channel (loopback, perf only): process memory, forced GC and heap snapshots, on PORT+1.
  const v8 = require("node:v8");
  require("node:http")
    .createServer((req, res) => {
      if (req.url === "/gc" && global.gc) global.gc();
      if (req.url === "/snapshot") {
        const f = v8.writeHeapSnapshot(process.env.SNAPSHOT_DIR ? path.join(process.env.SNAPSHOT_DIR, `heap-${Date.now()}.heapsnapshot`) : undefined);
        return res.end(JSON.stringify({ file: f }));
      }
      const m = process.memoryUsage();
      const h = v8.getHeapStatistics();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, heapLimit: h.heap_size_limit }));
    })
    .listen(port + 1, "127.0.0.1");
  console.log(`hub-boot listening on :${port} (perf side channel :${port + 1}) pid=${process.pid} dist=${dist}`);
  process.on("SIGTERM", async () => {
    await app.close().catch(() => undefined);
    process.exit(0);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
