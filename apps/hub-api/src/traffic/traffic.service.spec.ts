import { TrafficService, p95FromHistogram } from "./traffic.service";
import { addString, estimate, mergeInto, newSketch } from "./hll";

const NOW = Date.UTC(2026, 10, 9, 12, 30, 0);

// In-memory TrafficMetric / TrafficPath tables honouring the `serverId: {in}` and `bucket: {gte}` filters,
// so the tests prove what is ACTUALLY read for a given visible-id set.
const metricRows = [
  { serverId: "mine", domain: "a.com", appId: "app1", bucket: new Date(NOW - 60_000), requests: 10 },
  { serverId: "mine", domain: "a.com", appId: null, bucket: new Date(NOW - 120_000), requests: 5 },
  { serverId: "mine", domain: "z.com", appId: null, bucket: new Date(NOW - 60_000), requests: 1 },
  { serverId: "other-team", domain: "secret.com", appId: "appX", bucket: new Date(NOW - 60_000), requests: 999 },
];
const pathRows = [
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), path: "/home", requests: 7, bytes: 70n },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 120_000), path: "/home", requests: 3, bytes: 30n },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), path: "/about", requests: 2, bytes: 20n },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), path: "(other)", requests: 4, bytes: 40n },
  { serverId: "other-team", domain: "secret.com", bucket: new Date(NOW - 60_000), path: "/secret", requests: 500, bytes: 5n },
];
const countryRows = [
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), country: "TR", requests: 6 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 120_000), country: "TR", requests: 4 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), country: "DE", requests: 3 },
  { serverId: "mine", domain: "z.com", bucket: new Date(NOW - 60_000), country: "US", requests: 20 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 40 * 86_400_000), country: "JP", requests: 99 }, // outside any range
  { serverId: "other-team", domain: "secret.com", bucket: new Date(NOW - 60_000), country: "KP", requests: 500 },
];
const breakdownRows = [
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), dim: "browser", key: "Chrome", requests: 6 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 120_000), dim: "browser", key: "Chrome", requests: 4 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), dim: "browser", key: "Firefox", requests: 3 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), dim: "browser", key: "(other)", requests: 8 },
  { serverId: "mine", domain: "z.com", bucket: new Date(NOW - 60_000), dim: "browser", key: "Safari", requests: 20 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 60_000), dim: "os", key: "Linux", requests: 9 },
  { serverId: "mine", domain: "a.com", bucket: new Date(NOW - 40 * 86_400_000), dim: "browser", key: "Opera", requests: 99 }, // outside any range
  { serverId: "other-team", domain: "secret.com", bucket: new Date(NOW - 60_000), dim: "browser", key: "SecretBrowser", requests: 500 },
];
const inScope = (r: any, where: any) =>
  where.serverId.in.includes(r.serverId) && r.bucket >= where.bucket.gte && (!where.domain || r.domain === where.domain);

