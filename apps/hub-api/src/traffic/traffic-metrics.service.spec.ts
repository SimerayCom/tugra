import { Prisma } from "@prisma/client";
import type { TrafficMetricsMsg } from "@tugra/shared";
import { TrafficMetricsService, OTHER_PATH, OTHER_KEY, UNMATCHED_HOST, UNKNOWN_COUNTRY, cleanPath, cleanCountry, cleanKey } from "./traffic-metrics.service";
import { HostResolverService } from "./host-resolver.service";

function make(owners: Record<string, { appId: string; teamId: string }> = {}) {
  const calls: Prisma.Sql[] = [];
  const prisma = {
    $executeRaw: jest.fn((sql: Prisma.Sql) => { calls.push(sql); return Promise.resolve(1); }),
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as any;
  const resolver = new HostResolverService({} as any);
  const forServer = jest.spyOn(resolver, "forServer").mockResolvedValue(new Map(Object.entries(owners)));
  const svc = new TrafficMetricsService(prisma, resolver);
  const metricCalls = () => calls.filter((c) => c.sql.includes(`INSERT INTO "TrafficMetric"`));
  const pathCalls = () => calls.filter((c) => c.sql.includes(`INSERT INTO "TrafficPath"`));
  const countryCalls = () => calls.filter((c) => c.sql.includes(`INSERT INTO "TrafficCountry"`));
  const breakdownCalls = () => calls.filter((c) => c.sql.includes(`INSERT INTO "TrafficBreakdown"`));
  const latencyCalls = () => calls.filter((c) => c.sql.includes(`INSERT INTO "TrafficLatency"`));
  return { svc, prisma, forServer, metricCalls, pathCalls, countryCalls, breakdownCalls, latencyCalls };
}
// metric row = 13 params: id, serverId, domain, appId, bucket, requests, s2xx, s3xx, s4xx, s5xx, bytes, bot, human
const metricRows = (c: Prisma.Sql) => {
  const v = c.values as unknown[];
  const rows: unknown[][] = [];
  for (let i = 0; i < v.length; i += 13) rows.push(v.slice(i, i + 13));
  return rows;
};
// breakdown row = 7 params: id, serverId, domain, bucket, dim, key, requests
const breakdownRows = (c: Prisma.Sql) => {
  const v = c.values as unknown[];
  const rows: unknown[][] = [];
  for (let i = 0; i < v.length; i += 7) rows.push(v.slice(i, i + 7));
  return rows;
};
// latency row = 6 params: id, serverId, domain, bucket, idx, requests
const latencyRows = (c: Prisma.Sql) => {
  const v = c.values as unknown[];
  const rows: unknown[][] = [];
  for (let i = 0; i < v.length; i += 6) rows.push(v.slice(i, i + 6));
  return rows;
};
// path row = 7 params: id, serverId, domain, bucket, path, requests, bytes
const pathRows = (c: Prisma.Sql) => {
  const v = c.values as unknown[];
  const rows: unknown[][] = [];
  for (let i = 0; i < v.length; i += 7) rows.push(v.slice(i, i + 7));
  return rows;
};
// country row = 6 params: id, serverId, domain, bucket, country, requests
const countryRows = (c: Prisma.Sql) => {
  const v = c.values as unknown[];
  const rows: unknown[][] = [];
  for (let i = 0; i < v.length; i += 6) rows.push(v.slice(i, i + 6));
  return rows;
};
const msg = (domains: any[], ts = Date.now()): TrafficMetricsMsg => ({ type: "traffic_metrics", ts, windowSec: 60, domains });
const stat = (o: any = {}) => ({ host: "a.com", requests: 10, s2xx: 8, s3xx: 0, s4xx: 1, s5xx: 1, bytes: 5000, paths: [], ...o });

describe("TrafficMetricsService.ingest", () => {
  it("resolves host -> app and upserts a minute-floored, increment-on-conflict row for the reporting server", async () => {
    const ts = Date.UTC(2026, 10, 9, 12, 34, 56, 789);
    jest.useFakeTimers().setSystemTime(ts);
    try {
      const { svc, metricCalls } = make({ "a.com": { appId: "app1", teamId: "t1" } });
      await svc.ingest("srv1", msg([stat({ host: "A.com:443" })], ts));
      const [call] = metricCalls();
      expect(call.sql).toContain(`ON CONFLICT ("serverId", "domain", "bucket") DO UPDATE SET`);
      for (const col of ["requests", "s2xx", "s3xx", "s4xx", "s5xx", "bytes"]) {
        expect(call.sql).toContain(`"${col}" = "TrafficMetric"."${col}" + EXCLUDED."${col}"`);
      }
      const [row] = metricRows(call);
      expect(row.slice(1)).toEqual(["srv1", "a.com", "app1", "2026-11-09 12:34:00.000", 10, 8, 0, 1, 1, 5000n, 0, 0]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a resent bucket is written as the same key with an additive upsert (sums, never overwrites)", async () => {
    const ts = Math.floor(Date.now() / 60_000) * 60_000 + 5_000; // 5s into the current minute
    const { svc, metricCalls } = make();
    await svc.ingest("srv1", msg([stat()], ts));
    await svc.ingest("srv1", msg([stat()], ts + 20_000)); // same minute
    const [a, b] = metricCalls().map((c) => metricRows(c)[0]);
    expect(a[2]).toBe(b[2]);
    expect(a[4]).toBe(b[4]); // identical (serverId, domain, bucket) conflict key
    expect(metricCalls()[1].sql).toContain(`"requests" = "TrafficMetric"."requests" + EXCLUDED."requests"`);
  });

  it("stores an unmatched host with appId null (serverId + domain kept)", async () => {
    const { svc, metricCalls } = make({ "other.com": { appId: "x", teamId: "t" } });
    await svc.ingest("srv1", msg([stat({ host: "unknown.net" })]));
    const [row] = metricRows(metricCalls()[0]);
    expect(row[1]).toBe("srv1");
    expect(row[2]).toBe("unknown.net");
    expect(row[3]).toBeNull();
  });

  it("merges duplicate hosts in one batch into one row", async () => {
    const { svc, metricCalls } = make();
    await svc.ingest("srv1", msg([stat({ host: "a.com", requests: 3 }), stat({ host: "A.COM.", requests: 4 })]));
    const rows = metricRows(metricCalls()[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0][5]).toBe(7);
  });

  it("strips the query string, truncates long paths, and keeps the top 50 with overflow folded into (other)", async () => {
    const paths = [
      { p: "/a?x=1", n: 30, b: 50 },
      { p: "/a?x=2", n: 30, b: 50 }, // same path after stripping -> summed
      { p: "/long/" + "z".repeat(500), n: 1, b: 1 },
      ...Array.from({ length: 60 }, (_, i) => ({ p: `/p${i}`, n: 100 - i, b: 10 })),
    ];
    const { svc, pathCalls } = make({ "a.com": { appId: "app1", teamId: "t1" } }); // matched host: full top-50
    await svc.ingest("srv1", msg([stat({ paths })]));
    const rows = pathRows(pathCalls()[0]);
    const byPath = new Map(rows.map((r) => [r[4] as string, r]));
    expect(byPath.get("/a")![5]).toBe(60); // summed, query dropped
    expect([...byPath.keys()].some((p) => p.includes("?"))).toBe(false);
    expect([...byPath.keys()].every((p) => p.length <= 200)).toBe(true);
    expect(rows.filter((r) => r[4] !== OTHER_PATH)).toHaveLength(50);
    // 62 distinct paths (/a, the long one, /p0../p59) -> 50 kept; the 12 lowest fold into (other):
    // the long path (n=1) + /p49../p59 (n = 51..41).
    const other = byPath.get(OTHER_PATH)!;
    expect(other).toBeDefined();
    const kept = new Set(rows.map((r) => r[4]));
    expect(kept.has("/p0")).toBe(true);
    expect(kept.has("/a")).toBe(true);
    expect(kept.has("/p48")).toBe(true); // n=52 is the last survivor
    expect(kept.has("/p49")).toBe(false);
    let expected = 1;
    for (let n = 41; n <= 51; n++) expected += n;
    expect(other[5]).toBe(expected);
  });

  it("produces no (other) row when nothing overflows", async () => {
    const { svc, pathCalls } = make();
    await svc.ingest("srv1", msg([stat({ paths: [{ p: "/a", n: 1, b: 1 }] })]));
    expect(pathRows(pathCalls()[0]).map((r) => r[4])).toEqual(["/a"]);
  });

  it("ranks by requests: matched hosts always kept, unmatched capped at 20 and the rest fold into (unmatched)", async () => {
    const { svc, metricCalls, pathCalls } = make({ "real.com": { appId: "app1", teamId: "t1" } });
    const junk = Array.from({ length: 5000 }, (_, i) => stat({ host: `x${i}.test`, requests: 1 + (i % 7), s2xx: 1, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 1, paths: [{ p: "/j", n: 1, b: 1 }] }));
    // the real host arrives LAST and with few requests: arrival order / volume must not evict it
    await svc.ingest("srv1", msg([...junk, stat({ host: "real.com", requests: 1, paths: [{ p: "/a", n: 1, b: 1 }] })]));
    const rows = metricCalls().flatMap((c) => metricRows(c));
    expect(rows).toHaveLength(1 + 20 + 1);
    const byDomain = new Map(rows.map((r) => [r[2] as string, r]));
    expect(byDomain.get("real.com")![3]).toBe("app1");
    const folded = byDomain.get(UNMATCHED_HOST)!;
    expect(folded[3]).toBeNull();
    const keptJunk = rows.filter((r) => r[2] !== "real.com" && r[2] !== UNMATCHED_HOST);
    expect(keptJunk).toHaveLength(20);
    expect(keptJunk.every((r) => r[3] === null)).toBe(true);
    // totals are preserved: every junk request is either kept or folded
    const total = junk.reduce((n, d) => n + d.requests, 0);
    expect(rows.filter((r) => r[2] !== "real.com").reduce((n, r) => n + (r[5] as number), 0)).toBe(total);
    // the kept unmatched hosts are the heaviest ones
    expect(Math.min(...keptJunk.map((r) => r[5] as number))).toBe(7);
    // paths: none for the (unmatched) aggregate; at most 10 for a kept unmatched host
    const pRows = pathCalls().flatMap((c) => pathRows(c));
    expect(pRows.some((r) => r[2] === UNMATCHED_HOST)).toBe(false);
    expect(pRows.some((r) => r[2] === "real.com" && r[4] === "/a")).toBe(true);
  });

  it("a literal (unmatched) host from the wire cannot claim the aggregate row's identity", async () => {
    const { svc, metricCalls } = make();
    await svc.ingest("srv1", msg([stat({ host: UNMATCHED_HOST, requests: 5 }), stat({ host: "a.com", requests: 3 })]));
    const rows = metricRows(metricCalls()[0]);
    const agg = rows.filter((r) => r[2] === UNMATCHED_HOST);
    expect(agg).toHaveLength(1);
    expect(agg[0][3]).toBeNull();
    expect(agg[0][5]).toBe(5);
  });

  it("caps paths for a kept unmatched host at 10", async () => {
    const { svc, pathCalls } = make();
    await svc.ingest("srv1", msg([stat({ host: "scan.test", paths: Array.from({ length: 30 }, (_, i) => ({ p: `/p${i}`, n: 30 - i, b: 1 })) })]));
    const rows = pathRows(pathCalls()[0]);
    expect(rows.filter((r) => r[4] !== OTHER_PATH)).toHaveLength(10);
    expect(rows.find((r) => r[4] === OTHER_PATH)).toBeDefined();
  });

  it("writes metrics and paths in ONE transaction (all-or-nothing)", async () => {
    const { svc, prisma } = make();
    await svc.ingest("srv1", msg([stat({ paths: [{ p: "/a", n: 1, b: 1 }] })]));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2); // one metric chunk + one path chunk
  });

  it("a failing transaction is swallowed (nothing partially applied by the service)", async () => {
    const { svc, prisma } = make();
    prisma.$transaction.mockRejectedValue(new Error("deadlock"));
    await expect(svc.ingest("srv1", msg([stat({ paths: [{ p: "/a", n: 1, b: 1 }] })]))).resolves.toBeUndefined();
  });

  it("strips NUL/control characters from hosts and paths and never splits a surrogate pair", async () => {
    expect(cleanPath("/a\u0000b\u001f/c\u007f")).toBe("/ab/c");
    expect(cleanPath("\u0000")).toBe("/");
    expect(cleanPath("/\uD83D")).toBe("/\uFFFD"); // lone high surrogate
    expect(cleanPath("/\uDE00x")).toBe("/\uFFFDx"); // lone low surrogate
    const emojiAtEdge = "/" + "a".repeat(198) + "\u{1F600}"; // pair occupies code units 199-200
    const out = cleanPath(emojiAtEdge);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toBe("/" + "a".repeat(198));
    expect(cleanPath("/ok\u{1F600}")).toBe("/ok\u{1F600}");

    const { svc, metricCalls, pathCalls } = make();
    await svc.ingest("srv1", msg([stat({ host: "a\u0000.com", paths: [{ p: "/%00\u0000", n: 1, b: 1 }] })]));
    const [m] = metricRows(metricCalls()[0]);
    expect(m[2]).toBe("a.com");
    expect(pathRows(pathCalls()[0])[0][4]).toBe("/%00");
  });

  it("guards numbers: negative / NaN / Infinity / non-number become 0", async () => {
    const { svc, metricCalls } = make();
    await svc.ingest("srv1", msg([stat({ requests: -5, s2xx: Number.NaN, s3xx: Infinity, s4xx: "9" as any, s5xx: 2.9, bytes: -1 })]));
    const [row] = metricRows(metricCalls()[0]);
    expect(row.slice(5)).toEqual([0, 0, 0, 0, 2, 0n, 0, 0]);
  });

  describe("countries", () => {
    it("stores per-country counts with an additive upsert in the same transaction as metric/path writes", async () => {
      const { svc, prisma, countryCalls } = make();
      await svc.ingest("srv1", msg([stat({ paths: [{ p: "/a", n: 1, b: 1 }], countries: [{ c: "TR", n: 7 }, { c: "DE", n: 3 }] })]));
      const [call] = countryCalls();
      expect(call.sql).toContain(`ON CONFLICT ("serverId", "domain", "bucket", "country") DO UPDATE SET`);
      expect(call.sql).toContain(`"requests" = "TrafficCountry"."requests" + EXCLUDED."requests"`);
      const rows = countryRows(call);
      expect(rows.map((r) => [r[1], r[2], r[4], r[5]])).toEqual([["srv1", "a.com", "TR", 7], ["srv1", "a.com", "DE", 3]]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3); // metric + path + country chunk
    });

    it("a resent bucket hits the same conflict key (sums, never overwrites); duplicate codes in a batch are merged", async () => {
      const ts = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
      const { svc, countryCalls } = make();
      await svc.ingest("srv1", msg([stat({ countries: [{ c: "TR", n: 2 }, { c: "TR", n: 3 }] })], ts));
      await svc.ingest("srv1", msg([stat({ countries: [{ c: "TR", n: 4 }] })], ts + 20_000));
      const [a, b] = countryCalls().map((c) => countryRows(c));
      expect(a).toHaveLength(1);
      expect(a[0][5]).toBe(5);
      expect([a[0][1], a[0][2], a[0][3], a[0][4]]).toEqual([b[0][1], b[0][2], b[0][3], b[0][4]]); // identical conflict key
      expect(b[0][5]).toBe(4);
      expect(countryCalls()[1].sql).toContain(`"requests" = "TrafficCountry"."requests" + EXCLUDED."requests"`);
    });

    it("invalid codes fold into ZZ (and merge with a literal ZZ)", async () => {
      expect(cleanCountry("TR")).toBe("TR");
      for (const bad of ["tr", "USA", "T", "", "1X", "T1", "T\u0000", 5, null, undefined, {}]) expect(cleanCountry(bad)).toBe(UNKNOWN_COUNTRY);
      const { svc, countryCalls } = make();
      await svc.ingest("srv1", msg([stat({ countries: [{ c: "TR", n: 5 }, { c: "usa", n: 2 }, { c: "9!", n: 3 }, { c: "ZZ", n: 4 }, { c: 7, n: 1 }] })]));
      const rows = countryRows(countryCalls()[0]);
      expect(rows.map((r) => [r[4], r[5]])).toEqual([["TR", 5], ["ZZ", 10]]);
    });

    it("keeps the top 50 per (domain, bucket) and folds the overflow into one ZZ row", async () => {
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const countries: { c: string; n: number }[] = [];
      for (let i = 0; i < 60; i++) countries.push({ c: A[Math.floor(i / 26)] + A[i % 26], n: 100 - i }); // AA..CH, n = 100..41
      const { svc, countryCalls } = make({ "a.com": { appId: "app1", teamId: "t1" } });
      await svc.ingest("srv1", msg([stat({ countries })]));
      const rows = countryRows(countryCalls()[0]);
      expect(rows.filter((r) => r[4] !== "ZZ")).toHaveLength(50);
      const kept = new Set(rows.map((r) => r[4]));
      expect(kept.has("AA")).toBe(true);
      expect(kept.has(A[Math.floor(49 / 26)] + A[49 % 26])).toBe(true); // n=51 last survivor
      expect(kept.has(A[Math.floor(50 / 26)] + A[50 % 26])).toBe(false);
      let expected = 0;
      for (let n = 41; n <= 50; n++) expected += n; // the 10 lowest
      expect(rows.find((r) => r[4] === "ZZ")![5]).toBe(expected);
    });

    it("guards numbers: negative / NaN / Infinity / non-number add nothing, and zero-only entries write no row", async () => {
      const { svc, countryCalls } = make();
      await svc.ingest("srv1", msg([stat({ countries: [{ c: "TR", n: -5 }, { c: "DE", n: Number.NaN }, { c: "FR", n: Infinity }, { c: "ES", n: "9" }, { c: "IT", n: 2.9 }] })]));
      expect(countryRows(countryCalls()[0]).map((r) => [r[4], r[5]])).toEqual([["IT", 2]]);
    });

    it("empty / absent / malformed countries write nothing and do not break the metric+path writes", async () => {
      const { svc, prisma, metricCalls, countryCalls } = make();
      await svc.ingest("srv1", msg([stat({ countries: [] })]));
      await svc.ingest("srv1", msg([stat()])); // older agent: field absent
      await svc.ingest("srv1", msg([stat({ countries: "nope" }), stat({ host: "b.com", countries: [null, 1, "x", { c: "TR" }, { n: 3 }] })]));
      expect(metricCalls()).toHaveLength(3);
      expect(countryCalls().flatMap(countryRows).map((r) => [r[2], r[4], r[5]])).toEqual([["b.com", "ZZ", 3]]); // { n: 3 } has no valid code -> ZZ
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(1); // metric only
    });

    it("never throws on malformed countries and a failing transaction is swallowed", async () => {
      const { svc, prisma } = make();
      for (const countries of [null, 5, "x", {}, [undefined], [[]], [{ c: { toString: 1 }, n: {} }]]) {
        await expect(svc.ingest("srv1", msg([stat({ countries })]))).resolves.toBeUndefined();
      }
      prisma.$transaction.mockRejectedValue(new Error("deadlock"));
      await expect(svc.ingest("srv1", msg([stat({ countries: [{ c: "TR", n: 1 }] })]))).resolves.toBeUndefined();
    });

    it("caps a kept unmatched host at 10 countries", async () => {
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const countries = Array.from({ length: 30 }, (_, i) => ({ c: "A" + A[i % 26] + "", n: 1 })).filter((c) => c.c.length === 2);
      const { svc, countryCalls } = make();
      await svc.ingest("srv1", msg([stat({ host: "unknown.net", countries })]));
      expect(countryRows(countryCalls()[0]).filter((r) => r[4] !== "ZZ").length).toBeLessThanOrEqual(10);
    });
  });

  describe("breakdown dimensions", () => {
    const WIRE: [string, string][] = [["browsers", "browser"], ["os", "os"], ["devices", "device"], ["referrers", "referrer"], ["cities", "city"], ["networks", "network"]];

    it("stores + sums each of the 6 dims with an additive upsert in the same transaction", async () => {
      const { svc, prisma, breakdownCalls } = make();
      const dims: Record<string, { k: string; n: number }[]> = {};
      for (const [field] of WIRE) dims[field] = [{ k: `${field}-a`, n: 5 }, { k: `${field}-a`, n: 2 }, { k: `${field}-b`, n: 1 }];
      await svc.ingest("srv1", msg([stat(dims)]));
      const [call] = breakdownCalls();
      expect(call.sql).toContain(`ON CONFLICT ("serverId", "domain", "bucket", "dim", "key") DO UPDATE SET`);
      expect(call.sql).toContain(`"requests" = "TrafficBreakdown"."requests" + EXCLUDED."requests"`);
      const rows = breakdownRows(call);
      expect(rows).toHaveLength(12);
      for (const [field, dim] of WIRE) {
        expect(rows.filter((r) => r[4] === dim).map((r) => [r[1], r[2], r[5], r[6]])).toEqual([["srv1", "a.com", `${field}-a`, 7], ["srv1", "a.com", `${field}-b`, 1]]);
      }
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2); // metric + one breakdown chunk
    });

    it("a resent bucket hits the same conflict key (sums, never overwrites)", async () => {
      const ts = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
      const { svc, breakdownCalls } = make();
      await svc.ingest("srv1", msg([stat({ browsers: [{ k: "Chrome", n: 3 }] })], ts));
      await svc.ingest("srv1", msg([stat({ browsers: [{ k: "Chrome", n: 4 }] })], ts + 20_000));
      const [a, b] = breakdownCalls().map((c) => breakdownRows(c)[0]);
      expect([a[1], a[2], a[3], a[4], a[5]]).toEqual([b[1], b[2], b[3], b[4], b[5]]);
      expect([a[6], b[6]]).toEqual([3, 4]);
    });

    it("keeps the top 50 per (domain, bucket, dim) and folds the overflow (and a literal (other)) into one (other) row", async () => {
      const browsers = Array.from({ length: 60 }, (_, i) => ({ k: `B${String(i).padStart(2, "0")}`, n: 100 - i })); // n = 100..41
      browsers.push({ k: OTHER_KEY, n: 1000 });
      const { svc, breakdownCalls } = make({ "a.com": { appId: "app1", teamId: "t1" } });
      await svc.ingest("srv1", msg([stat({ browsers, os: [{ k: "Linux", n: 1 }] })]));
      const rows = breakdownRows(breakdownCalls()[0]);
      const br = rows.filter((r) => r[4] === "browser");
      expect(br.filter((r) => r[5] !== OTHER_KEY)).toHaveLength(50);
      const kept = new Set(br.map((r) => r[5]));
      expect(kept.has("B00")).toBe(true);
      expect(kept.has("B49")).toBe(true);
      expect(kept.has("B50")).toBe(false);
      let expected = 1000;
      for (let n = 41; n <= 50; n++) expected += n;
      expect(br.find((r) => r[5] === OTHER_KEY)![6]).toBe(expected);
      expect(rows.filter((r) => r[4] === "os")).toHaveLength(1); // caps are per dim
    });

    it("caps a kept unmatched host at 10 keys per dim", async () => {
      const { svc, breakdownCalls } = make();
      await svc.ingest("srv1", msg([stat({ host: "scan.test", referrers: Array.from({ length: 30 }, (_, i) => ({ k: `r${i}.test`, n: 30 - i })) })]));
      const rows = breakdownRows(breakdownCalls()[0]);
      expect(rows.filter((r) => r[5] !== OTHER_KEY)).toHaveLength(10);
      expect(rows.find((r) => r[5] === OTHER_KEY)).toBeDefined();
    });

    it("sanitizes keys: control chars stripped, length bounded without splitting a surrogate, empty/non-string -> (other)", async () => {
      expect(cleanKey("Chro\u0000me\u001f")).toBe("Chrome");
      expect(cleanKey("  Edge ")).toBe("Edge");
      expect(cleanKey("\u0000")).toBe(OTHER_KEY);
      for (const bad of [5, null, undefined, {}, ""]) expect(cleanKey(bad)).toBe(OTHER_KEY);
      expect(cleanKey("x".repeat(500))).toHaveLength(100);
      expect(cleanKey("x".repeat(99) + "\u{1F600}")).toBe("x".repeat(99));
      expect(cleanKey("a\uD83D")).toBe("a\uFFFD");
      const { svc, breakdownCalls } = make();
      await svc.ingest("srv1", msg([stat({ browsers: [{ k: "Fire\u0000fox", n: 2 }, { k: "", n: 3 }] })]));
      expect(breakdownRows(breakdownCalls()[0]).map((r) => [r[5], r[6]])).toEqual([["(other)", 3], ["Firefox", 2]]);
    });

    it("guards numbers; zero-only entries write no row; absent/malformed dims write nothing and never throw", async () => {
      const { svc, prisma, breakdownCalls } = make();
      await svc.ingest("srv1", msg([stat({ browsers: [{ k: "A", n: -5 }, { k: "B", n: Number.NaN }, { k: "C", n: Infinity }, { k: "D", n: "9" }, { k: "E", n: 2.9 }] })]));
      expect(breakdownRows(breakdownCalls()[0]).map((r) => [r[5], r[6]])).toEqual([["E", 2]]);
      const before = breakdownCalls().length;
      for (const bad of [null, 5, "x", {}, [undefined], [null, 1, "s", []], [{ k: { toString: 1 }, n: {} }]]) {
        for (const f of ["browsers", "os", "devices", "referrers", "cities", "networks"]) {
          await expect(svc.ingest("srv1", msg([stat({ [f]: bad })]))).resolves.toBeUndefined();
        }
      }
      await svc.ingest("srv1", msg([stat()])); // older agent: no dims at all
      expect(breakdownCalls().length).toBe(before); // nothing but zero-count entries -> no rows
      prisma.$transaction.mockRejectedValue(new Error("deadlock"));
      await expect(svc.ingest("srv1", msg([stat({ os: [{ k: "Linux", n: 1 }] })]))).resolves.toBeUndefined();
    });
  });

  describe("latency histogram", () => {
    it("writes one additive row per non-empty bin (idx 0..13) in the same transaction", async () => {
      const latency = new Array(14).fill(0);
      latency[0] = 4; latency[6] = 10; latency[13] = 2;
      const { svc, prisma, latencyCalls } = make();
      await svc.ingest("srv1", msg([stat({ latency })]));
      const [call] = latencyCalls();
      expect(call.sql).toContain(`ON CONFLICT ("serverId", "domain", "bucket", "idx") DO UPDATE SET`);
      expect(call.sql).toContain(`"requests" = "TrafficLatency"."requests" + EXCLUDED."requests"`);
      expect(latencyRows(call).map((r) => [r[1], r[2], r[4], r[5]])).toEqual([["srv1", "a.com", 0, 4], ["srv1", "a.com", 6, 10], ["srv1", "a.com", 13, 2]]);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    });

    it("sums the histograms of duplicate hosts; a resent bucket uses the same conflict key", async () => {
      const a = new Array(14).fill(0); a[3] = 2; a[5] = 1;
      const b = new Array(14).fill(0); b[3] = 3;
      const { svc, latencyCalls } = make();
      await svc.ingest("srv1", msg([stat({ host: "a.com", latency: a }), stat({ host: "A.COM.", latency: b })]));
      expect(latencyRows(latencyCalls()[0]).map((r) => [r[4], r[5]])).toEqual([[3, 5], [5, 1]]);
    });

    it("ignores bins past idx 13, guards numbers, and writes nothing for empty / absent / malformed histograms", async () => {
      const { svc, latencyCalls } = make();
      const long = new Array(20).fill(7); // idx 14..19 are out of range
      await svc.ingest("srv1", msg([stat({ latency: long })]));
      const rows = latencyRows(latencyCalls()[0]);
      expect(rows).toHaveLength(14);
      expect(rows.every((r) => (r[4] as number) >= 0 && (r[4] as number) <= 13)).toBe(true);
      await svc.ingest("srv1", msg([stat({ latency: [-1, Number.NaN, Infinity, "5", 2.9] })]));
      expect(latencyRows(latencyCalls()[1]).map((r) => [r[4], r[5]])).toEqual([[4, 2]]);
      const before = latencyCalls().length;
      for (const bad of [undefined, null, 5, "x", {}, [], new Array(14).fill(0), [null, {}, "a"]]) {
        await expect(svc.ingest("srv1", msg([stat({ latency: bad })]))).resolves.toBeUndefined();
      }
      expect(latencyCalls().length).toBe(before);
    });

    it("never throws when the transaction fails", async () => {
      const { svc, prisma } = make();
      prisma.$transaction.mockRejectedValue(new Error("deadlock"));
      const latency = new Array(14).fill(1);
      await expect(svc.ingest("srv1", msg([stat({ latency })]))).resolves.toBeUndefined();
    });
  });

  describe("bot / human counters", () => {
    it("adds both counters to the metric row and its additive ON CONFLICT upsert", async () => {
      const { svc, metricCalls } = make();
      await svc.ingest("srv1", msg([stat({ bots: { human: 7, bot: 3 } })]));
      const [call] = metricCalls();
      expect(call.sql).toContain(`"botRequests" = "TrafficMetric"."botRequests" + EXCLUDED."botRequests"`);
      expect(call.sql).toContain(`"humanRequests" = "TrafficMetric"."humanRequests" + EXCLUDED."humanRequests"`);
      const [row] = metricRows(call);
      expect(row.slice(11)).toEqual([3, 7]);
    });

    it("merges duplicate hosts, folds overflow hosts into the (unmatched) aggregate, and guards negatives/NaN/garbage", async () => {
      const { svc, metricCalls } = make();
      await svc.ingest("srv1", msg([
        stat({ host: "a.com", bots: { human: 1, bot: 2 } }),
        stat({ host: "A.com", bots: { human: 3, bot: -4 } }),
        stat({ host: "b.com", bots: { human: Number.NaN, bot: Infinity } }),
        stat({ host: "c.com", bots: "x" }),
        stat({ host: "d.com" }),
      ]));
      const byHost = new Map(metricRows(metricCalls()[0]).map((r) => [r[2] as string, r.slice(11)]));
      expect(byHost.get("a.com")).toEqual([2, 4]);
      for (const h of ["b.com", "c.com", "d.com"]) expect(byHost.get(h)).toEqual([0, 0]);

      const junk = Array.from({ length: 30 }, (_, i) => stat({ host: `x${i}.test`, requests: 1 + i, bots: { human: 1, bot: 2 } }));
      const m2 = make();
      await m2.svc.ingest("srv1", msg(junk));
      const rows = m2.metricCalls().flatMap((c) => metricRows(c));
      const agg = rows.find((r) => r[2] === UNMATCHED_HOST)!;
      expect(agg.slice(11)).toEqual([20, 10]); // the 10 lightest hosts folded
      expect(rows.reduce((n, r) => n + (r[11] as number), 0)).toBe(60);
    });
  });

  it("drops a window that is far in the past or the future", async () => {
    const { svc, prisma } = make();
    await svc.ingest("srv1", msg([stat()], Date.now() - 3 * 86_400_000));
    await svc.ingest("srv1", msg([stat()], Date.now() + 3_600_000));
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("NEVER throws on a malformed batch", async () => {
    const { svc } = make();
    const bad: any[] = [
      undefined,
      null,
      {},
      { type: "traffic_metrics" },
      { ts: "x", domains: [] },
      { ts: Date.now(), domains: "nope" },
      { ts: Date.now(), domains: [null, 5, "s", {}, { host: 5 }, { host: "a.com", paths: "x" }, { host: "a.com", paths: [null, 1, { p: 3 }] }] },
      { ts: Number.NaN, domains: [stat()] },
    ];
    for (const b of bad) await expect(svc.ingest("srv1", b)).resolves.toBeUndefined();
  });

  it("swallows (and logs) a database error instead of throwing, so the socket is not closed", async () => {
    const { svc, prisma } = make();
    prisma.$executeRaw.mockRejectedValue(new Error("db down"));
    await expect(svc.ingest("srv1", msg([stat()]))).resolves.toBeUndefined();
  });

  it("swallows a resolver failure too", async () => {
    const { svc, forServer } = make();
    forServer.mockRejectedValue(new Error("boom"));
    await expect(svc.ingest("srv1", msg([stat()]))).resolves.toBeUndefined();
  });
});
