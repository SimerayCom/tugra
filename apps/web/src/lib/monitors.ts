import type { Heartbeat, KumaPlan, MonitorStatus } from "./types";

/** Up/down/total counts across a heartbeat window (drives the screen-reader summary). */
export function heartbeatSummary(beats: Heartbeat[]): { up: number; down: number; total: number } {
  const up = beats.filter((b) => b.status === "UP").length;
  const down = beats.filter((b) => b.status === "DOWN").length;
  return { up, down, total: beats.length };
}

export function monitorColor(status: MonitorStatus): string {
  if (status === "UP") return "var(--c-g)";
  if (status === "DOWN") return "var(--c-r)";
  return "var(--c-am)";
}

export function uptimeText(percent: number): string {
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

/** Config fields each channel type needs (drives the add-channel form). */
export const CHANNEL_FIELDS: Record<string, string[]> = {
  webhook: ["url"],
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken", "chatId"],
  ntfy: ["topic", "server"],
};

const CF_REASONS: Record<string, string> = {
  "cf:520": "unknown_response",
  "cf:521": "origin_down",
  "cf:522": "connect_timeout",
  "cf:523": "unreachable",
  "cf:524": "timeout",
  "cf:525": "ssl_handshake",
  "cf:526": "ssl_invalid",
};

/** The likely-reason key (monitors.cf.reason.<key>) for a heartbeat cause such as "cf:522", else null. */
export function cloudflareReasonKey(cause: string | null | undefined): string | null {
  return (cause && CF_REASONS[cause]) || null;
}

/** The monitor kinds a user can create by hand, in picker order. */
export const MANUAL_MONITOR_TYPES = ["HTTP", "KEYWORD", "TCP", "PING", "DNS", "METRIC"] as const;

/** Which refs a fresh Kuma preview selects by default: every monitor that would be created. */
export function defaultMonitorSelection(plan: KumaPlan): Set<string> {
  return new Set(plan.monitors.filter((m) => m.action === "create").map((m) => m.ref));
}

/**
 * Alerts ticked by default: the new ones that a selected monitor actually uses (so nothing is created that
 * nothing needs). Anything else stays unticked and is skipped unless the user opts in.
 */
export function defaultChannelSelection(plan: KumaPlan, selected: ReadonlySet<string>): Set<string> {
  const needed = new Set<string>();
  for (const m of plan.monitors) if (selected.has(m.ref)) for (const r of m.channelRefs) needed.add(r);
  return new Set(plan.channels.filter((c) => c.action === "create" && needed.has(c.ref)).map((c) => c.ref));
}

/** Metric kinds a monitor can watch, in the order the form lists them. */
export const METRIC_KINDS = ["DISK", "CPU", "MEM", "LOAD1", "LOAD5", "LOAD15", "TEMP", "NET"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];
export const isPctMetric = (k: string | null | undefined): boolean => k === "DISK" || k === "CPU" || k === "MEM";
export function metricUnit(k: string | null | undefined): "%" | "°C" | "MB/s" | "" {
  if (isPctMetric(k)) return "%";
  if (k === "TEMP") return "°C";
  if (k === "NET") return "MB/s";
  return "";
}
/** The body fields for a metric limit: whole percent for DISK/CPU/MEM, any positive number for the rest. */
export function limitFields(k: string, raw: string): { thresholdPct: number } | { thresholdValue: number } {
  const n = Number(raw);
  if (isPctMetric(k)) return { thresholdPct: Math.min(100, Math.max(1, Math.round(n) || 80)) };
  return { thresholdValue: n > 0 ? n : 1 };
}
/** The limit of a metric monitor as a number and its unit, or null for HTTP/TCP monitors. */
export function monitorLimit(m: { metric: string | null; thresholdPct: number | null; thresholdValue?: number | null }): { metric: string; value: number; unit: string } | null {
  if (!m.metric) return null;
  const value = isPctMetric(m.metric) ? m.thresholdPct : (m.thresholdValue ?? null);
  return value == null ? null : { metric: m.metric, value, unit: metricUnit(m.metric) };
}

/** i18n key of each metric kind's name (literal keys so the key-usage check can see them). */
export const METRIC_NAME_KEY = {
  DISK: "monitors.metrics.DISK",
  CPU: "monitors.metrics.CPU",
  MEM: "monitors.metrics.MEM",
  LOAD1: "monitors.metrics.LOAD1",
  LOAD5: "monitors.metrics.LOAD5",
  LOAD15: "monitors.metrics.LOAD15",
  TEMP: "monitors.metrics.TEMP",
  NET: "monitors.metrics.NET",
} as const satisfies Record<MetricKind, string>;
/** " MB/s" / "%" / "" — the unit as it follows a number. */
export const unitSuffix = (unit: string): string => (unit === "" ? "" : unit === "%" ? "%" : ` ${unit}`);
