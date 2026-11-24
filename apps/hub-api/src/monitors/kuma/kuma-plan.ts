import type { KumaDump } from "./kuma-model";
import {
  mapKumaMonitor,
  mapKumaNotification,
  type ChannelMapping,
  type KumaWarning,
  type MonitorDraft,
  type MonitorMapping,
} from "./kuma-map";

export interface ExistingMonitor {
  name: string;
  type: string;
  target: string;
}
export interface ExistingChannel {
  id: string;
  name: string;
  type: string;
}

export type MonitorAction = "create" | "exists" | "unsupported" | "group";
export type ChannelAction = "create" | "reuse" | "unsupported";

/** What the dry-run shows. Never carries a secret (no headers, bodies, passwords, tokens or webhook URLs). */
export interface PlanMonitorView {
  ref: string;
  name: string;
  kumaType: string;
  /** The Tugra monitor type, or null when it cannot be imported. */
  type: string | null;
  /** The URL / host to check (shown without any user:password@ part). */
  target: string | null;
  action: MonitorAction;
  /** Why it cannot be imported (type | target | keyword | dns_type | group). */
  reason?: string;
  warnings: KumaWarning[];
  channelRefs: string[];
}

export interface PlanChannelView {
  ref: string;
  name: string;
  kumaType: string;
  type: string | null;
  action: ChannelAction;
  reason?: string;
  warnings: KumaWarning[];
  /** How many importable monitors use it. */
  usedBy: number;
  /** For "reuse": the existing Tugra channel. */
  existingId?: string;
}

export interface ImportPlan {
  monitors: PlanMonitorView[];
  channels: PlanChannelView[];
  totals: { monitors: number; create: number; exists: number; unsupported: number; channelsToCreate: number };
}

/** The plan plus what apply needs (kept server-side only; contains secrets inside the drafts / configs). */
export interface InternalPlan {
  view: ImportPlan;
  drafts: Map<string, { draft: MonitorDraft; channelRefs: string[] }>;
  channels: Map<string, Extract<ChannelMapping, { ok: true }>>;
}

/** A URL without any user:password@ part, for display (the stored target keeps it; the preview never shows it). */
export function redactTarget(target: string): string {
  try {
    const u = new URL(target);
    if (!u.username && !u.password) return target;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return target;
  }
}

const key = (name: string, type: string, target: string) => `${name.trim().toLowerCase()}\u0000${type}\u0000${target.trim().toLowerCase()}`;

export function buildPlan(dump: KumaDump, existingMonitors: ExistingMonitor[], existingChannels: ExistingChannel[]): InternalPlan {
  const seen = new Set(existingMonitors.map((m) => key(m.name, m.type, m.target)));
  const drafts: InternalPlan["drafts"] = new Map();
  const monitors: PlanMonitorView[] = [];

  for (const k of dump.monitors) {
    const mapped: MonitorMapping = mapKumaMonitor(k);
    if (!mapped.ok) {
      monitors.push({
        ref: k.id,
        name: k.name,
        kumaType: k.type,
        type: null,
        target: null,
        action: mapped.reason === "group" ? "group" : "unsupported",
        reason: mapped.reason,
        warnings: [],
        channelRefs: [],
      });
      continue;
    }
    const d = mapped.draft;
    const k2 = key(d.name, d.type, d.target ?? "");
    const exists = seen.has(k2);
    seen.add(k2);
    if (!exists) drafts.set(k.id, { draft: d, channelRefs: mapped.channelRefs });
    monitors.push({
      ref: k.id,
      name: d.name,
      kumaType: k.type,
      type: d.type,
      target: d.target ? redactTarget(d.target) : null,
      action: exists ? "exists" : "create",
      warnings: mapped.warnings,
      channelRefs: mapped.channelRefs,
    });
  }

  const usedBy = new Map<string, number>();
  for (const m of monitors) {
    if (m.action !== "create") continue;
    for (const ref of new Set(m.channelRefs)) usedBy.set(ref, (usedBy.get(ref) ?? 0) + 1);
  }

  const channels: PlanChannelView[] = [];
  const channelMap: InternalPlan["channels"] = new Map();
  for (const n of dump.notifications) {
    const mapped = mapKumaNotification(n);
    if (!mapped.ok) {
      channels.push({ ref: n.id, name: n.name, kumaType: mapped.kumaType, type: null, action: "unsupported", reason: mapped.reason, warnings: [], usedBy: usedBy.get(n.id) ?? 0 });
      continue;
    }
    const match = existingChannels.find((c) => c.type === mapped.type && c.name.trim().toLowerCase() === mapped.name.trim().toLowerCase());
    if (!match) channelMap.set(n.id, mapped);
    channels.push({
      ref: n.id,
      name: mapped.name,
      kumaType: mapped.kumaType,
      type: mapped.type,
      action: match ? "reuse" : "create",
      warnings: mapped.warnings,
      usedBy: usedBy.get(n.id) ?? 0,
      ...(match ? { existingId: match.id } : {}),
    });
  }

  return {
    view: {
      monitors,
      channels,
      totals: {
        monitors: monitors.length,
        create: monitors.filter((m) => m.action === "create").length,
        exists: monitors.filter((m) => m.action === "exists").length,
        unsupported: monitors.filter((m) => m.action === "unsupported" || m.action === "group").length,
        channelsToCreate: channels.filter((c) => c.action === "create").length,
      },
    },
    drafts,
    channels: channelMap,
  };
}
