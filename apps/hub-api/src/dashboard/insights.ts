/** Pure helpers behind the dashboard insight cards (disk forecast, backup / deploy digests). No I/O. */

export interface DiskPoint {
  ts: number; // unix ms
  used: number; // bytes
}

export interface DiskForecast {
  /** Fitted growth in bytes per day (may be <= 0 when the disk is stable or shrinking). */
  growthBytesPerDay: number;
  /** Whole-ish days until the disk is full at the fitted rate; null = not filling up / not enough signal. */
  daysToFull: number | null;
}

const DAY_MS = 86_400_000;
export const FORECAST_MIN_POINTS = 12; // hourly buckets
export const FORECAST_MIN_SPAN_MS = 12 * 3600_000;
/** A trend weaker than this (coefficient of determination) is noise (cleanup cycles, log rotation), not a forecast. */
export const FORECAST_MIN_R2 = 0.3;
/** Beyond a year the number says nothing useful. */
export const FORECAST_MAX_DAYS = 365;

/**
 * Least-squares line through the (time, used-bytes) points, projected to `total`. Returns null when there is too
 * little history to say anything (few points / short span / unknown capacity). `daysToFull` is null when the
 * trend is flat or falling, when it fits the data poorly, or when it is further out than a year; it is 0 when the
 * disk is already full.
 */
export function forecastDisk(points: DiskPoint[], total: number): DiskForecast | null {
  const pts = points.filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.used)).sort((a, b) => a.ts - b.ts);
  if (!(total > 0) || pts.length < FORECAST_MIN_POINTS) return null;
  const t0 = pts[0].ts;
  if (pts[pts.length - 1].ts - t0 < FORECAST_MIN_SPAN_MS) return null;
  const n = pts.length;
  const xs = pts.map((p) => (p.ts - t0) / DAY_MS);
  const ys = pts.map((p) => p.used);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx; // bytes per day
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  const last = pts[pts.length - 1].used;
  if (last >= total) return { growthBytesPerDay: slope, daysToFull: 0 };
  if (slope <= 0 || r2 < FORECAST_MIN_R2) return { growthBytesPerDay: slope, daysToFull: null };
  const days = (total - last) / slope;
  return { growthBytesPerDay: slope, daysToFull: days > FORECAST_MAX_DAYS ? null : Math.max(0, Math.round(days * 10) / 10) };
}

export interface BackupDigestRow {
  id: string;
  kind: "database" | "volume";
  resourceId: string;
  resourceName: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  createdAt: string;
  sizeBytes: number | null;
}

/** Failed first (newest first), then the rest newest first; capped. */
export function rankBackups(rows: BackupDigestRow[], limit: number): BackupDigestRow[] {
  const byNewest = (a: BackupDigestRow, b: BackupDigestRow) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const failed = rows.filter((r) => r.status === "FAILED").sort(byNewest);
  const rest = rows.filter((r) => r.status !== "FAILED").sort(byNewest);
  return [...failed, ...rest].slice(0, Math.max(0, limit));
}
