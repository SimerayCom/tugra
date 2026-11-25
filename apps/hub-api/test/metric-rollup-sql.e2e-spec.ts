import { PrismaService } from "../src/prisma/prisma.service";
import { MetricsRollupRunnerService } from "../src/retention/metrics-rollup-runner.service";
import { RetentionRunnerService } from "../src/retention/retention-runner.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { ContainerMetricsService } from "../src/metrics/container-metrics.service";

/**
 * The metric rollups aggregate inside Postgres (INSERT ... SELECT ... GROUP BY ... ON CONFLICT DO NOTHING), the
 * 5-minute tier folds the 1-minute tier, and the retention prune is a ctid-batched DELETE. This pins the SQL against a
 * real database: averages / peaks / rounding / the optional-column rules, idempotence, watermarks, 5-minute folding
 * across a tier boundary, the prune guard, and the chart readers picking the right table.
 */
describe("metric rollup tiers (real database)", () => {
  const prisma = new PrismaService();
  const tag = `mr${Date.now().toString(36)}`;
  const teamId = `${tag}-team`;
  const [sA, sB] = [`${tag}-a`, `${tag}-b`];
  const runner = new MetricsRollupRunnerService(prisma);
  const retention = new RetentionRunnerService(prisma, { get: () => undefined } as never);
  const metrics = new MetricsService(prisma, { client: { publish: async () => 0 } } as never);
  const containers = new ContainerMetricsService(prisma);

  const MIN = 60_000;
  const FIVE = 5 * MIN;
  // A 5-minute-aligned anchor ~3 h ago; every fixture lives relative to it (inside the 6 h first-run backfill).
  const anchor = Math.floor((Date.now() - 3 * 3600_000) / FIVE) * FIVE;
  const at = (ms: number) => new Date(anchor + ms);

  const metric = (serverId: string, ms: number, over: Record<string, unknown> = {}) => ({
    id: `${serverId}-m${ms}`, serverId, ts: at(ms), cpu: 10,
    memUsed: 100n, memTotal: 1000n, diskUsed: 10n, diskTotal: 100n, netRx: 0n, netTx: 0n, ...over,
  });
  const cm = (serverId: string, containerName: string, ms: number, over: Record<string, unknown> = {}) => ({
    id: `${serverId}-${containerName}-${ms}`, serverId, containerName, containerId: `${containerName}-id`, ts: at(ms), cpu: 5,
    memUsed: 10n, memTotal: 100n, memPct: 20, netRx: 0n, netTx: 0n, blkRead: 0n, blkWrite: 0n, ...over,
  });

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.team.create({ data: { id: teamId, name: tag } });
    for (const id of [sA, sB]) await prisma.server.create({ data: { id, name: id, teamId, enrollToken: `${id}-tok`, status: "ONLINE" } });
    await prisma.metric.createMany({
      data: [
        // minute 0 of server A: avg cpu 20 / peak 30, mem round((100+201)/2)=151 (150.5 rounds up), load reported by 2 of 3 samples
        metric(sA, 0, { cpu: 10, memUsed: 100n, load1: 1, swapUsed: 100n, swapTotal: 1000n }),
        metric(sA, 15_000, { cpu: 30, memUsed: 201n, load1: 3, swapUsed: 300n, swapTotal: 1000n }),
        metric(sA, 30_000, { cpu: 20 }), // old-agent sample: no load/swap -> must not drag the averages down
        metric(sA, MIN, { cpu: 2 }), // minute 1: nothing optional reported -> NULL
        metric(sB, 0, { cpu: 50 }), // other server, same minute stays separate
        // minutes 2..4 of server A (so the 5-minute bucket [0,5) has 5 minutes of data)
        metric(sA, 2 * MIN, { cpu: 4 }),
        metric(sA, 3 * MIN, { cpu: 6 }),
        metric(sA, 4 * MIN + 59_000, { cpu: 8 }),
        metric(sA, 10 * MIN, { cpu: 99 }), // a later bucket [10,15)
      ],
    });
    await prisma.containerMetric.createMany({
      data: [
        cm(sA, "web", 0, { cpu: 5, memPct: 20, memUsed: 10n }),
        cm(sA, "web", 20_000, { cpu: 15, memPct: 40, memUsed: 21n }), // same minute: avg cpu 10, peak 15, memPct 30, mem round(15.5)=16
        cm(sA, "db", 0, { cpu: 9, memPct: 60 }),
        cm(sA, "web", MIN, { cpu: 1 }),
        cm(sA, "web", 6 * MIN, { cpu: 3 }), // settles the container bucket [0,5)
      ],
    });
  });
  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }); // cascades servers + every tier
    await prisma.$disconnect();
  });

  const hostRollup = (serverId: string, ms: number) => prisma.metricRollup.findFirst({ where: { serverId, bucket: at(ms) } });

  it("rolls the 1-minute tier in SQL: avg, peak, BigInt rounding, optional columns averaged over the reporters only", async () => {
    const res = await runner.roll();
    expect(res.metric).toBeGreaterThanOrEqual(2);
    const a0 = (await hostRollup(sA, 0))!;
    expect(a0.avgCpu).toBe(20); // (10+30+20)/3
    expect(a0.maxCpu).toBe(30);
    expect(a0.avgMemUsed).toBe(BigInt(Math.round((100 + 201 + 100) / 3))); // 134
    expect(a0.avgLoad1).toBe(2); // (1+3)/2, the third sample did not report it
    expect(a0.avgLoad5).toBeNull();
    expect(a0.avgSwapUsed).toBe(200n);
    expect(a0.avgSwapTotal).toBe(1000n);
    const a1 = (await hostRollup(sA, MIN))!;
    expect(a1.avgCpu).toBe(2);
    expect(a1.avgLoad1).toBeNull();
    expect(a1.avgSwapUsed).toBeNull();
    expect((await hostRollup(sB, 0))!.avgCpu).toBe(50);
  });

  it("rolls containers per (server, container, minute): avg, peak, memPct mean, rounded memory", async () => {
    const web = (await prisma.containerMetricRollup.findFirst({ where: { serverId: sA, containerName: "web", bucket: at(0) } }))!;
    expect(web.avgCpu).toBe(10);
    expect(web.maxCpu).toBe(15);
    expect(web.avgMemPct).toBe(30);
    expect(web.avgMemUsed).toBe(16n); // round((10+21)/2) = round(15.5)
    expect((await prisma.containerMetricRollup.findFirst({ where: { serverId: sA, containerName: "db", bucket: at(0) } }))!.avgCpu).toBe(9);
    expect(await prisma.containerMetricRollup.count({ where: { serverId: sA, containerName: "web" } })).toBe(3); // minutes 0, 1 and 6
  });

  it("is idempotent: a second run writes nothing new and changes no value", async () => {
    const before = await prisma.metricRollup.count({ where: { serverId: { in: [sA, sB] } } });
    const again = await runner.roll();
    expect(again.metric).toBe(0);
    expect(again.containerMetric).toBe(0);
    expect(await prisma.metricRollup.count({ where: { serverId: { in: [sA, sB] } } })).toBe(before);
    expect((await hostRollup(sA, 0))!.avgCpu).toBe(20);
  });

  it("folds complete 5-minute buckets from the 1-minute tier: mean of the minute means, max of the maxes, optional columns skip NULL", async () => {
    const five = (await prisma.metricRollup5m.findFirst({ where: { serverId: sA, bucket: at(0) } }))!;
    expect(five).toBeTruthy();
    // minute means: m0 = 20, m1 = 2, m2 = 4, m3 = 6, m4 = 8 -> mean 8
    expect(five.avgCpu).toBe(8);
    expect(five.maxCpu).toBe(30);
    expect(five.avgLoad1).toBe(2); // only minute 0 reported it
    expect(five.avgLoad5).toBeNull();
    expect(five.avgSwapUsed).toBe(200n);
    const c5 = (await prisma.containerMetricRollup5m.findFirst({ where: { serverId: sA, containerName: "web", bucket: at(0) } }))!;
    expect(c5.avgCpu).toBe(5.5); // (10 + 1) / 2
    expect(c5.maxCpu).toBe(15);
  });

  it("writes only 5-minute buckets the 1-minute watermark has fully passed (the bucket holding the newest minute stays open)", async () => {
    // the newest 1-minute row is minute 10 of server A -> [10,15) is still filling and must not exist yet
    expect(await prisma.metricRollup5m.findFirst({ where: { serverId: sA, bucket: at(10 * MIN) } })).toBeNull();
    // ... but once later minutes are settled, it is written (and the earlier bucket is untouched)
    await prisma.metric.createMany({ data: [metric(sA, 11 * MIN, { cpu: 1 }), metric(sA, 16 * MIN, { cpu: 1 })] });
    await runner.roll();
    const b = await prisma.metricRollup5m.findFirst({ where: { serverId: sA, bucket: at(10 * MIN) } });
    expect(b).toBeTruthy();
    expect(b!.avgCpu).toBe(50); // minute 10 = 99, minute 11 = 1
    expect((await prisma.metricRollup5m.findFirst({ where: { serverId: sA, bucket: at(0) } }))!.avgCpu).toBe(8);
  });

  it("never prunes a 1-minute rollup the 5-minute tier has not consumed, and prunes consumed ones past 48 h", async () => {
    const old = new Date(Date.now() - 50 * 3600_000);
    const older = new Date(old.getTime() - 3600_000);
    const row = (bucket: Date) => ({ id: `${tag}-old-${bucket.getTime()}`, serverId: sB, bucket, avgCpu: 1, maxCpu: 1, avgMemUsed: 1n, avgMemTotal: 1n, avgDiskUsed: 1n, avgDiskTotal: 1n, avgNetRx: 0n, avgNetTx: 0n, avgDiskRead: 0n, avgDiskWrite: 0n });
    await prisma.metricRollup.createMany({ data: [row(old), row(older)] });
    // 5-minute watermark of server B's tier (global newest) is recent -> both are consumed -> pruned
    await retention.prune();
    expect(await prisma.metricRollup.count({ where: { serverId: sB, bucket: { in: [old, older] } } })).toBe(0);
    // recent 1-minute rows (within 48 h) survive
    expect(await hostRollup(sA, 0)).toBeTruthy();
  });

  it("prunes raw samples by their own retention: container raw 6 h, host raw 26 h", async () => {
    const mk = (h: number) => new Date(Date.now() - h * 3600_000);
    await prisma.metric.createMany({ data: [{ ...metric(sB, 0), id: `${tag}-hm-old`, ts: mk(30) }, { ...metric(sB, 0), id: `${tag}-hm-new`, ts: mk(20) }] });
    await prisma.containerMetric.createMany({ data: [{ ...cm(sB, "x", 0), id: `${tag}-cm-old`, ts: mk(7) }, { ...cm(sB, "x", 0), id: `${tag}-cm-new`, ts: mk(5) }] });
    await retention.prune();
    expect((await prisma.metric.findMany({ where: { id: { startsWith: `${tag}-hm-` } } })).map((r) => r.id)).toEqual([`${tag}-hm-new`]);
    expect((await prisma.containerMetric.findMany({ where: { id: { startsWith: `${tag}-cm-` } } })).map((r) => r.id)).toEqual([`${tag}-cm-new`]);
  });

  it("chart readers: host 7d reads the 5-minute tier, container 24h the 1-minute tier, container 1h the raw table", async () => {
    // a 5-minute row 2 days back that exists ONLY in the 5-minute tier proves which table answers
    await prisma.metricRollup5m.create({ data: { serverId: sA, bucket: new Date(Math.floor((Date.now() - 2 * 86_400_000) / FIVE) * FIVE), avgCpu: 77, maxCpu: 88, avgMemUsed: 1n, avgMemTotal: 2n, avgDiskUsed: 1n, avgDiskTotal: 2n, avgNetRx: 0n, avgNetTx: 0n, avgDiskRead: 0n, avgDiskWrite: 0n } });
    const week = await metrics.history(sA, "7d");
    expect(week.some((p) => p.cpu === 77 && p.cpuMax === 88)).toBe(true);
    expect(week.some((p) => p.cpu === 8)).toBe(true); // the folded bucket from this run is in the same tier
    const day = await containers.forApp(sA, "web", "24h"); // 1-minute rollup of the container (anchored 3 h ago)
    expect(day.containers[0].samples.some((s) => s.cpu === 10 && s.cpuMax === 15)).toBe(true);
    const hour = await containers.forApp(sA, "web", "1h"); // raw: the fixture rows are 3 h old -> not in the last hour
    expect(hour.containers).toEqual([]);
    const six = await containers.forApp(sA, "web", "6h"); // raw within the 6 h container retention
    expect(six.containers[0].samples.some((s) => s.cpu === 5 && !("cpuMax" in s))).toBe(true);
  });
});
