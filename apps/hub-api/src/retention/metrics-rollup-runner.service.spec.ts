import {
  FIVE_MIN_MS,
  MAX_FILLED_SLICES,
  MAX_FILLED_SLICES_5M,
  MetricsRollupRunnerService,
  SEED_5M_MS,
  SEED_FILLED_SLICES_5M,
  SLICE_5M_MS,
  SLICE_MS,
  slices,
  slicesNewestFirst,
} from "./metrics-rollup-runner.service";

// The aggregation maths (avg / max / rounding / optional columns / 5-minute folding) runs in Postgres and is pinned
// against a real database in test/metric-rollup-sql.e2e-spec.ts. This spec covers what the service itself decides:
// which window each statement covers (slicing + watermarks), which tables it writes, and that no sample row is read.

type Stmt = { sql: string; values: unknown[] };
const MIN = 60_000;

function make(opts: {
  newestHost?: Date; newestContainer?: Date;
  oldestHost?: Date; oldestContainer?: Date;
  newest5mHost?: Date; newest5mContainer?: Date;
  /** oldest 5-minute bucket; defaults to the newest (a one-bucket tier) */
  oldest5mHost?: Date; oldest5mContainer?: Date;
  /** rows each statement "inserts", by table; default 0 */
  inserted?: (table: string, s: Stmt, call: number) => number;
} = {}) {
  const stmts: Stmt[] = [];
  // findFirst answers by sort direction: newest (desc) / oldest (asc)
  const rollupModel = (newest?: Date, oldest?: Date) => ({
    findFirst: jest.fn(async (args: { orderBy: { bucket: "asc" | "desc" } }) => {
      const d = args.orderBy.bucket === "desc" ? newest : oldest;
      return d ? { bucket: d } : null;
    }),
  });
  let call = 0;
  const prisma = {
    metricRollup: rollupModel(opts.newestHost, opts.oldestHost ?? opts.newestHost),
    containerMetricRollup: rollupModel(opts.newestContainer, opts.oldestContainer ?? opts.newestContainer),
    metricRollup5m: rollupModel(opts.newest5mHost, opts.oldest5mHost ?? opts.newest5mHost),
    containerMetricRollup5m: rollupModel(opts.newest5mContainer, opts.oldest5mContainer ?? opts.newest5mContainer),
    // No findMany on the sample tables: the runner must never pull rows into the hub.
    metric: {},
    containerMetric: {},
    $executeRaw: jest.fn(async (q: Stmt) => {
      stmts.push(q);
      const table = /INSERT INTO "(\w+)"/.exec(q.sql)![1];
      return opts.inserted ? opts.inserted(table, q, call++) : 0;
    }),
  } as any;
  const into = (table: string) => stmts.filter((s) => new RegExp(`INSERT INTO "${table}" `).test(s.sql));
  return { svc: new MetricsRollupRunnerService(prisma), prisma, stmts, into };
}

const window = (s: Stmt) => ({ start: (s.values[0] as Date).getTime(), end: (s.values[1] as Date).getTime() });

