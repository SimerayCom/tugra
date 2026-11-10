import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { rangeToMs } from "../metrics/container-metrics.service";
import { normalizeHost } from "./host-resolver.service";
import { TRAFFIC_LATENCY_BUCKETS_MS } from "@tugra/shared";
import { OTHER_KEY, OTHER_PATH } from "./traffic-metrics.service";
import { estimate, mergeInto, newSketch } from "./hll";

const MAX_SERVERS = 500;
const MAX_DOMAINS = 500;
const DEFAULT_PATH_LIMIT = 20;
const MAX_PATH_LIMIT = 100;
const DEFAULT_COUNTRY_LIMIT = 50;
const MAX_COUNTRY_LIMIT = 250;
const DEFAULT_BREAKDOWN_LIMIT = 20;
const MAX_BREAKDOWN_LIMIT = 100;
export const BREAKDOWN_DIM_NAMES = ["browser", "os", "device", "referrer", "city", "network"] as const;
export type BreakdownDim = (typeof BREAKDOWN_DIM_NAMES)[number];
const LATENCY_BINS = TRAFFIC_LATENCY_BUCKETS_MS.length + 1;
const UNIQUE_PAGE = 500; // sketch rows (4 KB each) read per page while merging, so memory stays bounded
const MAX_UNIQUE_ROWS = 200_000; // sketch rows examined per query (work bound); newest windows are read first, so it only ever drops the OLDEST data
const UNIQUE_WINDOW_MIN_MS = 24 * 3_600_000; // minute-row table (ranges <= 24h): one read window per day
const UNIQUE_WINDOW_HOUR_MS = 5 * 86_400_000; // hour-row table (7d/30d): one read window per 5 days
const UNIQUE_CACHE_TTL_MS = 30_000; // identical (scope, range, host) summaries within this window reuse one sketch merge
const UNIQUE_CACHE_MAX = 64;

/**
 * p95 latency (ms) from a histogram of counts per TRAFFIC_LATENCY_BUCKETS_MS bucket (+ the overflow bucket, so
 * 14 counts). Method: target rank = 0.95 * total; walk the cumulative counts to the first bucket whose
 * cumulative count reaches the target, then interpolate LINEARLY inside it between its lower bound (the previous
 * bucket's upper bound, 0 for the first) and its upper bound, assuming requests are uniform across the bucket:
 * p95 = lower + (upper - lower) * (target - cumulativeBefore) / bucketCount. The overflow bucket (> 10000 ms)
 * has no upper bound, so it reports its lower bound, 10000, as a floor. An empty histogram returns 0.
 * The result is an estimate, resolution-limited by the bucket width.
 */
export function p95FromHistogram(counts: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < LATENCY_BINS; i++) total += counts[i] > 0 ? counts[i] : 0;
  if (total <= 0) return 0;
  const target = total * 0.95;
  let cum = 0;
  for (let i = 0; i < LATENCY_BINS; i++) {
    const n = counts[i] > 0 ? counts[i] : 0;
    if (n === 0) continue;
    if (cum + n >= target) {
      const lower = i === 0 ? 0 : TRAFFIC_LATENCY_BUCKETS_MS[i - 1];
      if (i >= TRAFFIC_LATENCY_BUCKETS_MS.length) return lower; // overflow bucket: floor
      const upper = TRAFFIC_LATENCY_BUCKETS_MS[i];
      return lower + ((upper - lower) * (target - cum)) / n;
    }
    cum += n;
  }
  return TRAFFIC_LATENCY_BUCKETS_MS[TRAFFIC_LATENCY_BUCKETS_MS.length - 1];
}

// Chart bucket width per range — minute rows are rolled up at query time so every series stays bounded
// (<= ~720 points) however long the range.
const STEP_SEC: Record<string, number> = { "1h": 60, "6h": 300, "24h": 900, "7d": 3600, "30d": 3600 };

