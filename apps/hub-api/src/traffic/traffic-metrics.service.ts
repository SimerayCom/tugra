import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { TRAFFIC_LATENCY_BUCKETS_MS, type TrafficMetricsMsg } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { HostResolverService, normalizeHost } from "./host-resolver.service";

const MAX_RAW_DOMAINS = 10_000; // incoming domain entries examined per message (work bound; ranking happens after merge)
const MAX_UNMATCHED_HOSTS = 20; // unmatched (no owning app) hosts kept verbatim per (server, bucket); the rest fold into UNMATCHED_HOST
const MAX_UNMATCHED_PATHS = 10; // distinct paths kept for a kept unmatched host
const MAX_RAW_HOST_LEN = 1024; // longer raw Host values are discarded before any string work
const MAX_RAW_PATHS = 2000; // incoming path entries examined per domain
const MAX_PATHS = 50; // distinct paths kept per (domain, bucket); the rest fold into OTHER_PATH
const MAX_RAW_COUNTRIES = 500; // incoming country entries examined per domain
const MAX_COUNTRIES = 50; // distinct country codes kept per (domain, bucket); the rest fold into UNKNOWN_COUNTRY
const MAX_UNMATCHED_COUNTRIES = 10; // same, for a kept unmatched (attacker-controlled) host
const MAX_RAW_BREAKDOWN = 500; // incoming entries examined per (domain, dimension)
const MAX_BREAKDOWN = 50; // distinct keys kept per (domain, bucket, dim); the rest fold into OTHER_KEY
const MAX_UNMATCHED_BREAKDOWN = 10; // same, for a kept unmatched (attacker-controlled) host
const MAX_KEY_LEN = 100;
const LATENCY_BINS = TRAFFIC_LATENCY_BUCKETS_MS.length + 1; // 13 bounds + the overflow bucket = idx 0..13
const MAX_PATH_LEN = 200;
const MAX_HOST_LEN = 253;
const MAX_INT = 2_147_483_647;
const MAX_AGE_MS = 24 * 3600_000; // a window older than this (or far in the future) is dropped
const MAX_FUTURE_MS = 5 * 60_000;
const ROW_CHUNK = 500; // rows per multi-row INSERT (parameter-count bound)
export const OTHER_PATH = "(other)";
export const OTHER_KEY = "(other)"; // overflow key of a TrafficBreakdown dimension
/** Wire field on TrafficDomainStat -> TrafficBreakdown.dim. */
export const BREAKDOWN_DIMS = [
  ["browsers", "browser"],
  ["os", "os"],
  ["devices", "device"],
  ["referrers", "referrer"],
  ["cities", "city"],
  ["networks", "network"],
] as const;
export const UNKNOWN_COUNTRY = "ZZ"; // invalid codes and the overflow beyond the per-bucket country cap
const COUNTRY_RE = /^[A-Z]{2}$/;
export const UNMATCHED_HOST = "(unmatched)"; // aggregate row for unmatched hosts beyond the per-bucket cap (appId null, no paths)

interface Counters {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  bytes: number;
  bot: number;
  human: number;
}
interface PathAcc {
  n: number;
  b: number;
}

/** Non-negative finite integer (floored), clamped to `max`; anything else → 0. */
function count(v: unknown, max = MAX_INT): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Drops NUL/control characters (Postgres TEXT rejects 0x00) and replaces lone surrogates (invalid JSON/UTF-8). */
function sanitizeText(s: string): string {
  return s.replace(CONTROL_CHARS, "").replace(LONE_SURROGATE, "\uFFFD");
}

/** Breakdown key: sanitized, trimmed, bounded in length (never splitting a surrogate pair); empty/non-string -> "(other)". */
export function cleanKey(raw: unknown): string {
  if (typeof raw !== "string") return OTHER_KEY;
  let k = sanitizeText(raw.slice(0, MAX_KEY_LEN + 1)).trim();
  if (k.length > MAX_KEY_LEN) {
    k = k.slice(0, MAX_KEY_LEN);
    if (/[\uD800-\uDBFF]$/.test(k)) k = k.slice(0, -1);
  }
  return k === "" ? OTHER_KEY : k;
}

