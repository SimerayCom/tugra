import { MetricsRollupRunnerService } from "./metrics-rollup-runner.service";

// A minute-aligned timestamp to build in-bucket rows around.
const BUCKET_MS = 1_700_000_040_000; // divisible by 60_000

function make(opts: {
  metricRows?: unknown[];
  containerRows?: unknown[];
  maxHostBucket?: Date;
  maxContainerBucket?: Date;
} = {}) {
  const metricCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const containerCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    metric: { findMany: jest.fn().mockResolvedValue(opts.metricRows ?? []) },
    containerMetric: { findMany: jest.fn().mockResolvedValue(opts.containerRows ?? []) },
    metricRollup: {
      findFirst: jest.fn().mockResolvedValue(opts.maxHostBucket ? { bucket: opts.maxHostBucket } : null),
      createMany: metricCreateMany,
    },
    containerMetricRollup: {
      findFirst: jest.fn().mockResolvedValue(opts.maxContainerBucket ? { bucket: opts.maxContainerBucket } : null),
      createMany: containerCreateMany,
    },
  } as any;
  return { svc: new MetricsRollupRunnerService(prisma), prisma, metricCreateMany, containerCreateMany };
}

function hostRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    serverId: "s1",
    ts: new Date(BUCKET_MS),
    cpu: 10,
    memUsed: 100n,
    memTotal: 1000n,
    diskUsed: 0n,
    diskTotal: 0n,
    netRx: 0n,
    netTx: 0n,
    diskRead: 0n,
    diskWrite: 0n,
    ...over,
  };
}

describe("MetricsRollupRunnerService", () => {
  it("aggregates same-minute rows into one bucket: avg for values, MAX for cpu, BigInt-rounded means", async () => {
    const { svc, metricCreateMany } = make({
      metricRows: [
        hostRow({ ts: new Date(BUCKET_MS), cpu: 10, memUsed: 100n }),
        hostRow({ ts: new Date(BUCKET_MS + 15_000), cpu: 30, memUsed: 201n }), // same minute
      ],
    });
    const res = await svc.roll();
    expect(res.metric).toBe(1);
    const data = metricCreateMany.mock.calls[0][0].data;
    expect(data).toHaveLength(1);
    expect(data[0].serverId).toBe("s1");
    expect(data[0].bucket).toEqual(new Date(BUCKET_MS)); // floored to the minute
    expect(data[0].avgCpu).toBe(20); // (10+30)/2
    expect(data[0].maxCpu).toBe(30); // spike preserved
    expect(data[0].avgMemUsed).toBe(151n); // round((100+201)/2)=150.5→151
    expect(metricCreateMany.mock.calls[0][0].skipDuplicates).toBe(true); // idempotent re-run
  });

  it("splits rows in different minutes into separate buckets, and different servers", async () => {
    const { svc, metricCreateMany } = make({
      metricRows: [
        hostRow({ serverId: "s1", ts: new Date(BUCKET_MS), cpu: 1 }),
        hostRow({ serverId: "s1", ts: new Date(BUCKET_MS + 60_000), cpu: 2 }), // next minute
        hostRow({ serverId: "s2", ts: new Date(BUCKET_MS), cpu: 3 }), // other server
      ],
    });
    const res = await svc.roll();
    expect(res.metric).toBe(3);
    expect(metricCreateMany.mock.calls[0][0].data).toHaveLength(3);
  });

  it("watermark: with existing rollups, the window starts at maxBucket + 1 minute", async () => {
    const maxBucket = new Date(Date.now() - 5 * 60_000); // 5 min ago (well within raw retention)
    const { svc, prisma } = make({ maxHostBucket: maxBucket, metricRows: [hostRow()] });
    await svc.roll();
    const where = prisma.metric.findMany.mock.calls[0][0].where;
    expect(where.ts.gte.getTime()).toBe(maxBucket.getTime() + 60_000); // next bucket after the newest
  });

  it("first run (no rollups) backfills the last 6h; window end is the CURRENT minute floor (partial minute excluded)", async () => {
    const { svc, prisma } = make({ metricRows: [hostRow()] });
    await svc.roll();
    const where = prisma.metric.findMany.mock.calls[0][0].where;
    const backfill = Date.now() - 6 * 3600_000;
    expect(Math.abs(where.ts.gte.getTime() - backfill)).toBeLessThan(2000); // ≈ now-6h
    // end (upper bound) is minute-aligned and not in the future → the still-filling minute is excluded
    expect(where.ts.lt.getTime() % 60_000).toBe(0);
    expect(where.ts.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("no rows → no createMany, returns zero counts", async () => {
    const { svc, metricCreateMany, containerCreateMany } = make();
    const res = await svc.roll();
    expect(metricCreateMany).not.toHaveBeenCalled();
    expect(containerCreateMany).not.toHaveBeenCalled();
    expect(res).toEqual({ metric: 0, containerMetric: 0 });
  });

  it("clamps a non-finite mean to 0 instead of throwing (BigInt(NaN) guard)", async () => {
    const { svc, metricCreateMany } = make({
      // memTotal huge + a poisoned value can't reach here (rows are DB-clean), but guard the mean anyway.
      metricRows: [hostRow({ memUsed: 100n }), hostRow({ ts: new Date(BUCKET_MS + 1000), memUsed: 100n })],
    });
    await expect(svc.roll()).resolves.toBeDefined();
    expect(metricCreateMany.mock.calls[0][0].data[0].avgMemUsed).toBe(100n);
  });

  it("container rollups: key by server|name|minute; averages memPct; separate containers stay separate", async () => {
    const cRow = (over: Partial<Record<string, unknown>> = {}) => ({
      serverId: "s1",
      containerName: "web",
      ts: new Date(BUCKET_MS),
      cpu: 5,
      memUsed: 10n,
      memTotal: 100n,
      memPct: 20,
      netRx: 0n,
      netTx: 0n,
      blkRead: 0n,
      blkWrite: 0n,
      ...over,
    });
    const { svc, containerCreateMany } = make({
      containerRows: [
        cRow({ containerName: "web", cpu: 5, memPct: 20 }),
        cRow({ containerName: "web", ts: new Date(BUCKET_MS + 20_000), cpu: 15, memPct: 40 }), // same bucket
        cRow({ containerName: "db", cpu: 9, memPct: 60 }), // different container
      ],
    });
    const res = await svc.roll();
    expect(res.containerMetric).toBe(2); // web (merged) + db
    const data = containerCreateMany.mock.calls[0][0].data;
    const web = data.find((d: any) => d.containerName === "web");
    expect(web.avgCpu).toBe(10); // (5+15)/2
    expect(web.maxCpu).toBe(15);
    expect(web.avgMemPct).toBe(30); // (20+40)/2
    expect(containerCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });
});