export interface TrafficTotals {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  bytes: number;
  botRequests: number;
  humanRequests: number;
  p95Ms: number; // overall p95 latency over the range (0 = no latency data)
  uniqueVisitors: number; // distinct visitors over the whole range (merged HyperLogLog estimate; 0 = none/unknown)
}
export interface TrafficSummary {
  range: string;
  stepSec: number;
  times: number[];
  requests: number[];
  s2xx: number[];
  s3xx: number[];
  s4xx: number[];
  s5xx: number[];
  bytes: number[];
  p95Ms: number[]; // per-bucket p95 latency in ms, aligned to `times` (0 = no latency data in that bucket)
  uniqueVisitors: number[]; // per-bucket distinct visitors, aligned to `times` (each bucket is its own estimate; NOT additive)
  totals: TrafficTotals;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Read side of visitor traffic. EVERY query is constrained to `serverIds` — the caller must pass only the
 * ids the requester may see (ServersService.listForUser); this service performs no authorization itself,
 * so a user can never read traffic for a server (or team) they cannot see.
 */
@Injectable()
export class TrafficService {
  private readonly logger = new Logger(TrafficService.name);
  // Short-lived cache of the merged unique-visitor result (the one expensive read), keyed by the exact id scope
  // (hashed), range, host and aligned window start, so it can never serve one caller's scope to another.
  private readonly uniqueCache = new Map<string, { at: number; value: Promise<{ per: [number, number][]; total: number }> }>();

  constructor(private readonly prisma: PrismaService) {}

