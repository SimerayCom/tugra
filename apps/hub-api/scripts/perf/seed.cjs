#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY perf harness: seed a LOCAL Postgres with a production-shaped fleet so hub-api memory can be measured.
 * Never shipped (apps/hub-api/scripts is outside tsconfig `include` and the Docker build copies dist/ only).
 *
 *   DATABASE_URL=postgresql://... node scripts/perf/seed.cjs [--servers 27] [--containers 17] [--raw-hours 48] [--rollup-days 14]
 *
 * Real cadences: host metrics every 5 s, per-container `docker stats` every 15 s (agent/internal/client), 1-minute rollups.
 * Defaults reproduce the owner's hub: 27 servers x 17 containers = 459 containers, raw kept 48 h (retention default),
 * rollups for 14 days. That is ~0.93 M Metric, ~5.3 M ContainerMetric, ~0.54 M MetricRollup and ~9.2 M ContainerMetricRollup rows.
 * Refuses to run against anything that is not a loopback database (it TRUNCATES the metric tables).
 */
const { PrismaClient } = require("@prisma/client");

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const SERVERS = arg("servers", 27);
const PER = arg("containers", 17);
const RAW_H = arg("raw-hours", 48);
const ROLLUP_D = arg("rollup-days", 14);

// Prisma writes `timestamp(3) without time zone` as UTC; a raw INSERT must use the same clock, whatever the PG session zone is.
const NOW = "(now() at time zone 'utc')";
const url = process.env.DATABASE_URL || "";
if (!/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) {
  console.error("refusing to seed a non-loopback DATABASE_URL");
  process.exit(2);
}

/** A stored "What runs on this server" report the size of a busy Coolify host (60 containers + software + ports). */
function scanReport(i) {
  const containers = Array.from({ length: 60 }, (_, c) => ({
    name: `svc-${i}-${c}-x7kq9w3-1000000${c}`,
    image: `ghcr.io/example/application-image-${c}:1.${c}.0`,
    state: "running",
    project: c % 4 ? `compose-project-${c % 7}` : null,
    service: "web",
    software: c % 3 ? "nginx" : null,
    managedBy: c % 2 ? "coolify" : null,
    ports: [8080, 8443],
    adoptable: false,
  }));
  return {
    v: 1,
    scannedAt: new Date().toISOString(),
    host: { status: "ok", reason: null },
    docker: { available: true, total: 60, running: 60, tugra: 0, truncated: false },
    software: [],
    containers,
    composeProjects: [],
    pm2: [],
    sites: [],
    services: [],
    ports: [],
  };
}

// Container names (Coolify style: <hash>-<digits>) — the shape of the imported fleet.
const cname = `('c' || lpad(s::text, 2, '0') || lpad(c::text, 2, '0') || 'x7kq9w3-' || (100000000000 + s * 1000 + c)::text)`;

