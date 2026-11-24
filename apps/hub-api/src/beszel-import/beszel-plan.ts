/**
 * The dry-run: what importing a Beszel hub would do, decided from one snapshot of it plus what the team already has.
 * Pure (no IO). The public `view` is secret-free (channel labels never carry a token); `channelConfigs` holds the real
 * configs and never leaves the service. The `hash` binds an apply to exactly the plan the operator reviewed.
 */
import { createHash } from "node:crypto";
import type { MetricKind } from "../monitors/checkers";
import { mapAlert, matchSystems, metricUnit, type AlertSkipReason, type BeszelAlert, type BeszelSystem, type MatchBy, type TugraServerLite } from "./beszel-map";
import { parseShoutrrr, type ChannelNoteCode, type ChannelSkipReason } from "./shoutrrr";

export interface PlanInput {
  systems: BeszelSystem[];
  alerts: BeszelAlert[];
  webhooks: string[];
  emails: string[];
  servers: TugraServerLite[];
  /** Operator's manual pick for a system the automatic match left open: systemId → serverId (or null = leave out). */
  overrides?: Record<string, string | null>;
  /** Metric monitors the team already has, so a re-run never duplicates one. */
  existingMonitors: Array<{ serverId: string | null; metric: string | null }>;
  /** `channelKey()` of every channel the team already has. */
  existingChannelKeys: Set<string>;
}

export type SystemView = {
  id: string;
  name: string;
  host: string;
  status: string;
  match: { serverId: string; serverName: string; by: MatchBy | "manual" } | null;
  unmatchedReason?: "none" | "ambiguous" | "duplicate" | "socket";
};
export type AlertOutcome = "create" | "exists" | "covered" | "skip" | "noServer";
export type AlertView = {
  id: string;
  systemId: string;
  systemName: string;
  serverId: string | null;
  name: string;
  outcome: AlertOutcome;
  metric?: MetricKind;
  limit?: number;
  unit?: string;
  minutes: number;
  reason?: AlertSkipReason;
};
export type ChannelOutcome = "create" | "exists" | "skip";
export type ChannelView = {
  index: number;
  service: string;
  label: string;
  type: string | null;
  outcome: ChannelOutcome;
  reason?: ChannelSkipReason | "duplicate";
  notes: ChannelNoteCode[];
};
export interface PlanView {
  systems: SystemView[];
  alerts: AlertView[];
  channels: ChannelView[];
  emails: number;
  hash: string;
}
export interface PlanInternals {
  /** Per ChannelView.index: the real (secret-bearing) config to create. */
  channelConfigs: Map<number, { type: string; config: Record<string, unknown> }>;
  channelKeys: Map<number, string>;
  /** Per AlertView.id: the monitor to create. */
  monitors: Map<string, { serverId: string; serverName: string; metric: MetricKind; thresholdPct?: number; thresholdValue?: number; intervalSec: number; retries: number; limit: number; unit: string }>;
  /** True when Beszel notified on a system going down (the channels then also subscribe to server_offline/online). */
  hasStatusAlert: boolean;
}

/** Canonical identity of a channel: type plus its config with sorted keys. */
export function channelKey(type: string, config: Record<string, unknown>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v;
  return `${type}:${JSON.stringify(sort(config))}`;
}

export function metricLabel(m: MetricKind): string {
  return { CPU: "CPU", MEM: "Memory", DISK: "Disk", TEMP: "Temperature", NET: "Bandwidth", LOAD1: "Load 1m", LOAD5: "Load 5m", LOAD15: "Load 15m" }[m];
}