// honours where (bucket gte/lt, id gt) / orderBy id / take, like Prisma
const uniqueFindMany = (uniqueRows: any[]) => {
  const sorted = [...uniqueRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return jest.fn(({ where, take }: any) => {
    const out: any[] = [];
    let lo = 0; // first row with id > where.id.gt (binary search keeps the 200k-row test fast)
    if (where.id?.gt) for (let hi = sorted.length; lo < hi; ) { const mid = (lo + hi) >> 1; if (sorted[mid].id > where.id.gt) hi = mid; else lo = mid + 1; }
    for (let k = lo; k < sorted.length && out.length < take; k++) {
      const r = sorted[k];
      if (!inScope(r, where) || (where.bucket.lt && r.bucket >= where.bucket.lt)) continue;
      out.push(r);
    }
    return Promise.resolve(out);
  });
};

function make(queryRows: any[] = [], latencyQueryRows: any[] = [], uniqueRows: any[] = [], uniqueHourRows: any[] = []) {
  const prisma = {
    trafficMetric: {
      groupBy: jest.fn(({ where }: any) => {
        const acc = new Map<string, any>();
        for (const r of metricRows.filter((x) => inScope(x, where))) {
          const k = `${r.domain}|${r.appId}`;
          const a = acc.get(k) ?? { domain: r.domain, appId: r.appId, _sum: { requests: 0 } };
          a._sum.requests += r.requests;
          acc.set(k, a);
        }
        return Promise.resolve([...acc.values()]);
      }),
    },
    trafficPath: {
      groupBy: jest.fn(({ where, take }: any) => {
        const acc = new Map<string, any>();
        for (const r of pathRows.filter((x) => inScope(x, where) && x.path !== where.path?.not)) {
          const a = acc.get(r.path) ?? { path: r.path, _sum: { requests: 0, bytes: 0n } };
          a._sum.requests += r.requests;
          a._sum.bytes += r.bytes;
          acc.set(r.path, a);
        }
        return Promise.resolve([...acc.values()].sort((a, b) => b._sum.requests - a._sum.requests).slice(0, take));
      }),
      aggregate: jest.fn(({ where }: any) => {
        const rs = pathRows.filter((x) => inScope(x, { ...where }) && x.path === where.path);
        return Promise.resolve({ _sum: { requests: rs.reduce((n, r) => n + r.requests, 0) || null, bytes: rs.reduce((n, r) => n + r.bytes, 0n) || null } });
      }),
    },
    trafficCountry: {
      groupBy: jest.fn(({ where, take }: any) => {
        const acc = new Map<string, any>();
        for (const r of countryRows.filter((x) => inScope(x, where))) {
          const a = acc.get(r.country) ?? { country: r.country, _sum: { requests: 0 } };
          a._sum.requests += r.requests;
          acc.set(r.country, a);
        }
        return Promise.resolve([...acc.values()].sort((a, b) => b._sum.requests - a._sum.requests).slice(0, take));
      }),
    },
    trafficBreakdown: {
      groupBy: jest.fn(({ where, take }: any) => {
        const acc = new Map<string, any>();
        for (const r of breakdownRows.filter((x) => inScope(x, where) && x.dim === where.dim && x.key !== where.key?.not)) {
          const a = acc.get(r.key) ?? { key: r.key, _sum: { requests: 0 } };
          a._sum.requests += r.requests;
          acc.set(r.key, a);
        }
        return Promise.resolve([...acc.values()].sort((a, b) => b._sum.requests - a._sum.requests).slice(0, take));
      }),
      aggregate: jest.fn(({ where }: any) => {
        const rs = breakdownRows.filter((x) => inScope(x, where) && x.dim === where.dim && (where.key?.not !== undefined ? x.key !== where.key.not : x.key === where.key));
        return Promise.resolve({ _sum: { requests: rs.reduce((n, r) => n + r.requests, 0) || null } });
      }),
    },
    trafficUnique: { findMany: uniqueFindMany(uniqueRows) },
    trafficUniqueHour: { findMany: uniqueFindMany(uniqueHourRows) },
    application: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve([{ id: "app1", name: "Shop", serverId: "mine" }, { id: "appX", name: "Secret", serverId: "other-team" }].filter((a) => where.id.in.includes(a.id) && where.serverId.in.includes(a.serverId))),
      ),
    },
    // 1st call = TrafficMetric rollup; 2nd (summary only) = TrafficLatency histogram rows
    $queryRaw: jest.fn().mockResolvedValueOnce(queryRows).mockResolvedValue(latencyQueryRows),
  } as any;
  return { svc: new TrafficService(prisma), prisma };
}

const ipsOf = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `100.${((from + i) >> 8) & 255}.${(from + i) & 255}.7`);
const uRow = (id: string, serverId: string, domain: string, ms: number, ips: string[]) => {
  const s = newSketch();
  for (const ip of ips) addString(s, ip);
  return { id, serverId, domain, bucket: new Date(ms), sketch: Buffer.from(s) };
};

