/**
 * Metric retention tiers, one source of truth for the writers (rollup + prune) and every chart / analytics reader:
 *
 *   raw samples      host: METRICS_RAW_RETENTION_HOURS (26 h)          container: METRICS_CONTAINER_RAW_RETENTION_HOURS (6 h)
 *   1-minute rollup  both: METRICS_ROLLUP_1M_RETENTION_HOURS (48 h)    -> MetricRollup / ContainerMetricRollup
 *   5-minute rollup  both: METRICS_ROLLUP_RETENTION_DAYS (28 d)        -> MetricRollup5m / ContainerMetricRollup5m
 *
 * The 5-minute tier is rolled from the 1-minute tier continuously, so it covers the WHOLE window (including the last
 * 48 h); readers therefore pick exactly one table per query and never have to stitch tiers together.
 */
export const DEFAULT_HOST_RAW_HOURS = 26; // a 24 h host chart keeps full raw fidelity (sensors, per-GPU detail) + prune slack
export const DEFAULT_CONTAINER_RAW_HOURS = 6; // what the live container charts need (1h / 6h); longer ranges read rollups
export const DEFAULT_ROLLUP_1M_HOURS = 48;
export const DEFAULT_ROLLUP_5M_DAYS = 28;

export const HOUR_MS = 3600_000;
export const DAY_MS = 86_400_000;

export type MetricKind = "host" | "container";
export type MetricTier = "raw" | "1m" | "5m";

export interface MetricTiers {
  hostRawMs: number;
  containerRawMs: number;
  rollup1mMs: number;
  rollup5mMs: number;
}

function positive(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The effective tiers from an env-shaped bag (process.env by default; tests / the retention runner pass their own). */
export function metricTiers(env: Record<string, unknown> = process.env): MetricTiers {
  const hostRaw = positive(env.METRICS_RAW_RETENTION_HOURS, DEFAULT_HOST_RAW_HOURS);
  const contRaw = positive(env.METRICS_CONTAINER_RAW_RETENTION_HOURS, DEFAULT_CONTAINER_RAW_HOURS);
  const r1m = positive(env.METRICS_ROLLUP_1M_RETENTION_HOURS, DEFAULT_ROLLUP_1M_HOURS);
  const r5m = positive(env.METRICS_ROLLUP_RETENTION_DAYS, DEFAULT_ROLLUP_5M_DAYS);
  return { hostRawMs: hostRaw * HOUR_MS, containerRawMs: contRaw * HOUR_MS, rollup1mMs: r1m * HOUR_MS, rollup5mMs: r5m * DAY_MS };
}

/**
 * Which table serves a chart that looks back `rangeMs`: raw while the window fits inside the kind's raw retention, the
 * 1-minute rollup while it fits inside that, else the 5-minute rollup. The 1-minute tier is never narrower than raw.
 */
export function tierFor(kind: MetricKind, rangeMs: number, tiers: MetricTiers = metricTiers()): MetricTier {
  const rawMs = kind === "host" ? tiers.hostRawMs : tiers.containerRawMs;
  if (rangeMs <= rawMs) return "raw";
  if (rangeMs <= Math.max(tiers.rollup1mMs, rawMs)) return "1m";
  return "5m";
}
