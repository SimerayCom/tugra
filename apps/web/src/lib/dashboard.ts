import type { ServerView, Monitor, DomainView, FleetTrendRow } from "./types";
import type { FleetRow } from "./fleet-view";

export interface AttentionItem {
  kind: "server" | "monitor" | "domain";
  id: string;
  name: string;
  status: string;
}

/** Fleet items that need attention now: offline servers, down monitors, bad SSL certs. */
export function fleetAttention(
  servers: ServerView[],
  monitors: Monitor[],
  domains: DomainView[] = [],
): AttentionItem[] {
  const offline = servers
    .filter((s) => s.status === "OFFLINE")
    .map((s) => ({ kind: "server" as const, id: s.id, name: s.name, status: s.status }));
  const down = monitors
    .filter((m) => m.status === "DOWN")
    .map((m) => ({ kind: "monitor" as const, id: m.id, name: m.name, status: m.status }));
  const certs = domains
    .filter((d) => d.ssl.state !== "ok")
    // link to the owning app (id = appId)
    .map((d) => ({ kind: "domain" as const, id: d.appId, name: d.domain, status: d.ssl.state }));
  return [...offline, ...down, ...certs];
}

// ── Fleet cockpit helpers (web-only: derived from /fleet/metrics/latest + /fleet/metrics/trend) ────────────

/** Disk usage % at/above which a server counts as under disk pressure (matches `metricTone`'s amber line). */
export const DISK_PRESSURE_PCT = 80;

/** Number of busiest servers the dashboard lists. */
export const BUSIEST_COUNT = 5;

export interface FleetAggregateTrend {
  times: number[];
  cpu: number[];
  mem: number[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Collapse the per-server per-minute trend into ONE fleet series: for each minute, the mean over the servers
 * that reported in that minute. `serverIds` limits the aggregate (team scope); omit for all rows. A minute with
 * no finite mem keeps a NaN hole in `mem` (the chart breaks the line there) rather than a fake 0.
 */
export function aggregateFleetTrend(rows: FleetTrendRow[] | undefined, serverIds?: ReadonlySet<string>): FleetAggregateTrend {
  const buckets = new Map<number, { cpu: number[]; mem: number[] }>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || (serverIds && !serverIds.has(r.serverId))) continue;
    for (const p of Array.isArray(r.points) ? r.points : []) {
      if (!p || !finite(p.ts) || !finite(p.cpu)) continue;
      const b = buckets.get(p.ts) ?? { cpu: [], mem: [] };
      b.cpu.push(p.cpu);
      if (finite(p.mem)) b.mem.push(p.mem);
      buckets.set(p.ts, b);
    }
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);
  return {
    times,
    cpu: times.map((ts) => avg(buckets.get(ts)!.cpu)),
    mem: times.map((ts) => {
      const m = buckets.get(ts)!.mem;
      return m.length ? avg(m) : NaN;
    }),
  };
}

/** Finite-only view of a series (for a Sparkline, which can't draw NaN holes). */
export const finiteOnly = (xs: number[]): number[] => xs.filter(finite);

export type DeltaDir = "up" | "down" | "flat";

/** Change across the aggregate trend series itself (last point minus first), in percentage points, so the
 *  delta shares one server population with the sparkline. `null` with fewer than 2 finite points. Within
 *  +/-1 point reads as flat so a quiet fleet doesn't flicker arrows. */
export function trendDelta(series: number[]): { delta: number; dir: DeltaDir } | null {
  const clean = finiteOnly(series);
  if (clean.length < 2) return null;
  const delta = clean[clean.length - 1] - clean[0];
  return { delta, dir: Math.abs(delta) < 1 ? "flat" : delta > 0 ? "up" : "down" };
}

/** Rows whose numbers are live: server ONLINE, a sample exists and it isn't stale. */
export const liveRows = (rows: FleetRow[]): FleetRow[] => rows.filter((r) => r.server.status === "ONLINE" && r.sample && !r.stale);

export interface FleetSnapshot {
  cpu: number | null; // mean CPU % over live servers
  mem: number | null; // mean RAM %
  diskKnown: boolean; // at least one live server reported disk usage
  diskPressure: number; // live servers with disk >= DISK_PRESSURE_PCT
}

/** Current fleet-wide figures from the latest-sample rows (live servers only). Null/false = no data → hide the tile. */
export function fleetSnapshot(rows: FleetRow[]): FleetSnapshot {
  const live = liveRows(rows);
  const mean = (pick: (r: FleetRow) => number | null): number | null => {
    const v = live.map(pick).filter(finite);
    return v.length ? avg(v) : null;
  };
  const disks = live.map((r) => r.diskPct).filter(finite);
  return {
    cpu: mean((r) => r.cpu),
    mem: mean((r) => r.memPct),
    diskKnown: disks.length > 0,
    diskPressure: disks.filter((d) => d >= DISK_PRESSURE_PCT).length,
  };
}

/** Top-N live servers by latest CPU %, busiest first (ties keep list order). */
export function busiestServers(rows: FleetRow[], n = BUSIEST_COUNT): FleetRow[] {
  return liveRows(rows)
    .map((r, i) => ({ r, i }))
    .filter((x) => finite(x.r.cpu))
    .sort((a, b) => (b.r.cpu as number) - (a.r.cpu as number) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.r);
}
