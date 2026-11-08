import type { FleetTrendRow } from "./types";
import type { FleetRow, FleetSortKey } from "./fleet-view";

/** What every wall card plots. Only cpu + mem have a per-server trend today (the batch /fleet/metrics/trend
 *  rows carry cpu + mem points); disk + net render as live-value tiles until #M2b adds their series. */
export type WallMetric = "cpu" | "mem" | "disk" | "net";
export type FleetView = "table" | "wall" | "heatmap";
/** The wall's own order: hottest-first by the plotted metric, or by name / status (separate from the table sort). */
export type WallSort = "hot" | "name" | "status";

export const WALL_METRICS: readonly WallMetric[] = ["cpu", "mem", "disk", "net"];
export const FLEET_VIEWS: readonly FleetView[] = ["table", "wall", "heatmap"];

export const VIEW_KEY = "tugra.fleetview";
export const METRIC_KEY = "tugra.fleetwallmetric";

/** The fleet-table sort key that orders servers by a given wall metric ("hottest first"). */
export const METRIC_SORT_KEY: Record<WallMetric, FleetSortKey> = { cpu: "cpu", mem: "mem", disk: "disk", net: "net" };

/** Read a persisted choice, falling back when storage is unavailable or holds an unknown value. */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** The live value a wall card shows for a metric (% for cpu/mem/disk, bytes/s for net). */
export function wallValue(row: FleetRow, metric: WallMetric): number | null {
  return metric === "cpu" ? row.cpu : metric === "mem" ? row.memPct : metric === "disk" ? row.diskPct : row.net;
}

export interface WallSeries {
  values: number[];
  times: number[];
}

/** One server's plotted series for a metric, from the ALREADY-FETCHED batch trend row (no extra request).
 *  Non-finite points are dropped, points are time-ordered, and fewer than 2 points (a line can't be drawn)
 *  or a metric with no trend (disk/net) → null, which the card renders as a placeholder. */
export function wallSeries(row: FleetTrendRow | undefined, metric: WallMetric): WallSeries | null {
  if (metric !== "cpu" && metric !== "mem") return null;
  const pts = Array.isArray(row?.points) ? row!.points : [];
  const kept: { ts: number; v: number }[] = [];
  for (const p of pts) {
    const v = metric === "cpu" ? p?.cpu : p?.mem;
    if (typeof p?.ts === "number" && Number.isFinite(p.ts) && typeof v === "number" && Number.isFinite(v)) kept.push({ ts: p.ts, v });
  }
  if (kept.length < 2) return null;
  for (let i = 1; i < kept.length; i++) {
    if (kept[i].ts < kept[i - 1].ts) {
      kept.sort((a, b) => a.ts - b.ts);
      break;
    }
  }
  return { values: kept.map((k) => k.v), times: kept.map((k) => k.ts) };
}
