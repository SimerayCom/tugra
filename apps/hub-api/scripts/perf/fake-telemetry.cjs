/* eslint-disable */
/**
 * DEV-ONLY perf harness: a fake-agent TELEMETRY generator at the real agent cadence, driven through the hub's real
 * message handler (AgentWsServer.onMessage), so every ingest path runs exactly as it does for a connected agent:
 *   - `metrics`           every 5 s per server  (agent metricsInterval)
 *   - `heartbeat`         every 5 s per server  (same ticker as metrics)
 *   - `container_metrics` every 15 s per server (agent containerStatsInterval), one sample per container
 * Loaded by hub-boot.cjs when FAKE_TELEMETRY_SERVERS is set:
 *
 *   FAKE_TELEMETRY_SERVERS=27 FAKE_TELEMETRY_CONTAINERS=17 DIST=dist/after PORT=3100 node --expose-gc scripts/perf/hub-boot.cjs
 *
 * Servers perf-srv-1..N must exist (seed.cjs creates 27); any missing one is created here. The fake sockets are
 * registered as the current authed socket of their server, so keepalive, heartbeat healing and markOffline behave
 * as in production. Container names match seed.cjs (so ContainerState / labels line up) and the fake `docker inspect`
 * answer in hub-boot.cjs, which drives the container-health poll over the same containers.
 */
const cname = (s, c) => `c${String(s).padStart(2, "0")}${String(c).padStart(2, "0")}x7kq9w3-${100000000000 + s * 1000 + c}`;

async function ensureServers(prisma, n) {
  const team = await prisma.team.findFirst({ where: { id: "perf-team" } });
  let teamId = team?.id;
  if (!teamId) {
    teamId = (await prisma.team.create({ data: { id: "perf-team", name: "Perf fleet" } })).id;
  }
  for (let i = 1; i <= n; i++) {
    const id = `perf-srv-${i}`;
    if (await prisma.server.findUnique({ where: { id }, select: { id: true } })) continue;
    await prisma.server.create({
      data: { id, name: `srv-${String(i).padStart(2, "0")}`, status: "ONLINE", enrollToken: `perf-enroll-${i}`, teamId, lastSeenAt: new Date(), agentVersion: "0.1.0-beta.27", hostname: `host-${i}`, cpuCores: 4, memTotalBytes: 8n * 1024n ** 3n },
    });
  }
}

function fakeSocket(st) {
  return {
    readyState: 1,
    OPEN: 1,
    send() {},
    close() {},
    terminate() {},
    on() {},
    // the keepalive sweep pings every socket and terminates one that did not pong: answer instantly
    ping() {
      st.isAlive = true;
    },
  };
}

/** Inspect output (container-health poll answer) for server `s` with `per` containers. */
function inspectOutput(s, per) {
  const lines = ["##INSPECT"];
  for (let c = 1; c <= per; c++) lines.push(`/${cname(s, c)}\t${cname(s, c)}id\trunning\t0\tfalse\t0\t2026-11-20T00:00:00Z\t0001-01-01T00:00:00Z\t`);
  lines.push("##EVENTS", "");
  return lines.join("\n");
}

async function start(ws, prisma, { servers, containers }) {
  await ensureServers(prisma, servers);
  const timers = [];
  let sent = { metrics: 0, heartbeat: 0, containers: 0 };
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let s = 1; s <= servers; s++) {
    const serverId = `perf-srv-${s}`;
    const st = { nonce: "n", authed: true, serverId, isAlive: true, features: new Set(), remoteIp: "127.0.0.1" };
    const socket = fakeSocket(st);
    ws.state.set(socket, st);
    ws.sockets.set(serverId, socket);
    const send = (msg) => ws.onMessage(socket, JSON.stringify(msg));
    const metricsTick = () => {
      const now = Date.now();
      sent.metrics++;
      sent.heartbeat++;
      void send({
        type: "metrics",
        sample: {
          ts: now, cpu: rnd(2, 60), memUsed: 3.1e9 + rnd(0, 1e8), memTotal: 8e9, diskUsed: 40e9, diskTotal: 160e9, netRx: rnd(1e3, 1e6), netTx: rnd(1e3, 1e6),
          diskRead: rnd(0, 1e6), diskWrite: rnd(0, 1e6), load1: rnd(0, 2), load5: rnd(0, 2), load15: rnd(0, 2), swapUsed: 0, swapTotal: 2e9,
        },
      });
      void send({ type: "heartbeat" });
    };
    const containerTick = () => {
      sent.containers++;
      const samples = [];
      for (let c = 1; c <= containers; c++) {
        samples.push({
          id: `${cname(s, c)}id`, name: cname(s, c), cpu: rnd(0, 30), memUsed: rnd(2e7, 4e8), memTotal: 8e9, memPct: rnd(0.2, 5),
          netRx: rnd(0, 1e5), netTx: rnd(0, 1e5), blkRead: rnd(0, 1e5), blkWrite: rnd(0, 1e5),
        });
      }
      void send({ type: "container_metrics", ts: Date.now(), samples });
    };
    // spread the agents over their interval like a real fleet (they all started at different moments)
    const j1 = setTimeout(() => {
      metricsTick();
      timers.push(setInterval(metricsTick, 5000));
    }, rnd(0, 5000));
    const j2 = setTimeout(() => {
      containerTick();
      timers.push(setInterval(containerTick, 15000));
    }, rnd(0, 15000));
    timers.push(j1, j2);
  }
  return {
    sent: () => ({ ...sent }),
    stop: () => timers.forEach((t) => (clearInterval(t), clearTimeout(t))),
  };
}

module.exports = { start, inspectOutput, cname };
