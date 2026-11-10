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

/** Bot vs human split of the requests the hub could classify. The denominator is bot + human (NOT totals.requests,
 *  which can include requests the classifier never saw). Zero-guarded: no classified requests → 0/0, never NaN. */
export function botShare(t: Pick<TrafficSummary["totals"], "botRequests" | "humanRequests">): { botPct: number; humanPct: number; classified: number } {
  const bot = Number.isFinite(t.botRequests) && t.botRequests > 0 ? t.botRequests : 0;
  const human = Number.isFinite(t.humanRequests) && t.humanRequests > 0 ? t.humanRequests : 0;
  const classified = bot + human;
  if (classified <= 0) return { botPct: 0, humanPct: 0, classified: 0 };
  return { botPct: (bot / classified) * 100, humanPct: (human / classified) * 100, classified };
}

export interface BreakdownShare {
  key: string;
  requests: number;
  /** Share (0-100) of the dimension's requests: the returned items PLUS the folded "(other)" overflow. */
  pct: number;
  /** True for the synthetic row built from the response's `other` overflow. */
  isOther: boolean;
}

/**
 * Ranked breakdown rows with honest shares. The denominator is the sum of the returned items' requests plus
 * `other.requests`, so the rows (including the "(other)" row appended when non-zero) add up to 100%.
 * Zero/invalid rows are dropped; an empty set yields no rows (never NaN).
 */
export function breakdownShares(items: { key: string; requests: number }[], otherRequests: number): BreakdownShare[] {
  const clean = items.filter((r) => Number.isFinite(r.requests) && r.requests > 0);
  const other = Number.isFinite(otherRequests) && otherRequests > 0 ? otherRequests : 0;
  const denom = clean.reduce((n, r) => n + r.requests, 0) + other;
  if (denom <= 0) return [];
  const rows: BreakdownShare[] = clean.map((r) => ({ key: r.key, requests: r.requests, pct: (r.requests / denom) * 100, isOther: false }));
  if (other > 0) rows.push({ key: "(other)", requests: other, pct: (other / denom) * 100, isOther: true });
  return rows;
}
