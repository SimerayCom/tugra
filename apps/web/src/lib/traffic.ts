import type { TrafficSummary } from "./types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Scale a per-bucket byte series into ONE readable unit chosen from the series PEAK (the chart prints a
 *  y-axis ceiling, so the unit must fit the biggest bucket). Idle/empty series stay in "B". */
export function humanizeBytesSeries(values: number[]): { data: number[]; unit: string } {
  let peak = 0;
  for (const v of values) if (Number.isFinite(v) && v > peak) peak = v;
  let i = 0;
  while (peak >= 1024 && i < BYTE_UNITS.length - 1) {
    peak /= 1024;
    i++;
  }
  const divisor = 1024 ** i;
  return { data: divisor === 1 ? values.slice() : values.map((v) => v / divisor), unit: BYTE_UNITS[i] };
}

/** Nominal bucket width (ms) for the chart's gap-as-break detection; undefined when the hub gave no step. */
export function bucketIntervalMs(s: Pick<TrafficSummary, "stepSec"> | undefined): number | undefined {
  return s && Number.isFinite(s.stepSec) && s.stepSec > 0 ? s.stepSec * 1000 : undefined;
}

export interface CountryShare {
  country: string;
  requests: number;
  /** Share (0-100) of the GEOLOCATED requests, i.e. of the sum of the returned countries. */
  pct: number;
}

/**
 * Country rows with their percentage.
 *
 * The denominator is the SUM of the returned countries' requests, NOT the summary's total request count:
 * requests the proxy could not geolocate are never counted per country, so dividing by the total would
 * understate every country (the page shows a separate coverage line for that gap). Rows with no requests are dropped; a zero denominator yields no rows (never NaN).
 */
export function countryShares(rows: { country: string; requests: number }[]): CountryShare[] {
  const clean = rows.filter((r) => Number.isFinite(r.requests) && r.requests > 0);
  const denom = clean.reduce((n, r) => n + r.requests, 0);
  if (denom <= 0) return [];
  return clean.map((r) => ({ country: r.country, requests: r.requests, pct: (r.requests / denom) * 100 }));
}

/** Localized country name from an ISO-3166 alpha-2 code; null for "ZZ" (the overflow/"Other" bucket), malformed or unknown codes (never throws). */
export function countryName(code: string, lang: string): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === "ZZ") return null;
  try {
    const name = new Intl.DisplayNames([lang], { type: "region" }).of(c);
    // Intl echoes the code back when it has no name for it.
    return name && name !== c ? name : null;
  } catch {
    return null;
  }
}

/** True when the summary and every list carry nothing to show (→ calm "Traffic Analytics may be off" state). */
export function trafficIsEmpty(
  summary: TrafficSummary | undefined,
  paths: { paths: unknown[]; other: { requests: number } } | undefined,
  countries: { countries: unknown[] } | undefined,
): boolean {
  const noSeries = !summary || (summary.totals.requests <= 0 && !summary.requests.some((v) => v > 0));
  return noSeries && !(paths && (paths.paths.length > 0 || paths.other.requests > 0)) && !(countries && countries.countries.length > 0);
}

/** Share of responses that were 4xx/5xx, as a percentage (0 when there were no requests). */
export function errorRatePct(t: Pick<TrafficSummary["totals"], "requests" | "s4xx" | "s5xx">): number {
  return t.requests > 0 ? ((t.s4xx + t.s5xx) / t.requests) * 100 : 0;
}
