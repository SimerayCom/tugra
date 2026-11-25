/**
 * Pure mapping from Beszel's PocketBase records to Tugra's model. Collection/field names were read from Beszel's
 * (MIT) source: `systems` (name, host, port, status), `alerts` (system, name, value, min), `user_settings`
 * (settings.emails / settings.webhooks) and `system_stats` (system, type, stats, created). Nothing here does IO.
 */
import type { MetricKind } from "../monitors/checkers";

// ── records as the API returns them (only the fields we read) ─────────────────────────────────────────────────────
export interface BeszelSystem {
  id: string;
  name: string;
  host: string;
  status: string;
}
export interface BeszelAlert {
  id: string;
  system: string;
  name: string;
  value: number;
  min: number;
}
export interface BeszelStatsRecord {
  created: string;
  type: string;
  stats: Record<string, unknown>;
}

// ── systems → Tugra servers ───────────────────────────────────────────────────────────────────────────────────────
export interface TugraServerLite {
  id: string;
  name: string;
  hostname: string | null;
  publicIp: string | null;
  publicIpv6: string | null;
  reportedIps: string[];
}
export type MatchBy = "ip" | "hostname" | "name";
export type SystemMatch = { serverId: string; serverName: string; by: MatchBy } | { serverId: null; reason: "none" | "ambiguous" | "duplicate" | "socket" };

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");

/**
 * Match each Beszel system to at most one Tugra server: by the host address (public/reported IP), then by the host
 * written as a name, then by the system's display name. A system that matches several servers at one level is
 * "ambiguous" and left for the operator; one Tugra server is never claimed by two systems (the first keeps it, the next
 * one is a "duplicate").
 */
export function matchSystems(systems: BeszelSystem[], servers: TugraServerLite[]): Map<string, SystemMatch> {
  const out = new Map<string, SystemMatch>();
  const claimed = new Set<string>();
  const byIp = (h: string) => servers.filter((s) => [s.publicIp, s.publicIpv6, ...s.reportedIps].some((ip) => norm(ip) === h));
  const byHost = (h: string) => servers.filter((s) => norm(s.hostname) === h || norm(s.name) === h);
  for (const sys of systems) {
    const host = norm(sys.host);
    if (host.startsWith("/")) {
      out.set(sys.id, { serverId: null, reason: "socket" }); // a unix socket path: the hub's own box, nothing to match by address
      continue;
    }
    const levels: Array<[MatchBy, TugraServerLite[]]> = [
      ["ip", host ? byIp(host) : []],
      ["hostname", host ? byHost(host) : []],
      ["name", norm(sys.name) ? byHost(norm(sys.name)) : []],
    ];
    let result: SystemMatch = { serverId: null, reason: "none" };
    for (const [by, hits] of levels) {
      if (hits.length === 0) continue;
      if (hits.length > 1) result = { serverId: null, reason: "ambiguous" };
      else if (claimed.has(hits[0].id)) result = { serverId: null, reason: "duplicate" };
      else result = { serverId: hits[0].id, serverName: hits[0].name, by };
      break;
    }
    if (result.serverId) claimed.add(result.serverId);
    out.set(sys.id, result);
  }
  return out;
}

// ── alerts → metric monitors ──────────────────────────────────────────────────────────────────────────────────────
export type AlertSkipReason = "battery" | "gpu" | "cpuState" | "container" | "systemd" | "network" | "smart" | "other";
export type MappedAlert =
  | { kind: "monitor"; metric: MetricKind; thresholdPct?: number; thresholdValue?: number; intervalSec: number; retries: number; minutes: number }
  | { kind: "status"; minutes: number }
  | { kind: "skip"; reason: AlertSkipReason };

const METRIC_BY_NAME: Record<string, MetricKind> = {
  CPU: "CPU",
  Memory: "MEM",
  Disk: "DISK",
  Temperature: "TEMP",
  Bandwidth: "NET",
  LoadAvg1: "LOAD1",
  LoadAvg5: "LOAD5",
  LoadAvg15: "LOAD15",
};

/**
 * One Beszel alert → how Tugra carries it. Beszel fires when the value averaged over `min` minutes crosses `value`; a
 * Tugra metric monitor checks every 60 s and goes down after `min` consecutive checks at or above the limit, which is the
 * closest equivalent (the same wait, judged per minute rather than on the average).
 */
