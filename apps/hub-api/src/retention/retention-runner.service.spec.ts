import { RetentionRunnerService } from "./retention-runner.service";

describe("RetentionRunnerService", () => {
  function make(cfg: Record<string, unknown> = {}, opts: { newest5m?: { bucket: Date } | null; oldest5m?: { bucket: Date } | null } = {}) {
    const statements: Array<{ table: string; sql: string; values: unknown[] }> = [];
    const deleted: Record<string, number[]> = {};
    // Each model: findMany returns queued pages (one array per call), then [] to end the loop.
    const pages: Record<string, { id: string }[][]> = {
      heartbeat: [[]],
      deployment: [[]],
      notificationDelivery: [[]],
      auditLog: [[]],
      containerEvent: [[]],
      trafficMetric: [[]],
      trafficPath: [[]],
      trafficCountry: [[]],
      trafficBreakdown: [[]],
      trafficLatency: [[]],
      trafficUnique: [[]],
      trafficUniqueHour: [[]],
    };
    const model = (name: string) => ({
      findMany: jest.fn().mockImplementation(() => Promise.resolve(pages[name].shift() ?? [])),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    const newest5m = opts.newest5m === undefined ? { bucket: new Date(0) } : opts.newest5m;
    const oldest5m = opts.oldest5m === undefined ? (newest5m ? { bucket: new Date(0) } : null) : opts.oldest5m;
    const edge = async (a: { orderBy: { bucket: "asc" | "desc" } }) => (a.orderBy.bucket === "desc" ? newest5m : oldest5m);
    const prisma = {
      heartbeat: model("heartbeat"),
      deployment: model("deployment"),
      notificationDelivery: model("notificationDelivery"),
      auditLog: model("auditLog"),
      containerEvent: model("containerEvent"),
      trafficMetric: model("trafficMetric"),
      trafficPath: model("trafficPath"),
      trafficCountry: model("trafficCountry"),
      trafficBreakdown: model("trafficBreakdown"),
      trafficLatency: model("trafficLatency"),
      trafficUnique: model("trafficUnique"),
      trafficUniqueHour: model("trafficUniqueHour"),
      // The metric tables are pruned with ctid-batched raw DELETEs: `deleted[table]` queues how many rows each statement reports.
      // findFirst answers by sort direction: newest (desc) / oldest (asc). Default tier: from the epoch up to opts.newest5m.
      metricRollup5m: { findFirst: jest.fn(edge) },
      containerMetricRollup5m: { findFirst: jest.fn(edge) },
      $executeRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => {
        const table = /DELETE FROM "(\w+)"/.exec(q.sql)![1];
        statements.push({ table, sql: q.sql, values: q.values });
        return deleted[table]?.shift() ?? 0;
      }),
    } as any;
    const config = { get: jest.fn((k: string) => cfg[k]) } as any;
    return { svc: new RetentionRunnerService(prisma, config), prisma, pages, statements, deleted };
  }

  const cutoffOf = (st: { values: unknown[] }) => st.values[0] as Date;
  const forTable = (statements: Array<{ table: string; sql: string; values: unknown[] }>, t: string) => statements.filter((x) => x.table === t);

  it("prunes every metric tier with a ctid-batched DELETE keyed on its own column; only heartbeat filters important=false", async () => {
    const { svc, prisma, statements } = make();
    await svc.prune();
    expect(statements.map((x) => x.table)).toEqual(["Metric", "ContainerMetric", "MetricRollup", "ContainerMetricRollup", "MetricRollup5m", "ContainerMetricRollup5m"]);
    for (const st of statements) expect(st.sql).toMatch(/DELETE FROM "\w+" WHERE ctid IN \(SELECT ctid FROM "\w+" WHERE "(ts|bucket)" < \? LIMIT \?\)/);
    expect(forTable(statements, "Metric")[0].sql).toContain('"ts" <');
    expect(forTable(statements, "MetricRollup5m")[0].sql).toContain('"bucket" <');
    expect(prisma.heartbeat.findMany.mock.calls[0][0].where.important).toBe(false); // status-change beats preserved
  });

  it("cutoffs follow the tiers: host raw 26 h, container raw 6 h, 1-minute 48 h, 5-minute 28 d, heartbeats 30 d", async () => {
    const { svc, prisma, statements } = make({}, { newest5m: { bucket: new Date(Date.now() + 86_400_000) } });
    const t0 = Date.now();
    await svc.prune();
    const age = (table: string) => (t0 - cutoffOf(forTable(statements, table)[0]).getTime()) / 3600_000;
    expect(age("Metric")).toBeCloseTo(26, 1);
    expect(age("ContainerMetric")).toBeCloseTo(6, 1);
    expect(age("MetricRollup")).toBeCloseTo(48, 1);
    expect(age("ContainerMetricRollup")).toBeCloseTo(48, 1);
    expect(age("MetricRollup5m")).toBeCloseTo(28 * 24, 1);
    expect(age("ContainerMetricRollup5m")).toBeCloseTo(28 * 24, 1);
    const hbCut = prisma.heartbeat.findMany.mock.calls[0][0].where.ts.lt as Date;
    expect(hbCut.getTime()).toBeLessThan(cutoffOf(forTable(statements, "MetricRollup5m")[0]).getTime() + 3 * 86_400_000);
  });

  it("honours the configured retention overrides", async () => {
    const { svc, statements } = make({ METRICS_RAW_RETENTION_HOURS: 48, METRICS_CONTAINER_RAW_RETENTION_HOURS: 12, METRICS_ROLLUP_1M_RETENTION_HOURS: 72, METRICS_ROLLUP_RETENTION_DAYS: 14 }, { newest5m: { bucket: new Date(Date.now() + 86_400_000) } });
    const t0 = Date.now();
    await svc.prune();
    const age = (table: string) => (t0 - cutoffOf(forTable(statements, table)[0]).getTime()) / 3600_000;
    expect(age("Metric")).toBeCloseTo(48, 1);
    expect(age("ContainerMetric")).toBeCloseTo(12, 1);
    expect(age("MetricRollup")).toBeCloseTo(72, 1);
    expect(age("ContainerMetricRollup5m")).toBeCloseTo(14 * 24, 1);
  });

  it("deletes in 20 000-row batches and stops on the first short batch", async () => {
    const { svc, statements, deleted } = make();
    deleted.ContainerMetric = [20_000, 20_000, 123]; // two full batches → continue, a short one → stop
    const res = await svc.prune();
    expect(forTable(statements, "ContainerMetric")).toHaveLength(3);
    expect(forTable(statements, "ContainerMetric")[0].values[1]).toBe(20_000); // LIMIT
    expect(res.containerMetric).toBe(40_123);
  });

  it("never prunes a 1-minute rollup the forward roll has not folded: cutoff = min(48 h ago, newest 5-minute bucket)", async () => {
    const newest5m = new Date(Date.now() - 60 * 3600_000); // the forward roll is 60 h behind (hub was down)
    const { svc, statements } = make({}, { newest5m: { bucket: newest5m } });
    await svc.prune();
    expect(cutoffOf(forTable(statements, "MetricRollup")[0]).getTime()).toBe(newest5m.getTime());
    expect(cutoffOf(forTable(statements, "ContainerMetricRollup")[0]).getTime()).toBe(newest5m.getTime());
  });

  it("steady state (5-minute tier reaches its floor): the 1-minute prune is the plain indexed `bucket < cutoff`", async () => {
    const { svc, statements } = make({}, { newest5m: { bucket: new Date() }, oldest5m: { bucket: new Date(Date.now() - 28 * 86_400_000 - 3600_000) } });
    await svc.prune();
    for (const t of ["MetricRollup", "ContainerMetricRollup"]) {
      expect(forTable(statements, t)[0].sql).not.toContain("NOT (");
      expect(forTable(statements, t)[0].values).toHaveLength(2); // cutoff, LIMIT
    }
  });

  it("protects the not-yet-back-filled history: minutes older than the oldest 5-minute bucket (inside the tier window) are kept", async () => {
    const oldest5m = new Date(Date.now() - 3 * 86_400_000); // newest-first back-fill has reached 3 days so far
    const { svc, statements } = make({}, { newest5m: { bucket: new Date() }, oldest5m: { bucket: oldest5m } });
    const t0 = Date.now();
    await svc.prune();
    for (const t of ["MetricRollup", "ContainerMetricRollup"]) {
      const st = forTable(statements, t)[0];
      expect(st.sql).toMatch(/"bucket" < \? AND NOT \("bucket" >= \? AND "bucket" < \?\)/);
      const [cutoff, from, to] = st.values as Date[];
      expect((t0 - cutoff.getTime()) / 3600_000).toBeCloseTo(48, 1); // folded span reaches "now": the 48 h cutoff applies
      expect((t0 - from.getTime()) / 86_400_000).toBeCloseTo(28, 1); // protected from the 5-minute window floor ...
      expect(to.getTime()).toBe(oldest5m.getTime()); // ... up to the oldest folded bucket
    }
  });

  it("while the 5-minute tier is still empty (upgrade, first run) the whole tier window of the 1-minute rollups is protected; raw is still pruned", async () => {
    const { svc, statements } = make({}, { newest5m: null });
    await svc.prune();
    for (const t of ["MetricRollup", "ContainerMetricRollup"]) {
      const [cutoff, from, to] = forTable(statements, t)[0].values as Date[];
      expect(to.getTime()).toBe(cutoff.getTime()); // [28 d floor, 48 h cutoff) kept: only rows older than the tier window go
      expect(from.getTime()).toBeLessThan(cutoff.getTime());
    }
    expect(forTable(statements, "Metric")).toHaveLength(1);
  });

  it("does nothing when no table has aged-out rows", async () => {
    const { svc } = make();
    const res = await svc.prune();
    expect(res).toEqual({ metric: 0, containerMetric: 0, heartbeat: 0, metricRollup: 0, containerMetricRollup: 0, metricRollup5m: 0, containerMetricRollup5m: 0, deployment: 0, notificationDelivery: 0, auditLog: 0, containerEvent: 0, trafficMetric: 0, trafficPath: 0, trafficCountry: 0, trafficBreakdown: 0, trafficLatency: 0, trafficUnique: 0, trafficUniqueHour: 0 });
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

  it("reports the rollup rows pruned per tier", async () => {
    const { svc, deleted } = make({}, { newest5m: { bucket: new Date(Date.now() + 86_400_000) } });
    deleted.MetricRollup = [2];
    deleted.ContainerMetricRollup = [1];
    deleted.MetricRollup5m = [7];
    const res = await svc.prune();
    expect(res).toMatchObject({ metricRollup: 2, containerMetricRollup: 1, metricRollup5m: 7, containerMetricRollup5m: 0 });
  });

  it("prunes traffic metric/path/country/breakdown/latency rows by bucket < the traffic cutoff", async () => {
    const { svc, prisma, pages } = make({ TRAFFIC_RETENTION_DAYS: 30 });
    pages.trafficMetric = [[{ id: "tm1" }]];
    pages.trafficPath = [[{ id: "tp1" }, { id: "tp2" }]];
    pages.trafficCountry = [[{ id: "tc1" }, { id: "tc2" }, { id: "tc3" }]];
    pages.trafficBreakdown = [[{ id: "tb1" }, { id: "tb2" }, { id: "tb3" }, { id: "tb4" }]];
    pages.trafficLatency = [[{ id: "tl1" }, { id: "tl2" }, { id: "tl3" }, { id: "tl4" }, { id: "tl5" }]];
    pages.trafficUnique = [[{ id: "tu1" }, { id: "tu2" }]];
    pages.trafficUniqueHour = [[{ id: "th1" }, { id: "th2" }, { id: "th3" }]];
    const res = await svc.prune();
    for (const m of ["trafficMetric", "trafficPath", "trafficCountry", "trafficBreakdown", "trafficLatency", "trafficUnique", "trafficUniqueHour"]) {
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
    expect(prisma.trafficUnique.deleteMany.mock.calls[0][0].where.id.in).toEqual(["tu1", "tu2"]);
    expect(res.trafficUnique).toBe(2);
    expect(prisma.trafficUniqueHour.deleteMany.mock.calls[0][0].where.id.in).toEqual(["th1", "th2", "th3"]);
    expect(res.trafficUniqueHour).toBe(3);
    // minute sketches are kept ~48h (only <= 24h ranges read them); the hourly rollup keeps the full traffic retention
    const day = 86_400_000;
    const minuteCut = prisma.trafficUnique.findMany.mock.calls[0][0].where.bucket.lt.getTime();
    const hourCut = prisma.trafficUniqueHour.findMany.mock.calls[0][0].where.bucket.lt.getTime();
    expect(Date.now() - minuteCut).toBeGreaterThan(1.9 * day);
    expect(Date.now() - minuteCut).toBeLessThan(2.1 * day);
    expect(hourCut).toBeLessThan(minuteCut);
  });
});
