/** Pure helpers for a channel's delivery rules (quiet hours, rate limit, repeat window): form draft <-> API body. */
import type { ChannelPolicy, ChannelPolicyInput } from "./types";

export interface PolicyDraft {
  quietOn: boolean;
  from: string; // HH:mm
  to: string; // HH:mm
  tz: string;
  allowCritical: boolean;
  /** Text so a half-typed number is not coerced mid-edit; "" = the service default. */
  rate: string;
  /** "" = hub default, "0" = off, otherwise seconds. */
  window: string;
}

/** The repeat-window choices offered in the UI (seconds); "" is the hub default. */
export const REPEAT_WINDOWS = ["", "0", "300", "600", "1800", "3600"] as const;

export const MAX_RATE_PER_MIN = 600;

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function draftFromPolicy(p: ChannelPolicy | undefined, tz: string = browserTimeZone()): PolicyDraft {
  return {
    quietOn: !!p?.quietHours,
    from: p?.quietHours?.from ?? "22:00",
    to: p?.quietHours?.to ?? "07:00",
    tz: p?.quietHours?.tz ?? tz,
    allowCritical: p?.quietHours?.allowCritical ?? true,
    rate: p?.rateLimitPerMin != null ? String(p.rateLimitPerMin) : "",
    window: p?.dedupeWindowSec != null ? String(p.dedupeWindowSec) : "",
  };
}

export type PolicyProblem = "rate" | "quiet" | "tz";

/** Validate a draft and build the API body (null = back to the default). `problems` lists what to fix. */
export function policyFromDraft(d: PolicyDraft): { body: ChannelPolicyInput; problems: PolicyProblem[] } {
  const problems: PolicyProblem[] = [];
  let rateLimitPerMin: number | null = null;
  if (d.rate.trim() !== "") {
    const n = Number(d.rate);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_RATE_PER_MIN) rateLimitPerMin = n;
    else problems.push("rate");
  }
  let quietHours: ChannelPolicyInput["quietHours"] = null;
  if (d.quietOn) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.to) || d.from === d.to) problems.push("quiet");
    else if (!d.tz.trim()) problems.push("tz");
    else quietHours = { from: d.from, to: d.to, tz: d.tz.trim(), allowCritical: d.allowCritical };
  }
  const dedupeWindowSec = d.window === "" ? null : Number(d.window);
  return { body: { quietHours, rateLimitPerMin, dedupeWindowSec }, problems };
}

/** One-line description of a channel's rules for the list ("" when everything is default). */
export function policyBadges(p: ChannelPolicy | undefined): Array<"quiet" | "rate" | "repeat"> {
  const out: Array<"quiet" | "rate" | "repeat"> = [];
  if (p?.quietHours) out.push("quiet");
  if (p?.rateLimitPerMin != null) out.push("rate");
  if (p?.dedupeWindowSec != null) out.push("repeat");
  return out;
}
