/**
 * Weekly digest logic that needs no database: when a digest is due (Monday morning in the hub's time zone) and
 * which rule-based suggestions a week of numbers produces. The service gathers the numbers; this file decides.
 */

/** The hour (local, hub time) the weekly digest goes out. */
export const DIGEST_HOUR = 8;
/** How long after the due time a missed digest may still be sent (a hub that was down Monday morning). */
export const DIGEST_GRACE_MS = 24 * 3600_000;

/** The time zone "hub time" means: HUB_TIMEZONE, else TZ, else the process zone. */
export function hubTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  for (const cand of [env.HUB_TIMEZONE, env.TZ]) {
    if (cand && isZone(cand)) return cand;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY[get("weekday")] ?? 1,
  };
}

/** How far `tz` is ahead of UTC at `at`, in ms. */
function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads y-m-d hh:00 (DST-safe: offset re-read at the result). */
function wallToInstant(y: number, m: number, d: number, hour: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

/** The most recent Monday {@link DIGEST_HOUR}:00 (in `tz`) at or before `now`. */
export function lastDueAt(now: Date, tz: string): Date {
  const p = localParts(now, tz);
  let daysBack = p.weekday - 1;
  if (daysBack === 0 && p.hour < DIGEST_HOUR) daysBack = 7; // Monday, but before the send hour
  // Step the calendar date (not 24h blocks) so a DST change never shifts the day.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - daysBack));
  return wallToInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), DIGEST_HOUR, tz);
}

/**
 * Is a digest due now? True from Monday 08:00 (hub time) until the grace window ends, once per week:
 * never when `lastSentAt` already covers this week's due time.
 */
export function isDigestDue(now: Date, lastSentAt: Date | null, tz: string): boolean {
  const due = lastDueAt(now, tz);
  if (now.getTime() - due.getTime() > DIGEST_GRACE_MS) return false;
  return lastSentAt == null || lastSentAt.getTime() < due.getTime();
}

// ---- suggestions ----

export interface WeekStats {
  deploys: { total: number; failed: number };
  /** The app with the most failed deploys this week, when any failed. */
  worstApp: { name: string; failed: number } | null;
  backups: { total: number; failed: number };
  /** Databases with no successful backup in the window. */
  databasesWithoutBackup: number;
  incidents: number;
  busiestServer: { name: string; cpuPct: number } | null;
  /** Servers whose average disk use was high, worst first. */
  fullestDisk: { name: string; pct: number } | null;
}

export interface Suggestion {
  code: string;
  params: Record<string, string | number>;
}

const MAX_SUGGESTIONS = 3;

/** Deterministic, most-urgent-first suggestions (at most three) from a week's numbers. */
export function buildSuggestions(w: WeekStats): Suggestion[] {
  const out: Suggestion[] = [];
  if (w.backups.failed > 0) out.push({ code: "failing_backups", params: { count: w.backups.failed } });
  if (w.worstApp && w.worstApp.failed >= 2) out.push({ code: "failing_deploys", params: { app: w.worstApp.name, count: w.worstApp.failed } });
  if (w.fullestDisk && w.fullestDisk.pct >= 85) out.push({ code: "disk_high", params: { name: w.fullestDisk.name, pct: Math.round(w.fullestDisk.pct) } });
  if (w.databasesWithoutBackup > 0) out.push({ code: "no_backups", params: { count: w.databasesWithoutBackup } });
  if (w.incidents >= 3) out.push({ code: "incidents", params: { count: w.incidents } });
  if (w.busiestServer && w.busiestServer.cpuPct >= 80) out.push({ code: "cpu_high", params: { name: w.busiestServer.name, pct: Math.round(w.busiestServer.cpuPct) } });
  return out.slice(0, MAX_SUGGESTIONS);
}