export function mapAlert(a: Pick<BeszelAlert, "name" | "value" | "min">): MappedAlert {
  const minutes = Math.min(60, Math.max(1, Math.round(Number(a.min) || 1)));
  if (a.name === "Status") return { kind: "status", minutes };
  const metric = METRIC_BY_NAME[a.name];
  if (!metric) {
    if (a.name === "Battery") return { kind: "skip", reason: "battery" };
    if (a.name === "GPU") return { kind: "skip", reason: "gpu" };
    if (a.name === "CPUIOWait" || a.name === "CPUSteal") return { kind: "skip", reason: "cpuState" };
    if (/container/i.test(a.name)) return { kind: "skip", reason: "container" };
    if (/systemd/i.test(a.name)) return { kind: "skip", reason: "systemd" };
    if (/network|cert/i.test(a.name)) return { kind: "skip", reason: "network" };
    if (/smart|zfs/i.test(a.name)) return { kind: "skip", reason: "smart" };
    return { kind: "skip", reason: "other" };
  }
  const value = Number(a.value);
  if (!Number.isFinite(value) || value <= 0) return { kind: "skip", reason: "other" };
  const common = { kind: "monitor" as const, metric, intervalSec: 60, retries: minutes - 1, minutes };
  if (metric === "CPU" || metric === "MEM" || metric === "DISK") {
    return { ...common, thresholdPct: Math.min(100, Math.max(1, Math.round(value))) };
  }
  return { ...common, thresholdValue: Math.round(value * 100) / 100 };
}

/** The unit label the web shows next to a limit. */
export function metricUnit(metric: MetricKind): "%" | "°C" | "MB/s" | "" {
  if (metric === "CPU" || metric === "MEM" || metric === "DISK") return "%";
  if (metric === "TEMP") return "°C";
  if (metric === "NET") return "MB/s";
  return "";
}

// ── history: system_stats → MetricRollup ──────────────────────────────────────────────────────────────────────────
export const STATS_TYPES = ["1m", "10m", "20m", "120m", "480m"] as const;
export type StatsType = (typeof STATS_TYPES)[number];
/** How far back Beszel keeps each resolution (its own retention); together they tile the last 30 days with no overlap. */
const WINDOW_MS: Record<StatsType, [from: number, to: number]> = {
  "1m": [3_600_000, 0],
  "10m": [12 * 3_600_000, 3_600_000],
  "20m": [24 * 3_600_000, 12 * 3_600_000],
  "120m": [7 * 86_400_000, 24 * 3_600_000],
  "480m": [30 * 86_400_000, 7 * 86_400_000],
};
/** Age range [from, to) in ms before `now` that resolution `type` is trusted for (finest wins where they overlap). */
export function statsWindow(type: StatsType, now: number): { start: number; end: number } {
  const [a, b] = WINDOW_MS[type];
  return { start: now - a, end: now - b };
}

export interface RollupRow {
  bucket: Date;
  avgCpu: number;
  maxCpu: number;
  avgMemUsed: bigint;
  avgMemTotal: bigint;
  avgDiskUsed: bigint;
  avgDiskTotal: bigint;
  avgNetRx: bigint;
  avgNetTx: bigint;
  avgDiskRead: bigint;
  avgDiskWrite: bigint;
  avgLoad1: number | null;
  avgLoad5: number | null;
  avgLoad15: number | null;
  avgSwapUsed: bigint | null;
  avgSwapTotal: bigint | null;
}

/** Fold minute rollup rows into 5-minute buckets (the long-range tier): mean of the means, max of the maxes; the
 *  optional columns average over only the rows that carry them (null when none do). */
export function toFiveMinute(rows: RollupRow[]): RollupRow[] {
  const FIVE = 300_000;
  const groups = new Map<number, RollupRow[]>();
  for (const r of rows) {
    const k = Math.floor(r.bucket.getTime() / FIVE) * FIVE;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanBig = (xs: bigint[]): bigint => BigInt(Math.round(mean(xs.map(Number))));
  const opt = (xs: Array<number | null>): number | null => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? mean(v) : null;
  };
  const optBig = (xs: Array<bigint | null>): bigint | null => {
    const v = xs.filter((x): x is bigint => x != null);
    return v.length ? meanBig(v) : null;
  };
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, g]) => ({
      bucket: new Date(k),
      avgCpu: mean(g.map((r) => r.avgCpu)),
      maxCpu: Math.max(...g.map((r) => r.maxCpu)),
      avgMemUsed: meanBig(g.map((r) => r.avgMemUsed)),
      avgMemTotal: meanBig(g.map((r) => r.avgMemTotal)),
      avgDiskUsed: meanBig(g.map((r) => r.avgDiskUsed)),
      avgDiskTotal: meanBig(g.map((r) => r.avgDiskTotal)),
      avgNetRx: meanBig(g.map((r) => r.avgNetRx)),
      avgNetTx: meanBig(g.map((r) => r.avgNetTx)),
      avgDiskRead: meanBig(g.map((r) => r.avgDiskRead)),
      avgDiskWrite: meanBig(g.map((r) => r.avgDiskWrite)),
      avgLoad1: opt(g.map((r) => r.avgLoad1)),
      avgLoad5: opt(g.map((r) => r.avgLoad5)),
      avgLoad15: opt(g.map((r) => r.avgLoad15)),
      avgSwapUsed: optBig(g.map((r) => r.avgSwapUsed)),
      avgSwapTotal: optBig(g.map((r) => r.avgSwapTotal)),
    }));
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length >= 2 && n(v[0]) != null && n(v[1]) != null ? [v[0] as number, v[1] as number] : null);
const big = (v: number): bigint => BigInt(Math.max(0, Math.round(v)));

