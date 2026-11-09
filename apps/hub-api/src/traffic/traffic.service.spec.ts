import { TrafficService } from "./traffic.service";

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
const inScope = (r: any, where: any) =>
  where.serverId.in.includes(r.serverId) && r.bucket >= where.bucket.gte && (!where.domain || r.domain === where.domain);

function make(queryRows: any[] = []) {
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
    application: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve([{ id: "app1", name: "Shop", serverId: "mine" }, { id: "appX", name: "Secret", serverId: "other-team" }].filter((a) => where.id.in.includes(a.id) && where.serverId.in.includes(a.serverId))),
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue(queryRows),
  } as any;
  return { svc: new TrafficService(prisma), prisma };
}

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
      expect(s.totals).toEqual({ requests: 10, s2xx: 8, s3xx: 0, s4xx: 1, s5xx: 1, bytes: 5000 });
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
});
