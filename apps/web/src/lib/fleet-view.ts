import type { FleetLatestRow, MetricsSample, ServerView } from "./types";
import { pct } from "./fleet";

/** A server joined with its newest metrics sample + the values the fleet table sorts/colors on. */
export interface FleetRow {
  server: ServerView;
  sample: MetricsSample | null;
  cpu: number | null; // %
  memPct: number | null; // %
  diskPct: number | null; // %
  net: number | null; // rx+tx bytes/s
  stale: boolean; // the sample is older than the live window → values render greyed, not trusted
}

/** A row is stale (its numbers are no longer live) if its latest sample is older than this window. */
export const FLEET_STALE_MS = 60_000;

/** A finite number or null — guards against a malformed sample (missing field, NaN, string) reaching
 *  the UI, where `.toFixed()` on undefined would crash the whole page and NaN would render as "NaN%". */
const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/**
 * Join the server list with the one-call latest-metrics response (keyed by serverId) into table rows.
 * A server with no sample keeps null metrics (the UI shows "—"); a server whose latest SAMPLE is older
 * than the stale window is flagged `stale` so its figures render greyed instead of looking live. Every
 * numeric field is finite-guarded so one bad sample degrades to "—" rather than crashing the page.
 */
export function buildFleetRows(
  servers: ServerView[],
  metrics: FleetLatestRow[],
  nowMs: number,
  staleMs = FLEET_STALE_MS,
): FleetRow[] {
  const list = Array.isArray(metrics) ? metrics : [];
  const byServer = new Map(list.map((m) => [m.serverId, m.sample]));
  return servers.map((server) => {
    const sample = byServer.get(server.id) ?? null;
    const memUsed = fin(sample?.memUsed);
    const memTotal = fin(sample?.memTotal);
    const diskUsed = fin(sample?.diskUsed);
    const diskTotal = fin(sample?.diskTotal);
    const netRx = fin(sample?.netRx);
    const netTx = fin(sample?.netTx);
    const ts = fin(sample?.ts);
    return {
      server,
      sample,
      cpu: fin(sample?.cpu),
      memPct: memUsed !== null && memTotal !== null && memTotal > 0 ? pct(memUsed, memTotal) : null,
      diskPct: diskUsed !== null && diskTotal !== null && diskTotal > 0 ? pct(diskUsed, diskTotal) : null,
      net: netRx !== null && netTx !== null ? netRx + netTx : null,
      // No sample at all → "—" cells (not "stale"); a sample with an old/invalid ts → stale.
      stale: sample ? ts === null || nowMs - ts > staleMs : false,
    };
  });
}

export type FleetSortKey = "name" | "status" | "cpu" | "mem" | "disk" | "net" | "uptime";
export type SortDir = "asc" | "desc";

const collator = new Intl.Collator();

const NUMERIC: Record<string, (r: FleetRow) => number | null> = {
  cpu: (r) => r.cpu,
  mem: (r) => r.memPct,
  disk: (r) => r.diskPct,
  net: (r) => r.net,
  uptime: (r) => fin(r.server.uptimeSeconds),
};

/** Deterministic tiebreaker (name, then id) so equal-value rows keep a stable order across polls. */
const tie = (a: FleetRow, b: FleetRow) =>
  collator.compare(a.server.name ?? "", b.server.name ?? "") || collator.compare(a.server.id, b.server.id);

/** Sort rows by a column. Numeric columns always sink null/no-sample rows to the BOTTOM, both
 *  directions, so "no data" never masquerades as the best or worst value. Stable (returns a copy). */
export function sortFleetRows(rows: FleetRow[], key: FleetSortKey, dir: SortDir): FleetRow[] {
  const copy = [...rows];
  if (key === "name" || key === "status") {
    const field = (r: FleetRow) => (key === "name" ? r.server.name : r.server.status) ?? "";
    copy.sort((a, b) => {
      const c = collator.compare(field(a), field(b)) || tie(a, b);
      return dir === "asc" ? c : -c;
    });
    return copy;
  }
  const val = NUMERIC[key];
  const safe = (r: FleetRow) => {
    const v = val(r);
    return v !== null && Number.isFinite(v) ? v : null; // non-finite sinks like null
  };
  copy.sort((a, b) => {
    const x = safe(a);
    const y = safe(b);
    if (x === null && y === null) return tie(a, b);
    if (x === null) return 1; // nulls last, regardless of direction
    if (y === null) return -1;
    if (x === y) return tie(a, b);
    return dir === "asc" ? x - y : y - x;
  });
  return copy;
}

/** Case-insensitive match over a server's name, hostname and public IPs — the fleet search box. */
export function matchesFleetSearch(row: FleetRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { name, hostname, publicIp, publicIpv6 } = row.server;
  return [name, hostname, publicIp, publicIpv6].some((v) => !!v && v.toLowerCase().includes(q));
}

export type MetricTone = "ok" | "warn" | "crit";

/** Threshold colour for a usage %: amber at 80, red at 90 — matching the per-container card. */
export function metricTone(value: number | null): MetricTone {
  if (value === null) return "ok";
  if (value >= 90) return "crit";
  if (value >= 80) return "warn";
  return "ok";
}