/** ISO-3166 alpha-2-shaped code (two uppercase letters) as-is; anything else → "ZZ". */
export function cleanCountry(raw: unknown): string {
  return typeof raw === "string" && COUNTRY_RE.test(raw) ? raw : UNKNOWN_COUNTRY;
}

/** Path without its query string / fragment, sanitized, bounded in length (never splitting a surrogate pair); empty → "/". */
export function cleanPath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let p = sanitizeText(raw.split("?")[0].split("#")[0].slice(0, MAX_PATH_LEN + 1));
  if (p.length > MAX_PATH_LEN) {
    p = p.slice(0, MAX_PATH_LEN);
    if (/[\uD800-\uDBFF]$/.test(p)) p = p.slice(0, -1);
  }
  return p === "" ? "/" : p;
}

/** Sanitized + normalized host, or "" when unusable. */
function cleanHost(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAX_RAW_HOST_LEN) return "";
  const host = normalizeHost(sanitizeText(raw));
  return host && host.length <= MAX_HOST_LEN ? host : "";
}

/** "YYYY-MM-DD HH:MM:SS.mmm" (UTC) so the `::timestamp` cast is independent of the session time zone. */
function tsLiteral(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Ingests the agent's per-minute visitor-traffic aggregates. The batch is already summed per host by the
 * agent, so each (server, host, minute) is ONE row, written with an upsert-INCREMENT: overlapping or
 * same-minute windows sum instead of overwriting. The upsert is additive, NOT idempotent: the agent contract
 * is disjoint windows, each reported at most once (never replayed). The Host header is attacker-controlled,
 * so hosts are ranked by requests: matched hosts are always kept, unmatched ones are capped per bucket and
 * the remainder folds into one UNMATCHED_HOST row. Both writes of a batch run in one transaction. Only counts
 * are stored — never client IPs. ingest() never throws: the socket handler closes the connection on a throw,
 * so a bad batch is logged and dropped.
 */
@Injectable()
export class TrafficMetricsService {
  private readonly logger = new Logger(TrafficMetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: HostResolverService,
  ) {}

  async ingest(serverId: string, msg: TrafficMetricsMsg): Promise<void> {
    try {
      await this.ingestUnsafe(serverId, msg);
    } catch (e) {
      this.logger.warn(`traffic batch dropped for server ${serverId}: ${(e as Error)?.message ?? e}`);
    }
  }

  private async ingestUnsafe(serverId: string, msg: TrafficMetricsMsg): Promise<void> {
    if (!msg || !Array.isArray(msg.domains) || msg.domains.length === 0) return;
    const ts = typeof msg.ts === "number" ? msg.ts : Number.NaN;
    const now = Date.now();
    if (!Number.isFinite(ts) || ts < now - MAX_AGE_MS || ts > now + MAX_FUTURE_MS) return;
    const bucket = new Date(Math.floor(ts / 60_000) * 60_000);

    // Pass 1: merge duplicate hosts' counters (one INSERT must not touch the same key twice). Paths are merged
    // later, only for the hosts that survive ranking.
    const byHost = new Map<string, { c: Counters; src: TrafficMetricsMsg["domains"] }>();
    const newCounters = (): Counters => ({ requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, bot: 0, human: 0 });
    const addCounters = (c: Counters, d: TrafficMetricsMsg["domains"][number] | Counters) => {
      c.requests = Math.min(MAX_INT, c.requests + count(d.requests));
      c.s2xx = Math.min(MAX_INT, c.s2xx + count(d.s2xx));
      c.s3xx = Math.min(MAX_INT, c.s3xx + count(d.s3xx));
      c.s4xx = Math.min(MAX_INT, c.s4xx + count(d.s4xx));
      c.s5xx = Math.min(MAX_INT, c.s5xx + count(d.s5xx));
      c.bytes = Math.min(Number.MAX_SAFE_INTEGER, c.bytes + count(d.bytes, Number.MAX_SAFE_INTEGER));
      const split = "bot" in d ? d : d.bots; // already-merged Counters vs a wire stat ({ human, bot })
      c.bot = Math.min(MAX_INT, c.bot + count(split?.bot));
      c.human = Math.min(MAX_INT, c.human + count(split?.human));
    };
    for (const d of msg.domains.slice(0, MAX_RAW_DOMAINS)) {
      if (!d || typeof d !== "object") continue;
      const host = cleanHost(d.host);
      if (!host) continue;
      let e = byHost.get(host);
      if (!e) byHost.set(host, (e = { c: newCounters(), src: [] }));
      addCounters(e.c, d);
      e.src.push(d);
    }
    if (byHost.size === 0) return;

    // Rank by requests: matched hosts always survive; unmatched are capped, the rest fold into UNMATCHED_HOST.
    const hosts = await this.resolver.forServer(serverId);
    const appOf = (host: string) => this.resolver.resolve(hosts, host)?.appId ?? null;
    const matched: [string, string][] = []; // [host, appId]
    const unmatched: string[] = [];
    for (const host of byHost.keys()) {
      const appId = host === UNMATCHED_HOST ? null : appOf(host);
      if (appId) matched.push([host, appId]);
      else unmatched.push(host);
    }
    unmatched.sort((a, b) => byHost.get(b)!.c.requests - byHost.get(a)!.c.requests);
    const keptUnmatched = unmatched.filter((h) => h !== UNMATCHED_HOST).slice(0, MAX_UNMATCHED_HOSTS);
    const kept = new Set(keptUnmatched);
    const overflow = newCounters();
    let overflowAny = false;
    for (const h of unmatched) {
      if (kept.has(h)) continue;
      addCounters(overflow, byHost.get(h)!.c);
      overflowAny = true;
    }

    const plan: { host: string; appId: string | null; c: Counters; src: TrafficMetricsMsg["domains"]; maxPaths: number }[] = [
      ...matched.map(([host, appId]) => ({ host, appId: appId as string | null, c: byHost.get(host)!.c, src: byHost.get(host)!.src, maxPaths: MAX_PATHS })),
      ...keptUnmatched.map((host) => ({ host, appId: null, c: byHost.get(host)!.c, src: byHost.get(host)!.src, maxPaths: MAX_UNMATCHED_PATHS })),
    ];
    if (overflowAny) plan.push({ host: UNMATCHED_HOST, appId: null, c: overflow, src: [], maxPaths: 0 });
    plan.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)); // stable lock order across concurrent upserts

    const metricRows: Prisma.Sql[] = [];
    const pathRows: Prisma.Sql[] = [];
    const countryRows: Prisma.Sql[] = [];
    const breakdownRows: Prisma.Sql[] = [];
    const latencyRows: Prisma.Sql[] = [];
    const bucketLit = tsLiteral(bucket);
    for (const { host, appId, c, src, maxPaths } of plan) {
      metricRows.push(
        Prisma.sql`(${randomUUID()}, ${serverId}, ${host}, ${appId}, ${bucketLit}::timestamp, ${c.requests}::int, ${c.s2xx}::int, ${c.s3xx}::int, ${c.s4xx}::int, ${c.s5xx}::int, ${BigInt(c.bytes)}::bigint, ${c.bot}::int, ${c.human}::int)`,
      );
      if (maxPaths === 0) continue;
      const paths = new Map<string, PathAcc>();
      for (const d of src) {
        if (!Array.isArray(d.paths)) continue;
        for (const p of d.paths.slice(0, MAX_RAW_PATHS)) {
          if (!p || typeof p !== "object") continue;
          const path = cleanPath(p.p);
          if (!path) continue;
          const a = paths.get(path) ?? { n: 0, b: 0 };
          a.n = Math.min(MAX_INT, a.n + count(p.n));
          a.b = Math.min(Number.MAX_SAFE_INTEGER, a.b + count(p.b, Number.MAX_SAFE_INTEGER));
          paths.set(path, a);
        }
      }
      // Top-N by requests; the overflow (and any literal "(other)") folds into one OTHER_PATH row.
      const ranked = [...paths.entries()].filter(([p]) => p !== OTHER_PATH).sort((a, b) => b[1].n - a[1].n);
      const keep = ranked.slice(0, maxPaths);
      const other: PathAcc = { n: 0, b: 0 };
      for (const [, a] of ranked.slice(maxPaths)) {
        other.n += a.n;
        other.b += a.b;
      }
      const lit = paths.get(OTHER_PATH);
      if (lit) {
        other.n += lit.n;
        other.b += lit.b;
      }
      const rows: [string, PathAcc][] = [...keep];
      if (other.n > 0 || other.b > 0) rows.push([OTHER_PATH, { n: Math.min(MAX_INT, other.n), b: Math.min(Number.MAX_SAFE_INTEGER, other.b) }]);
      for (const [path, a] of rows) {
        pathRows.push(
          Prisma.sql`(${randomUUID()}, ${serverId}, ${host}, ${bucketLit}::timestamp, ${path}, ${a.n}::int, ${BigInt(a.b)}::bigint)`,
        );
      }

      // Countries: invalid codes -> "ZZ"; top-N by requests, the overflow (and any literal "ZZ") folds into one "ZZ" row.
      const countries = new Map<string, number>();
      for (const d of src) {
        if (!Array.isArray(d.countries)) continue;
        for (const e of d.countries.slice(0, MAX_RAW_COUNTRIES)) {
          if (!e || typeof e !== "object") continue;
          const cc = cleanCountry(e.c);
          countries.set(cc, Math.min(MAX_INT, (countries.get(cc) ?? 0) + count(e.n)));
        }
      }
      const rankedC = [...countries.entries()].filter(([cc]) => cc !== UNKNOWN_COUNTRY).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const maxCountries = maxPaths === MAX_PATHS ? MAX_COUNTRIES : MAX_UNMATCHED_COUNTRIES;
      const keepC = rankedC.slice(0, maxCountries);
      let unknown = countries.get(UNKNOWN_COUNTRY) ?? 0;
      for (const [, n] of rankedC.slice(maxCountries)) unknown += n;
      const cRows: [string, number][] = [...keepC];
      if (unknown > 0) cRows.push([UNKNOWN_COUNTRY, Math.min(MAX_INT, unknown)]);
      for (const [cc, n] of cRows) {
        if (n <= 0) continue;
        countryRows.push(Prisma.sql`(${randomUUID()}, ${serverId}, ${host}, ${bucketLit}::timestamp, ${cc}, ${n}::int)`);
      }

      // Visitor dimensions (browser/os/device/referrer/city/network): sanitized keys, top-N by requests, the
      // overflow (and any literal "(other)") folds into one "(other)" row. Rows are emitted in (dim, key) order.
      const maxKeys = maxPaths === MAX_PATHS ? MAX_BREAKDOWN : MAX_UNMATCHED_BREAKDOWN;
      for (const [field, dim] of BREAKDOWN_DIMS) {
        const keys = new Map<string, number>();
        for (const d of src) {
          const list = d[field];
          if (!Array.isArray(list)) continue;
          for (const e of list.slice(0, MAX_RAW_BREAKDOWN)) {
            if (!e || typeof e !== "object") continue;
            const k = cleanKey(e.k);
            keys.set(k, Math.min(MAX_INT, (keys.get(k) ?? 0) + count(e.n)));
          }
        }
        const rankedK = [...keys.entries()].filter(([k, n]) => k !== OTHER_KEY && n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        const keepK = rankedK.slice(0, maxKeys);
        let overflowN = keys.get(OTHER_KEY) ?? 0;
        for (const [, n] of rankedK.slice(maxKeys)) overflowN += n;
        const kRows: [string, number][] = [...keepK];
        if (overflowN > 0) kRows.push([OTHER_KEY, Math.min(MAX_INT, overflowN)]);
        kRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [k, n] of kRows) {
          breakdownRows.push(Prisma.sql`(${randomUUID()}, ${serverId}, ${host}, ${bucketLit}::timestamp, ${dim}, ${k}, ${n}::int)`);
        }
      }

      // Latency histogram: idx 0..13 into TRAFFIC_LATENCY_BUCKETS_MS (+overflow); entries past idx 13 are ignored,
      // histograms of duplicate hosts sum, one row per non-empty bin.
      const bins = new Array<number>(LATENCY_BINS).fill(0);
      for (const d of src) {
        if (!Array.isArray(d.latency)) continue;
        for (let i = 0; i < LATENCY_BINS && i < d.latency.length; i++) bins[i] = Math.min(MAX_INT, bins[i] + count(d.latency[i]));
      }
      for (let i = 0; i < LATENCY_BINS; i++) {
        if (bins[i] > 0) latencyRows.push(Prisma.sql`(${randomUUID()}, ${serverId}, ${host}, ${bucketLit}::timestamp, ${i}::int, ${bins[i]}::int)`);
      }
    }

    // One transaction for every chunk of all five tables: a failure leaves neither (no metric/path divergence).
    const ops: Prisma.PrismaPromise<number>[] = [];
    for (let i = 0; i < metricRows.length; i += ROW_CHUNK) {
      ops.push(this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "TrafficMetric" ("id", "serverId", "domain", "appId", "bucket", "requests", "s2xx", "s3xx", "s4xx", "s5xx", "bytes", "botRequests", "humanRequests")
        VALUES ${Prisma.join(metricRows.slice(i, i + ROW_CHUNK))}
        ON CONFLICT ("serverId", "domain", "bucket") DO UPDATE SET
          "requests" = "TrafficMetric"."requests" + EXCLUDED."requests",
          "s2xx" = "TrafficMetric"."s2xx" + EXCLUDED."s2xx",
          "s3xx" = "TrafficMetric"."s3xx" + EXCLUDED."s3xx",
          "s4xx" = "TrafficMetric"."s4xx" + EXCLUDED."s4xx",
          "s5xx" = "TrafficMetric"."s5xx" + EXCLUDED."s5xx",
          "bytes" = "TrafficMetric"."bytes" + EXCLUDED."bytes",
          "botRequests" = "TrafficMetric"."botRequests" + EXCLUDED."botRequests",
          "humanRequests" = "TrafficMetric"."humanRequests" + EXCLUDED."humanRequests",
          "appId" = COALESCE(EXCLUDED."appId", "TrafficMetric"."appId")`));
    }
    for (let i = 0; i < pathRows.length; i += ROW_CHUNK) {
      ops.push(this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "TrafficPath" ("id", "serverId", "domain", "bucket", "path", "requests", "bytes")
        VALUES ${Prisma.join(pathRows.slice(i, i + ROW_CHUNK))}
        ON CONFLICT ("serverId", "domain", "bucket", "path") DO UPDATE SET
          "requests" = "TrafficPath"."requests" + EXCLUDED."requests",
          "bytes" = "TrafficPath"."bytes" + EXCLUDED."bytes"`));
    }
    for (let i = 0; i < countryRows.length; i += ROW_CHUNK) {
      ops.push(this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "TrafficCountry" ("id", "serverId", "domain", "bucket", "country", "requests")
        VALUES ${Prisma.join(countryRows.slice(i, i + ROW_CHUNK))}
        ON CONFLICT ("serverId", "domain", "bucket", "country") DO UPDATE SET
          "requests" = "TrafficCountry"."requests" + EXCLUDED."requests"`));
    }
    for (let i = 0; i < breakdownRows.length; i += ROW_CHUNK) {
      ops.push(this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "TrafficBreakdown" ("id", "serverId", "domain", "bucket", "dim", "key", "requests")
        VALUES ${Prisma.join(breakdownRows.slice(i, i + ROW_CHUNK))}
        ON CONFLICT ("serverId", "domain", "bucket", "dim", "key") DO UPDATE SET
          "requests" = "TrafficBreakdown"."requests" + EXCLUDED."requests"`));
    }
    for (let i = 0; i < latencyRows.length; i += ROW_CHUNK) {
      ops.push(this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "TrafficLatency" ("id", "serverId", "domain", "bucket", "idx", "requests")
        VALUES ${Prisma.join(latencyRows.slice(i, i + ROW_CHUNK))}
        ON CONFLICT ("serverId", "domain", "bucket", "idx") DO UPDATE SET
          "requests" = "TrafficLatency"."requests" + EXCLUDED."requests"`));
    }
    await this.prisma.$transaction(ops);
  }
}
