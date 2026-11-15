import { readChartTimes, type ChartTimes } from "./appearance";

/**
 * Timestamp formatting that honours Settings → Appearance → "Chart times": "Your time" shows only the browser's
 * local time; "Your time + UTC" appends the same instant in UTC. Used by the metrics charts and by deployment /
 * log timestamps. `mode` defaults to the stored preference; pass it explicitly from a render that already
 * subscribed via useAppearance() so the output follows live changes.
 */

type Input = number | string | Date;

function toDate(ts: Input): Date {
  return ts instanceof Date ? ts : new Date(ts);
}

/** The instant in UTC: "2026-11-15 14:05 UTC" (seconds when asked). Empty string for an invalid date. */
export function formatUtc(ts: Input, opts: { seconds?: boolean; dateOnly?: boolean } = {}): string {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString(); // 2026-11-15T14:05:09.000Z
  const date = iso.slice(0, 10);
  if (opts.dateOnly) return `${date} UTC`;
  return `${date} ${iso.slice(11, opts.seconds ? 19 : 16)} UTC`;
}

/** Local `text` plus ` · <utc>` when the preference asks for UTC too. */
export function withUtc(local: string, ts: Input, mode: ChartTimes, opts: { seconds?: boolean } = {}): string {
  if (mode !== "localUtc") return local;
  const utc = formatUtc(ts, opts);
  return utc ? `${local} · ${utc}` : local;
}

/** Full local date + time (`toLocaleString`), with the UTC suffix when enabled. */
export function formatDateTime(ts: Input, mode: ChartTimes = readChartTimes()): string {
  return withUtc(toDate(ts).toLocaleString(), ts, mode, { seconds: true });
}

/** Local clock time (`toLocaleTimeString`), with the UTC suffix when enabled. */
export function formatClock(ts: Input, mode: ChartTimes = readChartTimes()): string {
  return withUtc(toDate(ts).toLocaleTimeString(), ts, mode, { seconds: true });
}