export function buildPlan(input: PlanInput): { view: PlanView; internals: PlanInternals } {
  const overrides = input.overrides ?? {};
  const serverById = new Map(input.servers.map((s) => [s.id, s]));
  const auto = matchSystems(input.systems, input.servers);

  const systems: SystemView[] = input.systems.map((sys) => {
    const m = auto.get(sys.id)!;
    const autoReason = "reason" in m ? m.reason : ("none" as const);
    const base = { id: sys.id, name: sys.name, host: sys.host, status: sys.status };
    if (Object.prototype.hasOwnProperty.call(overrides, sys.id)) {
      const pick = overrides[sys.id];
      const srv = pick ? serverById.get(pick) : undefined;
      if (srv) return { ...base, match: { serverId: srv.id, serverName: srv.name, by: "manual" as const } };
      return { ...base, match: null, unmatchedReason: autoReason }; // left out on purpose, or a pick outside the team
    }
    return "reason" in m ? { ...base, match: null, unmatchedReason: m.reason } : { ...base, match: { serverId: m.serverId, serverName: m.serverName, by: m.by } };
  });
  const sysById = new Map(systems.map((s) => [s.id, s]));

  // alerts
  const have = new Set(input.existingMonitors.filter((m) => m.serverId && m.metric).map((m) => `${m.serverId}:${m.metric}`));
  const monitors: PlanInternals["monitors"] = new Map();
  let hasStatusAlert = false;
  const alerts: AlertView[] = [];
  for (const a of input.alerts) {
    const sys = sysById.get(a.system);
    if (!sys) continue; // an alert of a system the login cannot list
    const mapped = mapAlert(a);
    const row = { id: a.id, systemId: sys.id, systemName: sys.name, serverId: sys.match?.serverId ?? null, name: a.name };
    if (mapped.kind === "skip") {
      alerts.push({ ...row, outcome: "skip", minutes: Math.max(1, Math.round(a.min) || 1), reason: mapped.reason });
      continue;
    }
    if (mapped.kind === "status") {
      if (sys.match) hasStatusAlert = true;
      alerts.push({ ...row, outcome: sys.match ? "covered" : "noServer", minutes: mapped.minutes });
      continue;
    }
    const limit = mapped.thresholdPct ?? mapped.thresholdValue ?? 0;
    const unit = metricUnit(mapped.metric);
    const view = { ...row, metric: mapped.metric, limit, unit, minutes: mapped.minutes };
    if (!sys.match) {
      alerts.push({ ...view, outcome: "noServer" });
      continue;
    }
    if (have.has(`${sys.match.serverId}:${mapped.metric}`)) {
      alerts.push({ ...view, outcome: "exists" });
      continue;
    }
    alerts.push({ ...view, outcome: "create" });
    monitors.set(a.id, {
      serverId: sys.match.serverId,
      serverName: sys.match.serverName,
      metric: mapped.metric,
      ...(mapped.thresholdPct != null ? { thresholdPct: mapped.thresholdPct } : {}),
      ...(mapped.thresholdValue != null ? { thresholdValue: mapped.thresholdValue } : {}),
      intervalSec: mapped.intervalSec,
      retries: mapped.retries,
      limit,
      unit,
    });
  }

  // channels
  const channels: ChannelView[] = [];
  const channelConfigs: PlanInternals["channelConfigs"] = new Map();
  const channelKeys: PlanInternals["channelKeys"] = new Map();
  const seen = new Set<string>();
  for (const url of input.webhooks) {
    for (const p of parseShoutrrr(url)) {
      const index = channels.length;
      const view = { index, service: p.service, label: p.label, type: p.type, notes: p.notes };
      if (!p.type) {
        channels.push({ ...view, outcome: "skip", reason: p.reason ?? "unsupportedService" });
        continue;
      }
      const key = channelKey(p.type, p.config);
      if (seen.has(key)) {
        channels.push({ ...view, outcome: "skip", reason: "duplicate" });
        continue;
      }
      seen.add(key);
      channelConfigs.set(index, { type: p.type, config: p.config });
      channelKeys.set(index, key);
      channels.push({ ...view, outcome: input.existingChannelKeys.has(key) ? "exists" : "create" });
    }
  }

  const fingerprint = {
    systems: systems.map((s) => [s.id, s.match?.serverId ?? null]),
    alerts: alerts.map((a) => [a.id, a.outcome, a.metric ?? a.name, a.limit ?? 0, a.minutes, a.serverId]),
    channels: channels.map((c) => [c.index, c.outcome, c.type, c.label]),
    emails: input.emails.length,
  };
  const hash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 32);
  return { view: { systems, alerts, channels, emails: input.emails.length, hash }, internals: { channelConfigs, channelKeys, monitors, hasStatusAlert } };
}
