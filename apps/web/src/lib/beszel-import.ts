/** Types and pure helpers for the Beszel import page. The shapes mirror the hub's /import/beszel responses. */

export type BeszelMatchBy = "ip" | "hostname" | "name" | "manual";
export type BeszelUnmatchedReason = "none" | "ambiguous" | "duplicate" | "socket";

export interface BeszelSystemRow {
  id: string;
  name: string;
  host: string;
  status: string;
  match: { serverId: string; serverName: string; by: BeszelMatchBy } | null;
  unmatchedReason?: BeszelUnmatchedReason;
}
export type BeszelAlertOutcome = "create" | "exists" | "covered" | "skip" | "noServer";
export type BeszelAlertSkipReason = "battery" | "gpu" | "cpuState" | "container" | "systemd" | "network" | "smart" | "other";
export type BeszelMetric = "CPU" | "MEM" | "DISK" | "LOAD1" | "LOAD5" | "LOAD15" | "TEMP" | "NET";
export interface BeszelAlertRow {
  id: string;
  systemId: string;
  systemName: string;
  serverId: string | null;
  name: string;
  outcome: BeszelAlertOutcome;
  metric?: BeszelMetric;
  limit?: number;
  unit?: string;
  minutes: number;
  reason?: BeszelAlertSkipReason;
}
export type BeszelChannelOutcome = "create" | "exists" | "skip";
export type BeszelChannelSkipReason = "invalidUrl" | "unsupportedService" | "unsupportedAuth" | "unsupportedBot" | "duplicate";
export interface BeszelChannelRow {
  index: number;
  service: string;
  label: string;
  type: string | null;
  outcome: BeszelChannelOutcome;
  reason?: BeszelChannelSkipReason;
  notes: Array<"genericPayload" | "multipleChats">;
}
export interface BeszelPreview {
  sessionId: string;
  host: string;
  systems: BeszelSystemRow[];
  alerts: BeszelAlertRow[];
  channels: BeszelChannelRow[];
  emails: number;
  hash: string;
  servers: Array<{ id: string; name: string }>;
  history: { windowDays: number; totalPoints: number; systems: Array<{ systemId: string; serverId: string; points: number; from: string | null; to: string | null }> };
}
export interface BeszelConnectResult {
  sessionId: string;
  expiresAt: string;
  host: string;
  credentialsKept: boolean;
}
export interface BeszelSavedConnection {
  sessionId: string;
  teamId: string;
  host: string;
  expiresAt: string;
}
export interface BeszelApplyResult {
  channels: { created: number; existing: number; failed: number; skipped: number };
  monitors: { created: number; existing: number; failed: number; skipped: number; covered: number };
  history: { systems: number; points: number };
  failures: Array<{ kind: "channel" | "alert" | "history"; ref: string; reason: "rejected" | "error" }>;
  credentialsDropped: boolean;
}
export interface BeszelApplyInput {
  sessionId: string;
  previewHash: string;
  serverOverrides?: Record<string, string | null>;
  parts: { alerts: boolean; channels: boolean; history: boolean };
  systemIds?: string[];
}

/** What the review header counts: matched systems and what each part would write. */
export function summarizePreview(p: BeszelPreview, excluded: ReadonlySet<string> = new Set()) {
  const matched = p.systems.filter((s) => s.match && !excluded.has(s.id));
  const inScope = new Set(matched.map((s) => s.id));
  return {
    systemsMatched: matched.length,
    systemsOpen: p.systems.filter((s) => !s.match).length,
    alertsToCreate: p.alerts.filter((a) => a.outcome === "create" && inScope.has(a.systemId)).length,
    alertsSkipped: p.alerts.filter((a) => a.outcome === "skip" || a.outcome === "noServer").length,
    channelsToCreate: p.channels.filter((c) => c.outcome === "create").length,
    channelsSkipped: p.channels.filter((c) => c.outcome === "skip").length,
    historyPoints: p.history.systems.filter((h) => inScope.has(h.systemId)).reduce((n, h) => n + h.points, 0),
  };
}

/** The apply body for the current choices; systems left unticked are sent as an explicit allow-list. */
export function buildApplyInput(p: BeszelPreview, opts: { overrides: Record<string, string | null>; parts: BeszelApplyInput["parts"]; excluded: ReadonlySet<string> }): BeszelApplyInput {
  const systemIds = p.systems.filter((s) => s.match && !opts.excluded.has(s.id)).map((s) => s.id);
  return {
    sessionId: p.sessionId,
    previewHash: p.hash,
    ...(Object.keys(opts.overrides).length ? { serverOverrides: opts.overrides } : {}),
    parts: opts.parts,
    systemIds,
  };
}

/** The hub's connect error as one of the page's messages: the stable `code` when the body carries one. */
export function connectErrorCode(e: unknown): "badCredentials" | "notBeszel" | "unreachable" | "mfa" | "forbidden" | "generic" {
  const body = (e as { data?: Record<string, unknown> } | null)?.data;
  const nested = body && typeof body.message === "object" && body.message ? (body.message as Record<string, unknown>) : body;
  const code = (nested?.code ?? (e as { code?: unknown } | null)?.code) as string | undefined;
  return code === "badCredentials" || code === "notBeszel" || code === "unreachable" || code === "mfa" || code === "forbidden" ? code : "generic";
}
