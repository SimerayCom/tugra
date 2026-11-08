import type { FleetTrendRow } from "./types";
import type { FleetRow } from "./fleet-view";
import type { WallMetric } from "./fleet-wall";

/** Trend points are per-minute, so one heatmap column = one minute. */
export const HEAT_BUCKET_MS = 60_000;
/** Hard cap on columns (the trend window is ~30 min; this only guards a surprisingly wide payload). */
export const HEAT_MAX_COLS = 60;
/** Number of discrete steps on the sequential ramp (CSS tokens --heat-0 … --heat-8 in globals.css). */
export const HEAT_STEPS = 9;
/** Rows drawn per page of the heatmap (a "showing N of M" note + button reveals the rest — never a silent cut). */
export const HEAT_PAGE = 50;

/** Only cpu + mem carry a per-server trend today; disk/net have no history → no heatmap. */
export const heatHasTrend = (metric: WallMetric): boolean => metric === "cpu" || metric === "mem";

/** Map a 0-100 percent onto a ramp step. FIXED domain (not min/max-scaled) so colours are comparable across
 *  servers, metrics and refreshes. Out-of-range values clamp. */
export function heatStep(v: number): number {
  const clamped = Math.min(Math.max(v, 0), 100);
  return Math.min(HEAT_STEPS - 1, Math.floor((clamped / 100) * HEAT_STEPS));
}

export interface HeatRow {
  row: FleetRow;
  /** One entry per column: the metric value in that minute, or null when the server reported nothing then. */
  cells: (number | null)[];
  latest: number | null;
  peak: number | null;
}

export interface Heatmap {
  /** Column start timestamps (ms, minute-aligned, ascending). */
  times: number[];
  rows: HeatRow[];
}

/** Server x minute matrix for a metric, built purely from the ALREADY-FETCHED batch trend (no per-server
 *  requests). Row order is preserved from `rows` (the page's sort). The time axis spans the newest ~30 minutes
 *  any server reported; a server with no point in a minute gets a null (empty) cell, never a 0. */
export function buildHeatmap(
  rows: FleetRow[],
  trends: Map<string, FleetTrendRow> | undefined,
  metric: WallMetric,
  maxCols = HEAT_MAX_COLS,
): Heatmap {
  if (!heatHasTrend(metric)) return { times: [], rows: rows.map((row) => ({ row, cells: [], latest: null, peak: null })) };
  const per: Map<number, number>[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of rows) {
    const m = new Map<number, number>();
    const pts = trends?.get(row.server.id)?.points;
    if (Array.isArray(pts)) {
      for (const p of pts) {
        const v = metric === "cpu" ? p?.cpu : p?.mem;
        if (typeof p?.ts !== "number" || !Number.isFinite(p.ts) || typeof v !== "number" || !Number.isFinite(v)) continue;
        const b = Math.floor(p.ts / HEAT_BUCKET_MS) * HEAT_BUCKET_MS;
        m.set(b, v); // later point in the same minute wins
        if (b < lo) lo = b;
        if (b > hi) hi = b;
      }
    }
    per.push(m);
  }
  if (!Number.isFinite(lo)) return { times: [], rows: rows.map((row) => ({ row, cells: [], latest: null, peak: null })) };
  lo = Math.max(lo, hi - (maxCols - 1) * HEAT_BUCKET_MS);
  const n = Math.round((hi - lo) / HEAT_BUCKET_MS) + 1;
  const times = Array.from({ length: n }, (_, i) => lo + i * HEAT_BUCKET_MS);
  return {
    times,
    rows: rows.map((row, ri) => {
      const cells = times.map((ts) => per[ri].get(ts) ?? null);
      let latest: number | null = null;
      let peak: number | null = null;
      for (const v of cells) {
        if (v === null) continue;
        latest = v;
        if (peak === null || v > peak) peak = v;
      }
      return { row, cells, latest, peak };
    }),
  };
}