/** PocketBase writes "2026-01-02 03:04:05.678Z"; the space is not ISO. */
export function parsePbDate(s: string): Date | null {
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One `system_stats.stats` object → a rollup row. Newer Beszel writes byte arrays (`mem`, `swap`, `b`, `dio`); older
 * releases wrote GiB / MB/s numbers (`m`/`mu`, `d`/`du`, `ns`/`nr`, `dr`/`dw`, `s`/`su`) — both are read, bytes first.
 * Temperature has no rollup column and is not imported.
 */
export function statsToRollup(created: string, stats: Record<string, unknown>): RollupRow | null {
  const at = parsePbDate(created);
  const cpu = n(stats.cpu);
  if (!at || cpu == null) return null;
  const bucket = new Date(Math.floor(at.getTime() / 60_000) * 60_000);

  const memB = Array.isArray(stats.mem) ? (stats.mem as unknown[]).map(n) : [];
  const memTotal = memB[0] != null ? memB[0] : n(stats.m) != null ? (n(stats.m) as number) * GIB : 0;
  const memUsed = memB[1] != null ? memB[1] : n(stats.mu) != null ? (n(stats.mu) as number) * GIB : 0;
  const diskTotal = (n(stats.d) ?? 0) * GIB;
  const diskUsed = (n(stats.du) ?? 0) * GIB;
  const bw = pair(stats.b);
  const netTx = bw ? bw[0] : (n(stats.ns) ?? 0) * MIB;
  const netRx = bw ? bw[1] : (n(stats.nr) ?? 0) * MIB;
  const dio = pair(stats.dio);
  const diskRead = dio ? dio[0] : (n(stats.dr) ?? 0) * MIB;
  const diskWrite = dio ? dio[1] : (n(stats.dw) ?? 0) * MIB;
  const la = Array.isArray(stats.la) ? (stats.la as unknown[]).map(n) : [];
  const swapB = pair(stats.swap);
  const swapTotal = swapB ? swapB[0] : n(stats.s) != null ? (n(stats.s) as number) * GIB : null;
  const swapUsed = swapB ? swapB[1] : n(stats.su) != null ? (n(stats.su) as number) * GIB : null;

  return {
    bucket,
    avgCpu: cpu,
    maxCpu: n(stats.cpum) ?? cpu,
    avgMemUsed: big(memUsed),
    avgMemTotal: big(memTotal),
    avgDiskUsed: big(diskUsed),
    avgDiskTotal: big(diskTotal),
    avgNetRx: big(netRx),
    avgNetTx: big(netTx),
    avgDiskRead: big(diskRead),
    avgDiskWrite: big(diskWrite),
    avgLoad1: la[0] ?? null,
    avgLoad5: la[1] ?? null,
    avgLoad15: la[2] ?? null,
    avgSwapUsed: swapUsed != null ? big(swapUsed) : null,
    avgSwapTotal: swapTotal != null ? big(swapTotal) : null,
  };
}

/**
 * Turn the fetched stats records into rollup rows: each resolution only inside its own window (no double counting),
 * only before `before` (never over data Tugra already holds), and only newer than `floor` (the rollup retention).
 * One row per minute bucket; the finest resolution wins a clash.
 */
export function buildHistory(records: BeszelStatsRecord[], opts: { now: number; before: number; floor: number }): RollupRow[] {
  const order = new Map(STATS_TYPES.map((t, i) => [t as string, i]));
  const rows = new Map<number, { row: RollupRow; rank: number }>();
  for (const rec of records) {
    const rank = order.get(rec.type);
    if (rank == null) continue;
    const row = statsToRollup(rec.created, rec.stats ?? {});
    if (!row) continue;
    const t = row.bucket.getTime();
    const w = statsWindow(rec.type as StatsType, opts.now);
    if (t < w.start || t >= w.end || t < opts.floor || t >= opts.before) continue;
    const prev = rows.get(t);
    if (!prev || rank < prev.rank) rows.set(t, { row, rank });
  }
  return [...rows.values()].map((r) => r.row).sort((a, b) => a.bucket.getTime() - b.bucket.getTime());
}