  async domains(serverIds: string[], range?: string) {
    const ids = serverIds.slice(0, MAX_SERVERS);
    if (ids.length === 0) return [];
    const { sinceMs } = rangeToMs(range ?? "24h");
    const rows = await this.prisma.trafficMetric.groupBy({
      by: ["domain", "appId"],
      where: { serverId: { in: ids }, bucket: { gte: new Date(sinceMs) } },
      _sum: { requests: true },
    });
    const byDomain = new Map<string, { appId: string | null; requests: number }>();
    for (const r of rows) {
      const cur = byDomain.get(r.domain) ?? { appId: null, requests: 0 };
      cur.requests += r._sum.requests ?? 0;
      cur.appId = cur.appId ?? r.appId;
      byDomain.set(r.domain, cur);
    }
    const appIds = [...new Set([...byDomain.values()].map((v) => v.appId).filter((x): x is string => !!x))];
    // Names only for apps on a visible server (defense in depth on top of the id-scoped traffic rows).
    const apps = appIds.length
      ? await this.prisma.application.findMany({ where: { id: { in: appIds }, serverId: { in: ids } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(apps.map((a) => [a.id, a.name]));
    return [...byDomain.entries()]
      .map(([domain, v]) => ({
        domain,
        appId: v.appId && nameOf.has(v.appId) ? v.appId : null,
        appName: v.appId ? (nameOf.get(v.appId) ?? null) : null,
        requests: v.requests,
      }))
      .sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain))
      .slice(0, MAX_DOMAINS);
  }

  async summary(serverIds: string[], range?: string, domain?: string): Promise<TrafficSummary> {
    const ids = serverIds.slice(0, MAX_SERVERS);
    const r = rangeToMs(range ?? "24h");
    const step = STEP_SEC[r.range];
    const stepMs = step * 1000;
    const start = Math.floor(r.sinceMs / stepMs) * stepMs;
    const end = Math.floor(Date.now() / stepMs) * stepMs;
    const times: number[] = [];
    for (let t = start; t <= end; t += stepMs) times.push(t);
    const zeros = () => times.map(() => 0);
    const out: TrafficSummary = {
      range: r.range,
      stepSec: step,
      times,
      requests: zeros(),
      s2xx: zeros(),
      s3xx: zeros(),
      s4xx: zeros(),
      s5xx: zeros(),
      bytes: zeros(),
      p95Ms: zeros(),
      uniqueVisitors: zeros(),
      totals: { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, botRequests: 0, humanRequests: 0, p95Ms: 0, uniqueVisitors: 0 },
    };
    if (ids.length === 0) return out;

    const host = domain ? normalizeHost(domain) : "";
    const rows = await this.prisma.$queryRaw<
      { t: bigint | number; requests: bigint | number; s2xx: bigint | number; s3xx: bigint | number; s4xx: bigint | number; s5xx: bigint | number; bytes: bigint | number; bot?: bigint | number | null; human?: bigint | number | null }[]
    >(Prisma.sql`
      SELECT (floor(extract(epoch FROM "bucket") / ${step}::int) * ${step}::int)::bigint * 1000 AS t,
             SUM("requests")::bigint AS requests, SUM("s2xx")::bigint AS s2xx, SUM("s3xx")::bigint AS s3xx,
             SUM("s4xx")::bigint AS s4xx, SUM("s5xx")::bigint AS s5xx, SUM("bytes")::bigint AS bytes,
             SUM("botRequests")::bigint AS bot, SUM("humanRequests")::bigint AS human
      FROM "TrafficMetric"
      WHERE "serverId" IN (${Prisma.join(ids)}) AND "bucket" >= ${new Date(start)}
        ${host ? Prisma.sql`AND "domain" = ${host}` : Prisma.empty}
      GROUP BY 1 ORDER BY 1 ASC`);
    const idx = new Map(times.map((t, i) => [t, i]));
    for (const row of rows) {
      const i = idx.get(Number(row.t));
      if (i === undefined) continue; // a bucket past `now` (clock skew) — outside the aligned window
      out.requests[i] = Number(row.requests);
      out.s2xx[i] = Number(row.s2xx);
      out.s3xx[i] = Number(row.s3xx);
      out.s4xx[i] = Number(row.s4xx);
      out.s5xx[i] = Number(row.s5xx);
      out.bytes[i] = Number(row.bytes);
      out.totals.requests += out.requests[i];
      out.totals.s2xx += out.s2xx[i];
      out.totals.s3xx += out.s3xx[i];
      out.totals.s4xx += out.s4xx[i];
      out.totals.s5xx += out.s5xx[i];
      out.totals.bytes += out.bytes[i];
      out.totals.botRequests += Number(row.bot ?? 0);
      out.totals.humanRequests += Number(row.human ?? 0);
    }

    // Latency: long-format histogram rows rolled up per chart bucket (same step as the metric rows), then p95
    // per bucket and overall (all bucket histograms summed) via p95FromHistogram.
    const lat = await this.prisma.$queryRaw<{ t: bigint | number; idx: number; n: bigint | number }[]>(Prisma.sql`
      SELECT (floor(extract(epoch FROM "bucket") / ${step}::int) * ${step}::int)::bigint * 1000 AS t,
             "idx", SUM("requests")::bigint AS n
      FROM "TrafficLatency"
      WHERE "serverId" IN (${Prisma.join(ids)}) AND "bucket" >= ${new Date(start)}
        ${host ? Prisma.sql`AND "domain" = ${host}` : Prisma.empty}
      GROUP BY 1, 2`);
    const perBucket = new Map<number, number[]>();
    const overall = new Array<number>(LATENCY_BINS).fill(0);
    for (const row of lat) {
      const i = idx.get(Number(row.t));
      const bin = Number(row.idx);
      if (i === undefined || !Number.isInteger(bin) || bin < 0 || bin >= LATENCY_BINS) continue;
      const n = Number(row.n);
      if (!Number.isFinite(n) || n <= 0) continue;
      const h = perBucket.get(i) ?? new Array<number>(LATENCY_BINS).fill(0);
      h[bin] += n;
      overall[bin] += n;
      perBucket.set(i, h);
    }
    for (const [i, h] of perBucket) out.p95Ms[i] = round1(p95FromHistogram(h));
    out.totals.p95Ms = round1(p95FromHistogram(overall));

    await this.fillUnique(out, ids, host, start, stepMs, idx);
    return out;
  }

  /**
   * Unique visitors: HyperLogLog sketches of the scoped servers (and optional host) are merged element-wise (max)
   * per chart bucket and over the whole range, then estimated. Merging sketches (not summing estimates) is what
   * keeps range and fleet counts correct: a visitor seen in many minutes / on many servers / on many hosts is
   * counted once. Ranges <= 24h read the per-minute rows, 7d/30d read the per-hour rollup rows (~60x fewer 4 KB rows
   * for the same chart buckets). Reads walk time windows NEWEST-first (each window paged by primary key, so no
   * cross-window sort) and the row cap, if ever hit, drops only the oldest windows (logged), never recent data.
   * Memory is bounded by (buckets + 1) sketches. The merged result is cached for a short TTL.
   */
  private async fillUnique(out: TrafficSummary, ids: string[], host: string, start: number, stepMs: number, idx: Map<number, number>) {
    const hourly = stepMs >= 3_600_000;
    const key = [createHash("sha1").update([...new Set(ids)].sort().join("\n")).digest("hex"), out.range, host, start].join("|");
    const now = Date.now();
    let hit = this.uniqueCache.get(key);
    if (!hit || now - hit.at > UNIQUE_CACHE_TTL_MS) {
      const value = this.mergeUnique(ids, host, start, stepMs, idx, hourly);
      hit = { at: now, value };
      this.uniqueCache.delete(key);
      this.uniqueCache.set(key, hit);
      while (this.uniqueCache.size > UNIQUE_CACHE_MAX) this.uniqueCache.delete(this.uniqueCache.keys().next().value as string);
      value.catch(() => {
        if (this.uniqueCache.get(key) === hit) this.uniqueCache.delete(key); // never cache a failure
      });
    }
    const { per, total } = await hit.value;
    for (const [i, n] of per) out.uniqueVisitors[i] = n;
    out.totals.uniqueVisitors = total;
  }

  private async mergeUnique(ids: string[], host: string, start: number, stepMs: number, idx: Map<number, number>, hourly: boolean) {
    const windowMs = hourly ? UNIQUE_WINDOW_HOUR_MS : UNIQUE_WINDOW_MIN_MS;
    const total = newSketch();
    const perBucket = new Map<number, Uint8Array>();
    const end = Math.floor(Date.now() / stepMs) * stepMs + stepMs; // exclusive: rows past the aligned window are ignored anyway
    let seen = 0;
    let truncated = false;
    for (let hi = end; hi > start && !truncated; hi -= windowMs) {
      const lo = Math.max(start, hi - windowMs);
      let lastId: string | undefined;
      for (;;) {
        if (seen >= MAX_UNIQUE_ROWS) {
          truncated = true;
          break;
        }
        const args = {
          where: {
            serverId: { in: ids },
            bucket: { gte: new Date(lo), lt: new Date(hi) },
            ...(host ? { domain: host } : {}),
            ...(lastId ? { id: { gt: lastId } } : {}),
          },
          orderBy: { id: "asc" },
          select: { id: true, bucket: true, sketch: true },
          take: UNIQUE_PAGE,
        } satisfies Prisma.TrafficUniqueFindManyArgs;
        // both tables share one shape; the table is picked per call so only the one in use is touched
        const page = await (hourly ? this.prisma.trafficUniqueHour.findMany(args) : this.prisma.trafficUnique.findMany(args));
        for (const row of page) {
          const i = idx.get(Math.floor(row.bucket.getTime() / stepMs) * stepMs);
          if (i === undefined || !row.sketch || row.sketch.length !== total.length) continue; // outside the window / malformed
          const b = perBucket.get(i) ?? newSketch();
          mergeInto(b, row.sketch);
          perBucket.set(i, b);
          mergeInto(total, row.sketch);
        }
        seen += page.length;
        if (page.length < UNIQUE_PAGE) break;
        lastId = page[page.length - 1].id;
      }
    }
    if (truncated) this.logger.warn(`unique-visitor read capped at ${MAX_UNIQUE_ROWS} sketch rows (${hourly ? "hour" : "minute"} table); the oldest windows of the range were skipped`);
    const per: [number, number][] = [];
    for (const [i, sk] of perBucket) per.push([i, estimate(sk)]);
    return { per, total: perBucket.size > 0 ? estimate(total) : 0 };
  }

  async paths(serverIds: string[], range?: string, domain?: string, limit?: number) {
    const ids = serverIds.slice(0, MAX_SERVERS);
    const r = rangeToMs(range ?? "24h");
    const take = limit !== undefined && Number.isFinite(limit) ? Math.min(MAX_PATH_LIMIT, Math.max(1, Math.floor(limit))) : DEFAULT_PATH_LIMIT;
    const empty = { range: r.range, paths: [] as { path: string; requests: number; bytes: number }[], other: { requests: 0, bytes: 0 } };
    if (ids.length === 0) return empty;
    const host = domain ? normalizeHost(domain) : "";
    const where = {
      serverId: { in: ids },
      bucket: { gte: new Date(r.sinceMs) },
      ...(host ? { domain: host } : {}),
    };
    const [rows, other] = await Promise.all([
      this.prisma.trafficPath.groupBy({
        by: ["path"],
        where: { ...where, path: { not: OTHER_PATH } },
        _sum: { requests: true, bytes: true },
        orderBy: [{ _sum: { requests: "desc" } }, { path: "asc" }],
        take,
      }),
      this.prisma.trafficPath.aggregate({ where: { ...where, path: OTHER_PATH }, _sum: { requests: true, bytes: true } }),
    ]);
    return {
      range: r.range,
      paths: rows.map((p) => ({ path: p.path, requests: p._sum.requests ?? 0, bytes: Number(p._sum.bytes ?? 0) })),
      other: { requests: other._sum.requests ?? 0, bytes: Number(other._sum.bytes ?? 0) },
    };
  }

  /** Requests per visitor country over the range, highest first ("ZZ" = unknown/overflow). */
  async countries(serverIds: string[], range?: string, domain?: string, limit?: number) {
    const ids = serverIds.slice(0, MAX_SERVERS);
    const r = rangeToMs(range ?? "24h");
    const take = limit !== undefined && Number.isFinite(limit) ? Math.min(MAX_COUNTRY_LIMIT, Math.max(1, Math.floor(limit))) : DEFAULT_COUNTRY_LIMIT;
    if (ids.length === 0) return { range: r.range, countries: [] as { country: string; requests: number }[] };
    const host = domain ? normalizeHost(domain) : "";
    const rows = await this.prisma.trafficCountry.groupBy({
      by: ["country"],
      where: {
        serverId: { in: ids },
        bucket: { gte: new Date(r.sinceMs) },
        ...(host ? { domain: host } : {}),
      },
      _sum: { requests: true },
      orderBy: [{ _sum: { requests: "desc" } }, { country: "asc" }],
      take,
    });
    return { range: r.range, countries: rows.map((c) => ({ country: c.country, requests: c._sum.requests ?? 0 })) };
  }

  /** Top keys of ONE visitor dimension (browser/os/device/referrer/city/network) over the range, highest first. */
  async breakdown(serverIds: string[], dim: BreakdownDim, range?: string, domain?: string, limit?: number) {
    const ids = serverIds.slice(0, MAX_SERVERS);
    const r = rangeToMs(range ?? "24h");
    const take = limit !== undefined && Number.isFinite(limit) ? Math.min(MAX_BREAKDOWN_LIMIT, Math.max(1, Math.floor(limit))) : DEFAULT_BREAKDOWN_LIMIT;
    const empty = { range: r.range, dim, items: [] as { key: string; requests: number }[], other: { requests: 0 } };
    if (ids.length === 0 || !(BREAKDOWN_DIM_NAMES as readonly string[]).includes(dim)) return empty;
    const host = domain ? normalizeHost(domain) : "";
    const where = {
      serverId: { in: ids },
      dim,
      bucket: { gte: new Date(r.sinceMs) },
      ...(host ? { domain: host } : {}),
    };
    const [rows, other, named] = await Promise.all([
      this.prisma.trafficBreakdown.groupBy({
        by: ["key"],
        where: { ...where, key: { not: OTHER_KEY } },
        _sum: { requests: true },
        orderBy: [{ _sum: { requests: "desc" } }, { key: "asc" }],
        take,
      }),
      this.prisma.trafficBreakdown.aggregate({ where: { ...where, key: OTHER_KEY }, _sum: { requests: true } }),
      // Total over EVERY named key (not just the top `take`), so the tail ranked below the limit is not lost.
      this.prisma.trafficBreakdown.aggregate({ where: { ...where, key: { not: OTHER_KEY } }, _sum: { requests: true } }),
    ]);
    const items = rows.map((k) => ({ key: k.key, requests: k._sum.requests ?? 0 }));
    const shown = items.reduce((n, k) => n + k.requests, 0);
    const tail = Math.max(0, (named._sum.requests ?? 0) - shown);
    // `other` = the agent/ingest per-bucket overflow PLUS the keys that fell below the hub limit, so items + other
    // always cover the dimension's full request total.
    return {
      range: r.range,
      dim,
      items,
      other: { requests: (other._sum.requests ?? 0) + tail },
    };
  }
}
