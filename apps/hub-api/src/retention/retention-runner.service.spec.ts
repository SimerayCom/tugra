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
      deployment: [[]],
      notificationDelivery: [[]],
      auditLog: [[]],
      containerEvent: [[]],
      trafficMetric: [[]],
      trafficPath: [[]],
      trafficCountry: [[]],
      trafficBreakdown: [[]],
      trafficLatency: [[]],
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
      deployment: model("deployment"),
      notificationDelivery: model("notificationDelivery"),
      auditLog: model("auditLog"),
      containerEvent: model("containerEvent"),
      trafficMetric: model("trafficMetric"),
      trafficPath: model("trafficPath"),
      trafficCountry: model("trafficCountry"),
      trafficBreakdown: model("trafficBreakdown"),
      trafficLatency: model("trafficLatency"),
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
    expect(res).toEqual({ metric: 0, containerMetric: 0, heartbeat: 0, metricRollup: 0, containerMetricRollup: 0, deployment: 0, notificationDelivery: 0, auditLog: 0, containerEvent: 0, trafficMetric: 0, trafficPath: 0, trafficCountry: 0, trafficBreakdown: 0, trafficLatency: 0 });
  });

  it("prunes only terminal, non-rollbackable deployments (QUEUED/RUNNING and rollbackable rows are kept)", async () => {
    const { svc, prisma, pages } = make({ DEPLOYMENT_RETENTION_DAYS: 90 });
    pages.deployment = [[{ id: "d-old" }]];
    await svc.prune();
    const where = prisma.deployment.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["SUCCESS", "FAILED", "CANCELLED"] }); // never QUEUED/RUNNING
    expect(where.imageTag).toBeNull(); // only rows that are no longer a rollback target
    expect(where.registryImage).toBeNull();
    expect(where.imageDigest).toBeNull();
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(prisma.deployment.deleteMany.mock.calls[0][0].where.id.in).toEqual(["d-old"]);
  });

  it("prunes delivered/failed notifications but never a PENDING one", async () => {
    const { svc, prisma } = make();
    await svc.prune();
    expect(prisma.notificationDelivery.findMany.mock.calls[0][0].where.status).toEqual({ not: "PENDING" });
  });

  it("leaves the audit log alone by default and prunes it only when AUDIT_RETENTION_DAYS is set", async () => {
    const off = make();
    await off.svc.prune();
    expect(off.prisma.auditLog.findMany).not.toHaveBeenCalled();

    const on = make({ AUDIT_RETENTION_DAYS: 365 });
    await on.svc.prune();
    expect(on.prisma.auditLog.findMany).toHaveBeenCalled();
    expect(on.prisma.auditLog.findMany.mock.calls[0][0].where.createdAt.lt).toBeInstanceOf(Date);
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

  it("prunes traffic metric/path/country/breakdown/latency rows by bucket < the traffic cutoff", async () => {
    const { svc, prisma, pages } = make({ TRAFFIC_RETENTION_DAYS: 30 });
    pages.trafficMetric = [[{ id: "tm1" }]];
    pages.trafficPath = [[{ id: "tp1" }, { id: "tp2" }]];
    pages.trafficCountry = [[{ id: "tc1" }, { id: "tc2" }, { id: "tc3" }]];
    pages.trafficBreakdown = [[{ id: "tb1" }, { id: "tb2" }, { id: "tb3" }, { id: "tb4" }]];
    pages.trafficLatency = [[{ id: "tl1" }, { id: "tl2" }, { id: "tl3" }, { id: "tl4" }, { id: "tl5" }]];
    const res = await svc.prune();
    for (const m of ["trafficMetric", "trafficPath", "trafficCountry", "trafficBreakdown", "trafficLatency"]) {
      const where = prisma[m].findMany.mock.calls[0][0].where;
      expect(where.bucket.lt).toBeInstanceOf(Date);
      expect(where.ts).toBeUndefined();
    }
    expect(prisma.trafficCountry.deleteMany.mock.calls[0][0].where.id.in).toEqual(["tc1", "tc2", "tc3"]);
    expect(res.trafficMetric).toBe(1);
    expect(res.trafficPath).toBe(2);
    expect(res.trafficCountry).toBe(3);
    expect(prisma.trafficBreakdown.deleteMany.mock.calls[0][0].where.id.in).toEqual(["tb1", "tb2", "tb3", "tb4"]);
    expect(prisma.trafficLatency.deleteMany.mock.calls[0][0].where.id.in).toEqual(["tl1", "tl2", "tl3", "tl4", "tl5"]);
    expect(res.trafficBreakdown).toBe(4);
    expect(res.trafficLatency).toBe(5);
  });
});
