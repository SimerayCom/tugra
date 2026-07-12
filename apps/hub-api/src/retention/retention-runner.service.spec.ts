import { RetentionRunnerService } from "./retention-runner.service";

describe("RetentionRunnerService", () => {
  function make(cfg: Record<string, unknown> = {}) {
    // Each model: findMany returns queued pages (one array per call), then [] to end the loop.
    const pages: Record<string, { id: string }[][]> = {
      metric: [[]],
      containerMetric: [[]],
      heartbeat: [[]],
      metricRollup: [[]],
      containerMetricRollup: [[]],
    };
    const model = (name: string) => ({
      findMany: jest.fn().mockImplementation(() => Promise.resolve(pages[name].shift() ?? [])),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    const prisma = {
      metric: model("metric"),
      containerMetric: model("containerMetric"),
      heartbeat: model("heartbeat"),
      metricRollup: model("metricRollup"),
      containerMetricRollup: model("containerMetricRollup"),
    } as any;
    const config = { get: jest.fn((k: string) => cfg[k]) } as any;
    return { svc: new RetentionRunnerService(prisma, config), prisma, pages };
  }

  it("queries each table by ts < cutoff and only heartbeat filters important=false", async () => {
    const { svc, prisma } = make();
    await svc.prune();
    const metricWhere = prisma.metric.findMany.mock.calls[0][0].where;
    const hbWhere = prisma.heartbeat.findMany.mock.calls[0][0].where;
    expect(metricWhere.ts.lt).toBeInstanceOf(Date);
    expect(metricWhere.important).toBeUndefined(); // metrics have no important flag
    expect(prisma.containerMetric.findMany.mock.calls[0][0].where.important).toBeUndefined();
    expect(hbWhere.important).toBe(false); // status-change beats preserved
    expect(hbWhere.ts.lt).toBeInstanceOf(Date);
  });

  it("uses a longer cutoff (days) for heartbeats than for raw metrics (hours)", async () => {
    const { svc, prisma } = make({ METRICS_RAW_RETENTION_HOURS: 48, HEARTBEAT_RETENTION_DAYS: 30 });
    await svc.prune();
    const metricCut = prisma.metric.findMany.mock.calls[0][0].where.ts.lt as Date;
    const hbCut = prisma.heartbeat.findMany.mock.calls[0][0].where.ts.lt as Date;
    // 30 days ago is far older than 48h ago.
    expect(hbCut.getTime()).toBeLessThan(metricCut.getTime());
  });

  it("deletes in id-paged batches and terminates on a short/empty page", async () => {
    const { svc, prisma, pages } = make();
    const full = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` }));
    pages.metric = [full, [{ id: "last" }]]; // one full page (5000) → continue, then a short page → stop
    const res = await svc.prune();
    expect(prisma.metric.findMany).toHaveBeenCalledTimes(2); // stopped after the short page
    expect(prisma.metric.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.metric.deleteMany.mock.calls[1][0].where.id.in).toEqual(["last"]);
    expect(res.metric).toBe(5001);
  });

  it("does nothing (no deleteMany) when a table has no aged-out rows", async () => {
    const { svc, prisma } = make();
    const res = await svc.prune();
    expect(prisma.metric.deleteMany).not.toHaveBeenCalled();
    expect(res).toEqual({ metric: 0, containerMetric: 0, heartbeat: 0, metricRollup: 0, containerMetricRollup: 0 });
  });

  it("prunes rollups by bucket < cutoff (own retention window, not ts)", async () => {
    const { svc, prisma, pages } = make({ METRICS_ROLLUP_RETENTION_DAYS: 30 });
    pages.metricRollup = [[{ id: "r1" }, { id: "r2" }]]; // one short page → deleted then stop
    pages.containerMetricRollup = [[{ id: "cr1" }]];
    const res = await svc.prune();
    // rollups filter on `bucket`, never `ts`
    const mrWhere = prisma.metricRollup.findMany.mock.calls[0][0].where;
    expect(mrWhere.bucket.lt).toBeInstanceOf(Date);
    expect(mrWhere.ts).toBeUndefined();
    expect(prisma.containerMetricRollup.findMany.mock.calls[0][0].where.bucket.lt).toBeInstanceOf(Date);
    expect(prisma.metricRollup.deleteMany.mock.calls[0][0].where.id.in).toEqual(["r1", "r2"]);
    expect(res.metricRollup).toBe(2);
    expect(res.containerMetricRollup).toBe(1);
  });
});
