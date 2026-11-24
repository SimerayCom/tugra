/**
 * Per-channel delivery policy — quiet hours, a per-service rate limit and a repeat window — plus the
 * pure helpers that build the "5 times in the last 10 minutes" style summary. No Nest, no Redis: the queue
 * service owns the state, this file owns the rules (so they are unit-testable with a fake clock).
 */
import type { MsgLevel } from "./rendered-message";

export interface QuietHours {
  /** "HH:mm" local to `tz`. from === to means "off". Overnight windows (22:00 → 07:00) are supported. */
  from: string;
  to: string;
  /** IANA zone the window is read in. */
  tz: string;
  /** Failures (critical severity) still go through during quiet hours. Default true. */
  allowCritical: boolean;
}

export interface ChannelPolicy {
  quietHours?: QuietHours;
  /** Messages per minute for this channel (1–600). Unset = the service default. */
  rateLimitPerMin?: number;
  /** Seconds in which a repeat of the same alert is folded into one summary (0 = off, unset = hub default). */
  dedupeWindowSec?: number;
}

export const MAX_RATE_PER_MIN = 600;
export const MAX_DEDUPE_WINDOW_SEC = 86_400;

/**
 * Default messages-per-minute per service, set a little under each service's documented ceiling so we back
 * off before the service starts rejecting. SMS is deliberately low: every message costs money.
 */
export const SERVICE_RATE_LIMITS: Record<string, number> = {
  telegram: 18, // 20 msgs/min per group
  discord: 25, // 30/min per webhook
  slack: 50, // ~1/sec per webhook
  teams: 50,
  mattermost: 60,
  gotify: 60,
  ntfy: 60,
  pushover: 60,
  smtp: 30,
  resend: 60,
  lark: 90,
  webhook: 120,
  matrix: 30,
  googlechat: 50, // 1/sec per space
  rocketchat: 60,
  pagerduty: 100,
  opsgenie: 60,
  zulip: 60,
  bark: 60,
  signal: 20,
  sms: 6,
};
const FALLBACK_RATE = 60;

export function rateLimitFor(type: string, policy: ChannelPolicy): number {
  return policy.rateLimitPerMin ?? SERVICE_RATE_LIMITS[type] ?? FALLBACK_RATE;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Read a stored `policy` JSON leniently: anything malformed is dropped (a bad row must never block delivery). */
export function parsePolicy(raw: unknown): ChannelPolicy {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ChannelPolicy = {};
  const qh = r.quietHours as Record<string, unknown> | undefined;
  if (qh && typeof qh === "object") {
    const { from, to, tz } = qh;
    if (typeof from === "string" && typeof to === "string" && typeof tz === "string" && HHMM.test(from) && HHMM.test(to) && from !== to && isValidTz(tz)) {
      out.quietHours = { from, to, tz, allowCritical: qh.allowCritical !== false };
    }
  }
  const rate = Number(r.rateLimitPerMin);
  if (r.rateLimitPerMin != null && Number.isInteger(rate) && rate >= 1 && rate <= MAX_RATE_PER_MIN) out.rateLimitPerMin = rate;
  const win = Number(r.dedupeWindowSec);
  if (r.dedupeWindowSec != null && Number.isInteger(win) && win >= 0 && win <= MAX_DEDUPE_WINDOW_SEC) out.dedupeWindowSec = win;
  return out;
}

const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Seconds since local midnight in `tz`. */
function localSeconds(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

export function inQuietHours(q: QuietHours, now: Date): boolean {
  const cur = Math.floor(localSeconds(now, q.tz) / 60);
  const from = toMin(q.from);
  const to = toMin(q.to);
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** Milliseconds until the quiet window ends (always > 0 while {@link inQuietHours} is true). */
export function msUntilQuietEnds(q: QuietHours, now: Date): number {
  const cur = localSeconds(now, q.tz);
  const to = toMin(q.to) * 60;
  const delta = ((to - cur) % 86_400 + 86_400) % 86_400;
  return (delta === 0 ? 86_400 : delta) * 1000;
}

// ---- summary ----

export type HoldReason = "repeat" | "quiet" | "rate";

export interface HeldEntry {
  type: string;
  title: string;
  level: MsgLevel;
  at: string;
}

export interface SummaryItem {
  title: string;
  count: number;
  level: MsgLevel;
}

export interface SummaryCtx {
  reason: HoldReason;
  total: number;
  windowSec: number;
  items: SummaryItem[];
  more: number;
  [k: string]: unknown;
}

const LEVEL_RANK: Record<MsgLevel, number> = { failure: 3, warning: 2, info: 1, success: 0 };
const MAX_SUMMARY_ITEMS = 8;

/** Fold held entries into one summary context: identical titles are counted, the worst first, capped at 8 lines. */
export function buildSummaryCtx(reason: HoldReason, entries: HeldEntry[], total: number, windowSec: number): SummaryCtx {
  const byTitle = new Map<string, SummaryItem>();
  for (const e of entries) {
    const hit = byTitle.get(e.title);
    if (hit) hit.count += 1;
    else byTitle.set(e.title, { title: e.title, count: 1, level: e.level });
  }
  const all = [...byTitle.values()].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.count - a.count);
  return {
    reason,
    total,
    windowSec,
    items: all.slice(0, MAX_SUMMARY_ITEMS),
    more: Math.max(0, all.length - MAX_SUMMARY_ITEMS),
  };
}

/** The highest severity among a summary's items (what level the combined message should carry). */
export function summaryLevel(items: SummaryItem[]): MsgLevel {
  return items.reduce<MsgLevel>((m, i) => (LEVEL_RANK[i.level] > LEVEL_RANK[m] ? i.level : m), "success");
}