async function main() {
  const prisma = new PrismaClient();
  if (process.argv.includes("--touch")) {
    // Fill [newest sample, now] at the real cadences so the hub's "live" windows (90 s container inventory, 30 min trend) have data.
    const cn = cname;
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Metric" ("id","serverId","ts","cpu","memUsed","memTotal","diskUsed","diskTotal","netRx","netTx","diskRead","diskWrite","load1","load5","load15","swapUsed","swapTotal","temp")
      SELECT 't' || s || '_' || extract(epoch from t)::bigint, 'perf-srv-' || s, t, 10 + 40 * random(), (3.0e9 + 1.0e9 * random())::bigint, 8589934592, 60000000000, 160000000000,
             (1e5 * random())::bigint, (1e5 * random())::bigint, (1e4 * random())::bigint, (1e4 * random())::bigint, random() * 2, random() * 2, random() * 2, 0, 0, 40 + 20 * random()
      FROM generate_series(1, ${SERVERS}) s,
           generate_series((SELECT max(ts) + interval '5 seconds' FROM "Metric"), ${NOW}, interval '5 seconds') t`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ContainerMetric" ("id","serverId","containerName","containerId","ts","cpu","memUsed","memTotal","memPct","netRx","netTx","blkRead","blkWrite")
      SELECT 'tc' || s || '_' || c || '_' || extract(epoch from t)::bigint, 'perf-srv-' || s, ${cn}, md5(${cn}), t, 100 * random() * random(), (50e6 + 400e6 * random())::bigint, 1073741824, 5 + 40 * random(),
             (1e4 * random())::bigint, (1e4 * random())::bigint, (1e3 * random())::bigint, (1e3 * random())::bigint
      FROM generate_series(1, ${SERVERS}) s, generate_series(1, ${PER}) c,
           generate_series((SELECT max(ts) + interval '15 seconds' FROM "ContainerMetric"), ${NOW}, interval '15 seconds') t`);
    await prisma.$executeRawUnsafe(`UPDATE "Server" SET "lastSeenAt" = now(), status = 'ONLINE'`);
    console.log("touched: live windows filled up to now");
    return prisma.$disconnect();
  }
  if (process.argv.includes("--scan-only")) {
    for (let i = 1; i <= SERVERS; i++) await prisma.server.update({ where: { id: `perf-srv-${i}` }, data: { scanReport: scanReport(i), scannedAt: new Date(Date.now() - 3600_000) } });
    console.log("scan reports seeded");
    return prisma.$disconnect();
  }
  const t0 = Date.now();
  const lap = (m) => console.log(`[seed ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Metric","ContainerMetric","MetricRollup","ContainerMetricRollup","ContainerLabel","ContainerState","Server","Membership","User","Team" CASCADE`,
  );
  const user = await prisma.user.create({
    data: { id: "perf-user", email: "perf@tugra.test", password: "x", isInstanceOwner: true, emailVerified: true },
  });
  const team = await prisma.team.create({ data: { id: "perf-team", name: "Perf fleet" } });
  await prisma.membership.create({ data: { userId: user.id, teamId: team.id, role: "OWNER" } });
  await prisma.instanceSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", initializedAt: new Date(), allowRegistration: false },
    update: {},
  });
  for (let i = 1; i <= SERVERS; i++) {
    await prisma.server.create({
      data: {
        id: `perf-srv-${i}`,
        name: `srv-${String(i).padStart(2, "0")}`,
        status: "ONLINE",
        enrollToken: `perf-enroll-${i}`,
        teamId: team.id,
        lastSeenAt: new Date(),
        agentVersion: "0.1.0-beta.27",
        hostname: `host-${i}`,
        cpuCores: 4,
        memTotalBytes: 8n * 1024n ** 3n,
      },
    });
  }
  for (let i = 1; i <= SERVERS; i++) await prisma.server.update({ where: { id: `perf-srv-${i}` }, data: { scanReport: scanReport(i), scannedAt: new Date(Date.now() - 3600_000) } });
  lap(`${SERVERS} servers (+ stored scan reports)`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "ContainerLabel" ("serverId","containerName","name","resource","project","environment","service","updatedAt")
    SELECT 'perf-srv-' || s, ${cname}, 'app ' || s || '-' || c, 'res-' || s || '-' || c, 'project ' || (s % 9), 'production', CASE WHEN c % 3 = 0 THEN 'db' ELSE 'web' END, ${NOW}
    FROM generate_series(1, ${SERVERS}) s, generate_series(1, ${PER}) c`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "ContainerState" ("serverId","containerName","containerId","status","updatedAt")
    SELECT 'perf-srv-' || s, ${cname}, md5(${cname}), 'running', ${NOW}
    FROM generate_series(1, ${SERVERS}) s, generate_series(1, ${PER}) c`);
  lap("labels + states");

  // Host raw: every 5 s for RAW_H hours.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Metric" ("id","serverId","ts","cpu","memUsed","memTotal","diskUsed","diskTotal","netRx","netTx","diskRead","diskWrite","load1","load5","load15","swapUsed","swapTotal","temp")
    SELECT 'm' || s || '_' || g, 'perf-srv-' || s, ${NOW} - (g * interval '5 seconds'),
           10 + 40 * random(), (3.0e9 + 1.0e9 * random())::bigint, 8589934592, (60.0e9 + g * 100)::bigint, 160000000000,
           (1e5 * random())::bigint, (1e5 * random())::bigint, (1e4 * random())::bigint, (1e4 * random())::bigint,
           random() * 2, random() * 2, random() * 2, 0, 0, 40 + 20 * random()
    FROM generate_series(1, ${SERVERS}) s, generate_series(0, ${RAW_H} * 720 - 1) g`);
  lap("Metric raw");

  // Container raw: every 15 s for RAW_H hours.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "ContainerMetric" ("id","serverId","containerName","containerId","ts","cpu","memUsed","memTotal","memPct","netRx","netTx","blkRead","blkWrite")
    SELECT 'cm' || s || '_' || c || '_' || g, 'perf-srv-' || s, ${cname}, md5(${cname}), ${NOW} - (g * interval '15 seconds'),
           100 * random() * random(), (50e6 + 400e6 * random())::bigint, 1073741824, 5 + 40 * random(),
           (1e4 * random())::bigint, (1e4 * random())::bigint, (1e3 * random())::bigint, (1e3 * random())::bigint
    FROM generate_series(1, ${SERVERS}) s, generate_series(1, ${PER}) c, generate_series(0, ${RAW_H} * 240 - 1) g`);
  lap("ContainerMetric raw");

  // Rollups: one row per minute for ROLLUP_D days.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "MetricRollup" ("id","serverId","bucket","avgCpu","maxCpu","avgMemUsed","avgMemTotal","avgDiskUsed","avgDiskTotal","avgNetRx","avgNetTx","avgDiskRead","avgDiskWrite","avgLoad1","avgLoad5","avgLoad15","avgSwapUsed","avgSwapTotal")
    SELECT 'mr' || s || '_' || g, 'perf-srv-' || s, date_trunc('minute', ${NOW}) - (g * interval '1 minute'),
           10 + 40 * random(), 60 + 40 * random(), (3.0e9 + 1.0e9 * random())::bigint, 8589934592, (60.0e9 + g * 100)::bigint, 160000000000,
           (1e5 * random())::bigint, (1e5 * random())::bigint, (1e4 * random())::bigint, (1e4 * random())::bigint, random() * 2, random() * 2, random() * 2, 0, 0
    FROM generate_series(1, ${SERVERS}) s, generate_series(1, ${ROLLUP_D} * 1440) g`);
  lap("MetricRollup");
  for (let s = 1; s <= SERVERS; s++) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ContainerMetricRollup" ("id","serverId","containerName","bucket","avgCpu","maxCpu","avgMemUsed","avgMemTotal","avgMemPct","avgNetRx","avgNetTx","avgBlkRead","avgBlkWrite")
      SELECT 'cr' || s || '_' || c || '_' || g, 'perf-srv-' || s, ${cname}, date_trunc('minute', ${NOW}) - (g * interval '1 minute'),
             100 * random() * random(), 100 * random(), (50e6 + 400e6 * random())::bigint, 1073741824, 5 + 40 * random(),
             (1e4 * random())::bigint, (1e4 * random())::bigint, (1e3 * random())::bigint, (1e3 * random())::bigint
      FROM (SELECT ${s}::int AS s) q, generate_series(1, ${PER}) c, generate_series(1, ${ROLLUP_D} * 1440) g`);
    if (s % 9 === 0) lap(`ContainerMetricRollup server ${s}/${SERVERS}`);
  }
  for (const t of ["Metric", "ContainerMetric", "MetricRollup", "ContainerMetricRollup"]) await prisma.$executeRawUnsafe(`ANALYZE "${t}"`);
  const [counts] = await prisma.$queryRawUnsafe(
    `SELECT (SELECT count(*) FROM "Metric")::int m, (SELECT count(*) FROM "ContainerMetric")::int cm, (SELECT count(*) FROM "MetricRollup")::int mr, (SELECT count(*) FROM "ContainerMetricRollup")::int cr`,
  );
  lap(`done ${JSON.stringify(counts)}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