describe("TrafficService", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  describe("AUTHZ scoping (serverIds are the caller's visible set)", () => {
    it("domains: never returns a host (or app name) from a server outside the visible set", async () => {
      const { svc, prisma } = make();
      const out = await svc.domains(["mine"], "24h");
      expect(prisma.trafficMetric.groupBy.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      expect(out.map((d) => d.domain)).toEqual(["a.com", "z.com"]);
      expect(out[0]).toEqual({ domain: "a.com", appId: "app1", appName: "Shop", requests: 15 });
      expect(JSON.stringify(out)).not.toContain("secret");
    });

    it("domains: no visible servers -> empty, the table is never read", async () => {
      const { svc, prisma } = make();
      expect(await svc.domains([], "24h")).toEqual([]);
      expect(prisma.trafficMetric.groupBy).not.toHaveBeenCalled();
    });

    it("paths: constrained to the visible ids; other teams' paths never appear", async () => {
      const { svc, prisma } = make();
      const out = await svc.paths(["mine"], "24h");
      expect(prisma.trafficPath.groupBy.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      expect(prisma.trafficPath.aggregate.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      expect(out.paths.map((p) => p.path)).toEqual(["/home", "/about"]);
      expect(JSON.stringify(out)).not.toContain("secret");
    });

    it("countries: constrained to the visible ids; other teams' countries never appear; no ids -> empty without a read", async () => {
      const { svc, prisma } = make();
      const out = await svc.countries(["mine"], "24h");
      expect(prisma.trafficCountry.groupBy.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      expect(out.countries.map((c) => c.country)).toEqual(["US", "TR", "DE"]);
      expect(JSON.stringify(out)).not.toContain("KP");
      expect((await svc.countries([], "24h")).countries).toEqual([]);
      expect(prisma.trafficCountry.groupBy).toHaveBeenCalledTimes(1);
    });

    it("summary: the SQL is bound to exactly the visible ids (never another server's id)", async () => {
      const { svc, prisma } = make();
      await svc.summary(["mine", "mine2"], "24h", "a.com");
      const sql = prisma.$queryRaw.mock.calls[0][0];
      expect(sql.sql).toContain(`"serverId" IN (`);
      expect(sql.values).toEqual(expect.arrayContaining(["mine", "mine2", "a.com"]));
      expect(sql.values).not.toContain("other-team");
    });

    it("breakdown: constrained to the visible ids; other teams' keys never appear; no ids -> empty without a read", async () => {
      const { svc, prisma } = make();
      const out = await svc.breakdown(["mine"], "browser", "24h");
      expect(prisma.trafficBreakdown.groupBy.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      expect(prisma.trafficBreakdown.aggregate.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      expect(out.items.map((i) => i.key)).toEqual(["Safari", "Chrome", "Firefox"]);
      expect(JSON.stringify(out)).not.toContain("SecretBrowser");
      expect((await svc.breakdown([], "browser", "24h")).items).toEqual([]);
      expect(prisma.trafficBreakdown.groupBy).toHaveBeenCalledTimes(1);
    });

    it("summary latency query is bound to exactly the visible ids", async () => {
      const { svc, prisma } = make();
      await svc.summary(["mine"], "24h", "a.com");
      const sql = prisma.$queryRaw.mock.calls[1][0];
      expect(sql.sql).toContain(`"TrafficLatency"`);
      expect(sql.values).toEqual(expect.arrayContaining(["mine", "a.com"]));
      expect(sql.values).not.toContain("other-team");
    });

    it("summary + paths with no visible servers return zero-filled/empty without touching the DB", async () => {
      const { svc, prisma } = make();
      const s = await svc.summary([], "1h");
      expect(s.totals.requests).toBe(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect((await svc.paths([], "1h")).paths).toEqual([]);
      expect(prisma.trafficPath.groupBy).not.toHaveBeenCalled();
    });
  });

  describe("summary", () => {
    it("returns aligned, zero-filled arrays of one length for every series, plus totals", async () => {
      const minute = Math.floor((NOW - 60_000) / 60_000) * 60_000;
      const { svc } = make([{ t: BigInt(minute), requests: 10n, s2xx: 8n, s3xx: 0n, s4xx: 1n, s5xx: 1n, bytes: 5000n }]);
      const s = await svc.summary(["mine"], "1h");
      const n = s.times.length;
      expect(n).toBe(61); // 1h at 1-minute steps, inclusive of the current minute
      for (const k of ["requests", "s2xx", "s3xx", "s4xx", "s5xx", "bytes"] as const) expect(s[k]).toHaveLength(n);
      expect(s.times[1] - s.times[0]).toBe(60_000);
      expect(s.requests[s.times.indexOf(minute)]).toBe(10);
      expect(s.requests.filter((x) => x === 0)).toHaveLength(n - 1);
      expect(s.totals).toEqual({ requests: 10, s2xx: 8, s3xx: 0, s4xx: 1, s5xx: 1, bytes: 5000, botRequests: 0, humanRequests: 0, p95Ms: 0, uniqueVisitors: 0 });
      expect(s.p95Ms).toHaveLength(n);
      expect(s.p95Ms.every((x) => x === 0)).toBe(true);
      expect(typeof s.bytes[0]).toBe("number"); // BigInt never reaches the wire
    });

    it("rolls long ranges up to hourly buckets so the arrays stay bounded", async () => {
      const hour = Math.floor(NOW / 3_600_000) * 3_600_000;
      const { svc, prisma } = make([
        { t: BigInt(hour), requests: 100n, s2xx: 100n, s3xx: 0n, s4xx: 0n, s5xx: 0n, bytes: 1n },
        { t: BigInt(hour - 3_600_000), requests: 50n, s2xx: 50n, s3xx: 0n, s4xx: 0n, s5xx: 0n, bytes: 1n },
      ]);
      const week = await svc.summary(["mine"], "7d");
      expect(week.stepSec).toBe(3600);
      expect(week.times.length).toBeLessThanOrEqual(169);
      expect(week.times[1] - week.times[0]).toBe(3_600_000);
      expect(week.totals.requests).toBe(150);
      expect(prisma.$queryRaw.mock.calls[0][0].values).toContain(3600);
      const month = await svc.summary(["mine"], "30d");
      expect(month.times.length).toBeLessThanOrEqual(721);
    });

    it("ignores a bucket outside the aligned window and an unknown range falls back safely", async () => {
      const { svc } = make([{ t: BigInt(NOW + 10 * 3_600_000), requests: 9n, s2xx: 9n, s3xx: 0n, s4xx: 0n, s5xx: 0n, bytes: 0n }]);
      const s = await svc.summary(["mine"], "constructor" as any);
      expect(s.range).toBe("1h");
      expect(s.totals.requests).toBe(0);
    });

    it("normalizes the domain filter (case/port) before binding it", async () => {
      const { svc, prisma } = make();
      await svc.summary(["mine"], "1h", "A.com:443");
      expect(prisma.$queryRaw.mock.calls[0][0].values).toContain("a.com");
    });
  });

  describe("summary: p95 latency + bot/human", () => {
    it("computes a per-bucket p95 aligned to times, plus an overall p95 from the summed histograms", async () => {
      const m1 = Math.floor((NOW - 60_000) / 60_000) * 60_000;
      const m2 = m1 - 120_000;
      const { svc } = make(
        [
          { t: BigInt(m1), requests: 30n, s2xx: 30n, s3xx: 0n, s4xx: 0n, s5xx: 0n, bytes: 1n, bot: 10n, human: 20n },
          { t: BigInt(m2), requests: 10n, s2xx: 10n, s3xx: 0n, s4xx: 0n, s5xx: 0n, bytes: 1n, bot: 1n, human: 9n },
        ],
        [
          { t: BigInt(m1), idx: 6, n: 100n }, // all in (50,100] -> 97.5
          { t: BigInt(m2), idx: 13, n: 4n }, // overflow only -> 10000 floor
          { t: BigInt(m2), idx: 99, n: 50n }, // invalid idx ignored
          { t: BigInt(NOW + 10 * 3_600_000), idx: 2, n: 5n }, // outside the aligned window
        ],
      );
      const s = await svc.summary(["mine"], "1h");
      expect(s.p95Ms).toHaveLength(s.times.length);
      expect(s.p95Ms[s.times.indexOf(m1)]).toBe(97.5);
      expect(s.p95Ms[s.times.indexOf(m2)]).toBe(10000);
      expect(s.p95Ms.filter((x) => x === 0)).toHaveLength(s.times.length - 2);
      // overall: 100 @ idx6 + 4 @ idx13 -> target 98.8 reached inside idx6 -> 50 + 50*98.8/100 = 99.4
      expect(s.totals.p95Ms).toBe(99.4);
      expect(s.totals.botRequests).toBe(11);
      expect(s.totals.humanRequests).toBe(29);
    });
  });

  describe("p95FromHistogram", () => {
    const hist = (entries: Record<number, number>) => {
      const h = new Array(14).fill(0);
      for (const [i, n] of Object.entries(entries)) h[Number(i)] = n;
      return h;
    };
    it("empty histogram -> 0", () => {
      expect(p95FromHistogram(hist({}))).toBe(0);
      expect(p95FromHistogram([])).toBe(0);
    });
    it("everything in one bucket interpolates to lower + 0.95 * width", () => {
      expect(p95FromHistogram(hist({ 6: 100 }))).toBeCloseTo(97.5, 6); // (50,100]
      expect(p95FromHistogram(hist({ 0: 10 }))).toBeCloseTo(0.95, 6); // first bucket (0,1]
      expect(p95FromHistogram(hist({ 12: 7 }))).toBeCloseTo(5000 + 0.95 * 5000, 6); // (5000,10000]
    });
    it("known multi-bucket histogram: 90 fast + 10 slow", () => {
      // 90 in (0,1], 10 in (250,500]: target 95 -> falls in the slow bucket: 250 + 250 * (95-90)/10 = 375
      expect(p95FromHistogram(hist({ 0: 90, 8: 10 }))).toBeCloseTo(375, 6);
      // 95 fast + 5 slow: target exactly 95 reached by the fast bucket -> its upper bound 1
      expect(p95FromHistogram(hist({ 0: 95, 8: 5 }))).toBeCloseTo(1, 6);
    });
    it("overflow bucket reports its lower bound (10000) as a floor", () => {
      expect(p95FromHistogram(hist({ 13: 5 }))).toBe(10000);
      expect(p95FromHistogram(hist({ 2: 90, 13: 10 }))).toBe(10000);
      expect(p95FromHistogram(hist({ 2: 96, 13: 4 }))).toBeLessThan(5); // overflow below the 5% tail does not matter
    });
    it("ignores negative/NaN entries", () => {
      expect(p95FromHistogram(hist({ 6: 100, 3: -50, 4: Number.NaN }))).toBeCloseTo(97.5, 6);
    });
  });

  describe("breakdown", () => {
    it("aggregates across buckets within the range, orders by requests desc, reports (other) separately", async () => {
      const { svc } = make();
      const out = await svc.breakdown(["mine"], "browser", "24h");
      expect(out.range).toBe("24h");
      expect(out.dim).toBe("browser");
      expect(out.items).toEqual([
        { key: "Safari", requests: 20 },
        { key: "Chrome", requests: 10 },
        { key: "Firefox", requests: 3 },
      ]); // Opera (40 days old) is outside the range; "(other)" excluded from items
      expect(out.other).toEqual({ requests: 8 });
    });

    it("filters by dimension: another dim's keys never mix in", async () => {
      const { svc, prisma } = make();
      const out = await svc.breakdown(["mine"], "os", "24h");
      expect(prisma.trafficBreakdown.groupBy.mock.calls[0][0].where.dim).toBe("os");
      expect(out.items).toEqual([{ key: "Linux", requests: 9 }]);
    });

    it("an unknown dim reads nothing (defense in depth behind the DTO enum)", async () => {
      const { svc, prisma } = make();
      expect((await svc.breakdown(["mine"], "country" as any, "24h")).items).toEqual([]);
      expect(prisma.trafficBreakdown.groupBy).not.toHaveBeenCalled();
    });

    it("honors the normalized domain filter and only narrows within scope", async () => {
      const { svc, prisma } = make();
      const out = await svc.breakdown(["mine"], "browser", "24h", "A.com:443");
      expect(prisma.trafficBreakdown.groupBy.mock.calls[0][0].where.domain).toBe("a.com");
      expect(out.items).toEqual([{ key: "Chrome", requests: 10 }, { key: "Firefox", requests: 3 }]);
      expect((await svc.breakdown(["mine"], "browser", "24h", "secret.com")).items).toEqual([]); // another team's host
    });

    it("folds keys ranked below the limit into other so items + other cover the whole dimension", async () => {
      const { svc } = make();
      const out = await svc.breakdown(["mine"], "browser", "24h", undefined, 1);
      expect(out.items).toEqual([{ key: "Safari", requests: 20 }]);
      // stored "(other)" 8 + tail below the limit (Chrome 10 + Firefox 3)
      expect(out.other).toEqual({ requests: 21 });
      expect(out.items.reduce((n, i) => n + i.requests, 0) + out.other.requests).toBe(41);
    });

    it("clamps the limit", async () => {
      const { svc, prisma } = make();
      await svc.breakdown(["mine"], "browser", "24h", undefined, 100000);
      expect(prisma.trafficBreakdown.groupBy.mock.calls[0][0].take).toBe(100);
      await svc.breakdown(["mine"], "browser", "24h", undefined, -3);
      expect(prisma.trafficBreakdown.groupBy.mock.calls[1][0].take).toBe(1);
      await svc.breakdown(["mine"], "browser", "24h");
      expect(prisma.trafficBreakdown.groupBy.mock.calls[2][0].take).toBe(20);
    });
  });

  describe("paths", () => {
    it("aggregates across buckets, orders by requests desc, and reports (other) separately", async () => {
      const { svc } = make();
      const out = await svc.paths(["mine"], "24h", "a.com");
      expect(out.paths).toEqual([
        { path: "/home", requests: 10, bytes: 100 },
        { path: "/about", requests: 2, bytes: 20 },
      ]);
      expect(out.other).toEqual({ requests: 4, bytes: 40 });
    });

    it("clamps the limit", async () => {
      const { svc, prisma } = make();
      await svc.paths(["mine"], "24h", undefined, 100000);
      expect(prisma.trafficPath.groupBy.mock.calls[0][0].take).toBe(100);
      await svc.paths(["mine"], "24h", undefined, -3);
      expect(prisma.trafficPath.groupBy.mock.calls[1][0].take).toBe(1);
      await svc.paths(["mine"], "24h");
      expect(prisma.trafficPath.groupBy.mock.calls[2][0].take).toBe(20);
    });
  });

  describe("countries", () => {
    it("aggregates across buckets within the range and orders by requests desc", async () => {
      const { svc } = make();
      const out = await svc.countries(["mine"], "24h");
      expect(out.range).toBe("24h");
      expect(out.countries).toEqual([
        { country: "US", requests: 20 },
        { country: "TR", requests: 10 },
        { country: "DE", requests: 3 },
      ]); // JP (40 days old) is outside the range
    });

    it("honors the domain filter (normalized) and only narrows within scope", async () => {
      const { svc, prisma } = make();
      const out = await svc.countries(["mine"], "24h", "A.com:443");
      expect(prisma.trafficCountry.groupBy.mock.calls[0][0].where.domain).toBe("a.com");
      expect(out.countries).toEqual([{ country: "TR", requests: 10 }, { country: "DE", requests: 3 }]);
      expect((await svc.countries(["mine"], "24h", "secret.com")).countries).toEqual([]); // another team's host
    });

    it("clamps the limit", async () => {
      const { svc, prisma } = make();
      await svc.countries(["mine"], "24h", undefined, 100000);
      expect(prisma.trafficCountry.groupBy.mock.calls[0][0].take).toBe(250);
      await svc.countries(["mine"], "24h", undefined, -3);
      expect(prisma.trafficCountry.groupBy.mock.calls[1][0].take).toBe(1);
      await svc.countries(["mine"], "24h");
      expect(prisma.trafficCountry.groupBy.mock.calls[2][0].take).toBe(50);
    });
  });

  describe("summary: unique visitors (merged HyperLogLog)", () => {
    const m1 = Math.floor((NOW - 60_000) / 60_000) * 60_000;
    const m2 = m1 - 60_000;

    it("merges sketches, never sums estimates: a visitor seen in two minutes counts once; buckets align to times", async () => {
      const rows = [
        uRow("a", "mine", "a.com", m1, ipsOf(0, 100)),
        uRow("b", "mine", "a.com", m2, ipsOf(50, 150)), // overlaps 50..99
        uRow("c", "mine", "z.com", m2, ipsOf(120, 200)), // another host, overlaps 120..149
      ];
      const { svc } = make([], [], rows);
      const s = await svc.summary(["mine"], "1h");
      expect(s.uniqueVisitors).toHaveLength(s.times.length);
      expect(Math.abs(s.totals.uniqueVisitors - 200)).toBeLessThanOrEqual(4); // the union, not 100+100+80
      expect(Math.abs(s.uniqueVisitors[s.times.indexOf(m1)] - 100)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.uniqueVisitors[s.times.indexOf(m2)] - 150)).toBeLessThanOrEqual(4); // b + c within the same minute
      expect(s.uniqueVisitors.filter((x) => x === 0)).toHaveLength(s.times.length - 2);
      const host = await svc.summary(["mine"], "1h", "A.com:443"); // domain filter is normalized and applied
      expect(Math.abs(host.totals.uniqueVisitors - 150)).toBeLessThanOrEqual(4);
    });

    it("7d/30d read the hourly rollup table (not the minute table); <= 24h read the minute table", async () => {
      const hour = Math.floor((NOW - 3 * 3_600_000) / 3_600_000) * 3_600_000;
      const hourRows = [uRow("a", "mine", "a.com", hour, ipsOf(0, 60)), uRow("b", "mine", "z.com", hour, ipsOf(30, 90))]; // two hosts, same hour
      const { svc, prisma } = make([], [], [uRow("m", "mine", "a.com", hour + 60_000, ipsOf(5000, 9000))], hourRows);
      for (const range of ["7d", "30d"]) {
        const s = await svc.summary(["mine"], range);
        const i = s.times.indexOf(hour);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(Math.abs(s.uniqueVisitors[i] - 90)).toBeLessThanOrEqual(3); // union of the hour rows, the minute row is not read
        expect(s.totals.uniqueVisitors).toBe(s.uniqueVisitors[i]);
      }
      expect(prisma.trafficUnique.findMany).not.toHaveBeenCalled();
      await svc.summary(["mine"], "24h");
      expect(prisma.trafficUnique.findMany).toHaveBeenCalled();
      expect(prisma.trafficUniqueHour.findMany.mock.calls.length).toBeGreaterThan(0);
    });

    it("the row cap never hides recent data: windows are read newest-first and only the OLDEST are skipped", async () => {
      const old = NOW - 29 * 86_400_000; // oldest 5-day window of a 30d range
      const sk = uRow("x", "mine", "a.com", old, ipsOf(0, 5)).sketch;
      const oldRows = Array.from({ length: 200_500 }, (_, i) => ({ id: `o${String(i).padStart(6, "0")}`, serverId: "mine", domain: "a.com", bucket: new Date(old), sketch: sk }));
      const recentHour = Math.floor((NOW - 3_600_000) / 3_600_000) * 3_600_000;
      const recent = uRow("recent", "mine", "a.com", recentHour, ipsOf(1000, 1100));
      const { svc, prisma } = make([], [], [], [...oldRows, recent]);
      const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
      const s = await svc.summary(["mine"], "30d");
      expect(Math.abs(s.uniqueVisitors[s.times.indexOf(recentHour)] - 100)).toBeLessThanOrEqual(3); // newest data present
      expect(s.totals.uniqueVisitors).toBeGreaterThanOrEqual(95);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("capped")); // not silent
      const calls = prisma.trafficUniqueHour.findMany.mock.calls.map((c: any[]) => c[0]);
      expect(calls[0].where.bucket.lt.getTime()).toBeGreaterThan(calls[calls.length - 1].where.bucket.lt.getTime()); // newest window first
      expect(calls.every((c: any) => JSON.stringify(c.orderBy) === JSON.stringify({ id: "asc" }) && c.skip === undefined)).toBe(true); // keyset paging, no skip/offset sort
    }, 60_000);

    it("identical summaries within the TTL reuse one merge (cache); a different scope/host/range does not share it", async () => {
      const rows = [uRow("a", "mine", "a.com", m1, ipsOf(0, 50)), uRow("b", "other-team", "a.com", m1, ipsOf(1000, 2000))];
      const { svc, prisma } = make([], [], rows);
      const a = await svc.summary(["mine"], "1h");
      const calls = prisma.trafficUnique.findMany.mock.calls.length;
      const b = await svc.summary(["mine"], "1h");
      expect(prisma.trafficUnique.findMany.mock.calls.length).toBe(calls);
      expect(b.totals.uniqueVisitors).toBe(a.totals.uniqueVisitors);
      const other = await svc.summary(["other-team"], "1h"); // different scope -> never served mine's result
      expect(other.totals.uniqueVisitors).toBeGreaterThan(900);
      expect((await svc.summary(["mine"], "1h", "z.com")).totals.uniqueVisitors).toBe(0);
      (Date.now as jest.Mock).mockReturnValue(NOW + 31_000);
      await svc.summary(["mine"], "1h");
      expect(prisma.trafficUnique.findMany.mock.calls.length).toBeGreaterThan(calls + 2); // expired -> re-read
    });

    it("pages through more than one page of rows and merges them all", async () => {
      const rows = Array.from({ length: 1200 }, (_, i) => uRow(`r${String(i).padStart(4, "0")}`, "mine", "a.com", m1, ipsOf(i * 2, i * 2 + 2)));
      const { svc, prisma } = make([], [], rows);
      const s = await svc.summary(["mine"], "1h");
      expect(prisma.trafficUnique.findMany.mock.calls.length).toBe(3); // 500 + 500 + 200
      expect(Math.abs(s.totals.uniqueVisitors - 2400) / 2400).toBeLessThan(0.05);
    });

    it("is scoped to the visible ids, ignores malformed rows, and returns 0 when there is nothing", async () => {
      const rows = [
        uRow("a", "mine", "a.com", m1, ipsOf(0, 10)),
        uRow("x", "other-team", "secret.com", m1, ipsOf(1000, 4000)),
        { id: "bad", serverId: "mine", domain: "a.com", bucket: new Date(m1), sketch: Buffer.alloc(10) },
      ];
      const { svc, prisma } = make([], [], rows);
      const s = await svc.summary(["mine"], "1h");
      expect(s.totals.uniqueVisitors).toBe(10);
      expect(prisma.trafficUnique.findMany.mock.calls[0][0].where.serverId).toEqual({ in: ["mine"] });
      const none = await make().svc.summary(["mine"], "1h");
      expect(none.totals.uniqueVisitors).toBe(0);
      expect(none.uniqueVisitors.every((x) => x === 0)).toBe(true);
      const empty = await svc.summary([], "1h");
      expect(empty.totals.uniqueVisitors).toBe(0);
    });

    it("estimate helper agrees with the merged result (sanity)", () => {
      const a = newSketch();
      const b = newSketch();
      for (const ip of ipsOf(0, 10)) addString(a, ip);
      for (const ip of ipsOf(5, 15)) addString(b, ip);
      mergeInto(a, b);
      expect(estimate(a)).toBe(15);
    });
  });
});