describe("MetricsRollupRunnerService", () => {
  describe("1-minute tier (SQL, no rows in Node)", () => {
    it("rolls raw rows with one INSERT ... SELECT ... GROUP BY per slice and ON CONFLICT DO NOTHING (idempotent)", async () => {
      const { svc, into } = make();
      await svc.roll();
      const host = into("MetricRollup")[0];
      expect(host.sql).toMatch(/INSERT INTO "MetricRollup" /);
      expect(host.sql).toMatch(/FROM "Metric"\s+WHERE "ts" >= \? AND "ts" < \?/);
      expect(host.sql).toMatch(/GROUP BY "serverId", date_trunc\('minute', "ts"\)/);
      expect(host.sql).toMatch(/ON CONFLICT \("serverId", "bucket"\) DO NOTHING/);
      const cont = into("ContainerMetricRollup")[0];
      expect(cont.sql).toMatch(/FROM "ContainerMetric"\s+WHERE "ts" >= \? AND "ts" < \?/);
      expect(cont.sql).toMatch(/GROUP BY "serverId", "containerName", date_trunc\('minute', "ts"\)/);
      expect(cont.sql).toMatch(/ON CONFLICT \("serverId", "containerName", "bucket"\) DO NOTHING/);
    });

    it("averages with avg(), keeps the peak with max(), rounds BigInt means, and lets avg() skip NULL for the optional columns", async () => {
      const { svc, into } = make();
      await svc.roll();
      const sql = into("MetricRollup")[0].sql;
      expect(sql).toMatch(/avg\("cpu"\), max\("cpu"\)/);
      expect(sql).toMatch(/round\(avg\("memUsed"\)\)::bigint/);
      expect(sql).toMatch(/avg\("load1"\), avg\("load5"\), avg\("load15"\), round\(avg\("swapUsed"\)\)::bigint, round\(avg\("swapTotal"\)\)::bigint/);
    });

    it("watermark: with existing rollups, the window starts at maxBucket + 1 minute", async () => {
      const maxBucket = new Date(Math.floor((Date.now() - 5 * MIN) / MIN) * MIN);
      const { svc, into } = make({ newestHost: maxBucket });
      await svc.roll();
      expect(window(into("MetricRollup")[0]).start).toBe(maxBucket.getTime() + MIN);
    });

    it("first run (no rollups) backfills the last 6h; window end is the CURRENT minute floor (partial minute excluded)", async () => {
      const { svc, into } = make();
      await svc.roll();
      const first = window(into("MetricRollup")[0]);
      expect(Math.abs(first.start - (Date.now() - 6 * 3600_000))).toBeLessThan(61_000);
      expect(first.start % MIN).toBe(0);
      const all = into("MetricRollup").map(window);
      const last = all[all.length - 1];
      expect(last.end % MIN).toBe(0);
      expect(last.end).toBeLessThanOrEqual(Date.now());
    });

    it("the first-run backfill is clamped to a shorter configured raw retention", async () => {
      const prev = process.env.METRICS_CONTAINER_RAW_RETENTION_HOURS;
      process.env.METRICS_CONTAINER_RAW_RETENTION_HOURS = "2";
      try {
        const { svc, into } = make();
        await svc.roll();
        expect(Math.abs(window(into("ContainerMetricRollup")[0]).start - (Date.now() - 2 * 3600_000))).toBeLessThan(61_000);
      } finally {
        if (prev === undefined) delete process.env.METRICS_CONTAINER_RAW_RETENTION_HOURS;
        else process.env.METRICS_CONTAINER_RAW_RETENTION_HOURS = prev;
      }
    });

    it("never looks further back than the kind's raw retention (host 26 h, container 6 h)", async () => {
      const { svc, into } = make({ newestHost: new Date(Date.now() - 40 * 3600_000), newestContainer: new Date(Date.now() - 40 * 3600_000) });
      await svc.roll();
      expect(Math.abs(window(into("MetricRollup")[0]).start - (Date.now() - 26 * 3600_000))).toBeLessThan(61_000);
      expect(Math.abs(window(into("ContainerMetricRollup")[0]).start - (Date.now() - 6 * 3600_000))).toBeLessThan(61_000);
    });

    it("closes a minute only after the ingest buffer has flushed it (flush interval + margin)", async () => {
      const { svc, into } = make();
      await svc.roll();
      const all = into("MetricRollup").map(window);
      const last = all[all.length - 1];
      // telemetry is buffered up to 5 s and the rollup leaves 10 s more: the newest closed minute ends at or before now - 15 s
      expect(last.end).toBeLessThanOrEqual(Math.floor((Date.now() - 15_000) / MIN) * MIN);
    });

    it("no rows → zero counts for every tier", async () => {
      const { svc } = make();
      expect(await svc.roll()).toEqual({ metric: 0, containerMetric: 0, metric5m: 0, containerMetric5m: 0 });
    });

    it("reports the buckets each statement wrote", async () => {
      const { svc } = make({ newestHost: new Date(Date.now() - 20 * MIN), inserted: (t) => (t === "MetricRollup" ? 3 : 0) });
      const res = await svc.roll();
      expect(res.metric).toBe(6); // 20 min = 2 slices, 3 buckets each
    });
  });

  describe("slicing (a long catch-up is bounded work per statement)", () => {
    it("splits a window into minute-aligned 15-minute slices, last one clipped", () => {
      const start = new Date(1_700_000_040_000);
      const end = new Date(start.getTime() + 40 * MIN);
      const out = slices(start, end);
      expect(out.map((s) => (s.end.getTime() - s.start.getTime()) / MIN)).toEqual([15, 15, 10]);
      expect(out[0].start.getTime()).toBe(start.getTime());
      expect(out[2].end.getTime()).toBe(end.getTime());
    });

    it("walks a window newest-first, the oldest slice clipped", () => {
      const out = slicesNewestFirst(new Date(0), new Date(40 * MIN)).map((x) => [x.start.getTime() / MIN, x.end.getTime() / MIN]);
      expect(out).toEqual([[25, 40], [10, 25], [0, 10]]);
    });

    it("a 25 h host catch-up never covers more than one slice per statement, and walks empty gaps in the same run", async () => {
      const { svc, into } = make({ newestHost: new Date(Date.now() - 25 * 3600_000) });
      await svc.roll();
      const ws = into("MetricRollup").map(window);
      for (const w of ws) expect(w.end - w.start).toBeLessThanOrEqual(SLICE_MS);
      expect(ws.length).toBeGreaterThan(95);
    });

    it("stops after MAX_FILLED_SLICES slices that wrote buckets; the next run resumes from the watermark", async () => {
      const { svc, into } = make({ newestHost: new Date(Date.now() - 10 * 3600_000), inserted: (t) => (t === "MetricRollup" ? 5 : 0) });
      await svc.roll();
      expect(into("MetricRollup")).toHaveLength(MAX_FILLED_SLICES);
    });
  });

  describe("5-minute tier (folded from the 1-minute tier in SQL)", () => {
    const fiveFloor = (ms: number) => Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;

    it("writes MetricRollup5m / ContainerMetricRollup5m from the 1-minute tables with avg-of-avg, max-of-max, ON CONFLICT DO NOTHING", async () => {
      const newest = new Date(fiveFloor(Date.now() - 30 * MIN) + 7 * MIN);
      const oldest = new Date(newest.getTime() - 60 * MIN);
      const { svc, into } = make({ newestHost: newest, oldestHost: oldest, newestContainer: newest, oldestContainer: oldest });
      await svc.roll();
      const host = into("MetricRollup5m")[0];
      expect(host.sql).toMatch(/FROM "MetricRollup"\s+WHERE "bucket" >= \? AND "bucket" < \?/);
      expect(host.sql).toMatch(/avg\("avgCpu"\), max\("maxCpu"\)/);
      expect(host.sql).toMatch(/GROUP BY "serverId", "b5"/);
      expect(host.sql).toMatch(/ON CONFLICT \("serverId", "bucket"\) DO NOTHING/);
      const cont = into("ContainerMetricRollup5m")[0];
      expect(cont.sql).toMatch(/FROM "ContainerMetricRollup"\s+WHERE "bucket" >= \? AND "bucket" < \?/);
      expect(cont.sql).toMatch(/ON CONFLICT \("serverId", "containerName", "bucket"\) DO NOTHING/);
    });

    it("only rolls COMPLETE 5-minute buckets: the window ends at the last boundary the 1-minute watermark has passed", async () => {
      // 1-minute watermark = minute :07 of a 5-minute grid -> minutes up to :07 are settled -> only [.., :05) is complete
      const base = fiveFloor(Date.now() - 30 * MIN);
      const { svc, into } = make({ newestHost: new Date(base + 7 * MIN), oldestHost: new Date(base - 20 * MIN) });
      await svc.roll();
      const ws = into("MetricRollup5m").map(window);
      expect(ws[ws.length - 1].end).toBe(base + 5 * MIN);
      // a watermark at :09 completes the bucket [:05, :10)
      const b = make({ newestHost: new Date(base + 9 * MIN), oldestHost: new Date(base - 20 * MIN) });
      await b.svc.roll();
      const wb = b.into("MetricRollup5m").map(window);
      expect(wb[wb.length - 1].end).toBe(base + 10 * MIN);
    });

    it("watermark: continues after the newest 5-minute bucket", async () => {
      const base = fiveFloor(Date.now() - 60 * MIN);
      const { svc, into } = make({ newestHost: new Date(base + 40 * MIN), oldestHost: new Date(base - 3 * 3600_000), newest5mHost: new Date(base + 10 * MIN), oldest5mHost: new Date(base - 3 * 3600_000) });
      await svc.roll();
      expect(window(into("MetricRollup5m")[0]).start).toBe(base + 15 * MIN);
    });

    it("an EMPTY tier (the upgrade) is seeded newest-first: the last 3 days ending at the 1-minute watermark, newest slice first", async () => {
      const newest = new Date(Date.now() - 4 * MIN);
      const { svc, into } = make({ newestHost: newest, oldestHost: new Date(Date.now() - 14 * 86_400_000), inserted: (t) => (t === "MetricRollup5m" ? 100 : 0) });
      await svc.roll();
      const ws = into("MetricRollup5m").map(window);
      const end = fiveFloor(newest.getTime() + MIN);
      expect(ws[0].end).toBe(end); // the newest slice goes first
      for (let i = 1; i < ws.length; i++) expect(ws[i].end).toBe(ws[i - 1].start); // contiguous, walking backwards
      expect(ws[ws.length - 1].start).toBe(end - SEED_5M_MS);
      for (const w of ws) expect(w.end - w.start).toBeLessThanOrEqual(SLICE_5M_MS);
      expect(ws[0].start % FIVE_MIN_MS).toBe(0); // 5-minute aligned: no bucket is ever split between slices
    });

    it("the seed is bounded to SEED_FILLED_SLICES_5M non-empty slices (a run never folds more than the 3 days)", async () => {
      const { svc, into } = make({
        newestHost: new Date(Date.now() - 4 * MIN),
        oldestHost: new Date(Date.now() - 14 * 86_400_000),
        inserted: (t) => (t === "MetricRollup5m" ? 100 : 0),
      });
      await svc.roll();
      expect(into("MetricRollup5m")).toHaveLength(SEED_FILLED_SLICES_5M);
    });

    it("a partly folded tier keeps walking BACKWARDS from its oldest bucket, at most MAX_FILLED_SLICES_5M slices per run", async () => {
      const base = fiveFloor(Date.now() - 30 * MIN);
      const oldest5 = new Date(fiveFloor(Date.now() - 3 * 86_400_000));
      const { svc, into } = make({
        newestHost: new Date(base + 9 * MIN), // -> window end = base + 10 min
        oldestHost: new Date(Date.now() - 14 * 86_400_000),
        newest5mHost: new Date(base - 5 * MIN),
        oldest5mHost: oldest5,
        inserted: (t) => (t === "MetricRollup5m" ? 100 : 0),
      });
      await svc.roll();
      const ws = into("MetricRollup5m").map(window);
      expect(ws[0]).toEqual({ start: base, end: base + 10 * MIN }); // the small forward gap first
      const back = ws.slice(1);
      expect(back).toHaveLength(MAX_FILLED_SLICES_5M);
      expect(back[0].end).toBe(oldest5.getTime());
      for (let i = 1; i < back.length; i++) expect(back[i].end).toBe(back[i - 1].start);
    });

    it("the back-fill stops at the oldest 1-minute bucket and is idle once the tier reaches it", async () => {
      const base = fiveFloor(Date.now() - 2 * 3600_000);
      const oldest = new Date(base + 2 * MIN); // 2 min into its 5-minute bucket
      const behind = make({ newestHost: new Date(Date.now() - 4 * MIN), oldestHost: oldest, newest5mHost: new Date(fiveFloor(Date.now() - 4 * MIN)), oldest5mHost: new Date(base + 30 * MIN) });
      await behind.svc.roll();
      const w = behind.into("MetricRollup5m").map(window);
      expect(w[w.length - 1].start).toBe(base); // floor of the oldest minute
      const done = make({ newestHost: new Date(Date.now() - 4 * MIN), oldestHost: oldest, newest5mHost: new Date(fiveFloor(Date.now() - 4 * MIN)), oldest5mHost: new Date(base) });
      await done.svc.roll();
      expect(done.into("MetricRollup5m")).toHaveLength(0);
    });

    it("an empty tier whose last 3 days hold no 1-minute data does not stay stuck on the seed window", async () => {
      const { svc, into } = make({
        newestHost: new Date(Date.now() - 4 * MIN),
        oldestHost: new Date(Date.now() - 10 * 86_400_000),
        // only slices older than the seed window have data
        inserted: (t, st) => (t === "MetricRollup5m" && window(st).end <= Date.now() - SEED_5M_MS ? 50 : 0),
      });
      await svc.roll();
      const ws = into("MetricRollup5m").map(window);
      expect(ws.length).toBeGreaterThan(SEED_FILLED_SLICES_5M);
      expect(ws[ws.length - 1].end).toBeLessThanOrEqual(Date.now() - SEED_5M_MS + 2 * SLICE_5M_MS);
      expect(ws.filter((w) => w.end <= Date.now() - SEED_5M_MS)).toHaveLength(MAX_FILLED_SLICES_5M);
    });

    it("never reaches back past the 28-day tier retention", async () => {
      const { svc, into } = make({ newestHost: new Date(Date.now() - 4 * MIN), oldestHost: new Date(Date.now() - 90 * 86_400_000) });
      await svc.roll();
      expect(window(into("MetricRollup5m")[0]).start).toBeGreaterThanOrEqual(Date.now() - 28 * 86_400_000 - FIVE_MIN_MS);
    });

    it("does nothing while there is no 1-minute data at all", async () => {
      const { svc, into } = make();
      await svc.roll();
      expect(into("MetricRollup5m")).toHaveLength(0);
      expect(into("ContainerMetricRollup5m")).toHaveLength(0);
    });

    it("is idle when the 5-minute watermark is already at the last complete bucket", async () => {
      const base = fiveFloor(Date.now() - 20 * MIN);
      const { svc, into } = make({ newestHost: new Date(base + 9 * MIN), oldestHost: new Date(base - 3600_000), newest5mHost: new Date(base + 5 * MIN), oldest5mHost: new Date(base - 3600_000) });
      await svc.roll();
      expect(into("MetricRollup5m")).toHaveLength(0);
    });
  });
});
