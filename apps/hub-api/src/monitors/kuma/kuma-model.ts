/**
 * Uptime Kuma data, normalised. Two inputs reach the same shape:
 *  - the JSON backup a user downloads from Kuma (Settings > Backup; Kuma 1.x), and
 *  - rows read straight from kuma.db (`SELECT * FROM monitor / notification / monitor_notification`).
 * The two spell the same fields differently (camelCase in the backup, snake_case in the database, booleans as
 * true/false or 0/1, lists as arrays or JSON strings), so every read goes through a tolerant getter.
 * Pure functions only: no I/O, nothing here logs or returns a secret on its own.
 */

export class KumaParseError extends Error {
  constructor(readonly code: "not_json" | "not_kuma" | "empty") {
    super(code);
  }
}

export interface KumaMonitorRow {
  id: string;
  name: string;
  type: string;
  url: string | null;
  hostname: string | null;
  port: number | null;
  method: string | null;
  keyword: string | null;
  invertKeyword: boolean;
  intervalSec: number;
  retryIntervalSec: number | null;
  resendInterval: number;
  maxRetries: number;
  timeoutSec: number | null;
  active: boolean;
  upsideDown: boolean;
  ignoreTls: boolean;
  maxRedirects: number;
  acceptedStatuses: string[];
  headersRaw: string | null;
  body: string | null;
  bodyEncoding: string | null;
  authMethod: string | null;
  basicAuthUser: string | null;
  basicAuthPass: string | null;
  dnsResolveType: string | null;
  dnsResolveServer: string | null;
  expiryNotification: boolean;
  parent: string | null;
  notificationIds: string[];
}

export interface KumaNotificationRow {
  id: string;
  name: string;
  active: boolean;
  /** The decoded `config` JSON (contains the provider's secrets). */
  config: Record<string, unknown>;
}

export interface KumaDump {
  monitors: KumaMonitorRow[];
  notifications: KumaNotificationRow[];
}

type Row = Record<string, unknown>;

function pick(row: Row, ...keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true";
}

/** An array, or a JSON string holding one; anything else -> []. */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Notification ids from either `{"1": true, "2": false}` (backup) or a join-table list. */
function idList(v: unknown): string[] {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, on]) => on === true || on === 1 || on === "1" || on === "true")
      .map(([id]) => id);
  }
  return [];
}

export function toMonitor(row: Row, links: string[] = []): KumaMonitorRow | null {
  const id = str(pick(row, "id"));
  const type = str(pick(row, "type"));
  if (!id || !type) return null;
  const interval = num(pick(row, "interval")) ?? 60;
  return {
    id,
    name: str(pick(row, "name")) ?? `Monitor ${id}`,
    type: type.toLowerCase(),
    url: str(pick(row, "url")),
    hostname: str(pick(row, "hostname")),
    port: num(pick(row, "port")),
    method: str(pick(row, "method")),
    keyword: str(pick(row, "keyword")),
    invertKeyword: bool(pick(row, "invertKeyword", "invert_keyword")),
    intervalSec: interval,
    retryIntervalSec: num(pick(row, "retryInterval", "retry_interval")),
    resendInterval: num(pick(row, "resendInterval", "resend_interval")) ?? 0,
    maxRetries: num(pick(row, "maxretries", "maxRetries")) ?? 0,
    timeoutSec: num(pick(row, "timeout")),
    active: bool(pick(row, "active"), true),
    upsideDown: bool(pick(row, "upsideDown", "upside_down")),
    ignoreTls: bool(pick(row, "ignoreTls", "ignore_tls")),
    maxRedirects: num(pick(row, "maxredirects", "maxRedirects")) ?? 10,
    acceptedStatuses: list(pick(row, "accepted_statuscodes", "accepted_statuscodes_json", "acceptedStatuscodes")).map(String),
    headersRaw: str(pick(row, "headers")),
    body: str(pick(row, "body")),
    bodyEncoding: str(pick(row, "httpBodyEncoding", "http_body_encoding")),
    authMethod: str(pick(row, "authMethod", "auth_method")),
    basicAuthUser: str(pick(row, "basic_auth_user", "basicAuthUser")),
    basicAuthPass: str(pick(row, "basic_auth_pass", "basicAuthPass")),
    dnsResolveType: str(pick(row, "dns_resolve_type", "dnsResolveType")),
    dnsResolveServer: str(pick(row, "dns_resolve_server", "dnsResolveServer")),
    expiryNotification: bool(pick(row, "expiryNotification", "expiry_notification")),
    parent: str(pick(row, "parent")),
    notificationIds: [...new Set([...idList(pick(row, "notificationIDList")), ...links])],
  };
}

export function toNotification(row: Row): KumaNotificationRow | null {
  const id = str(pick(row, "id"));
  if (!id) return null;
  const raw = pick(row, "config");
  let config: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch {
      config = {};
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    config = raw as Record<string, unknown>;
  }
  return { id, name: str(pick(row, "name")) ?? str(config.name) ?? `Notification ${id}`, active: bool(pick(row, "active"), true), config };
}

function rowsOf(v: unknown): Row[] {
  return Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r)) : [];
}

/** Parse the text of a Kuma JSON backup. */
export function parseKumaBackup(text: string): KumaDump {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new KumaParseError("not_json");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new KumaParseError("not_kuma");
  const d = data as Row;
  if (!Array.isArray(d.monitorList) && !Array.isArray(d.notificationList)) throw new KumaParseError("not_kuma");
  const monitors = rowsOf(d.monitorList).map((r) => toMonitor(r)).filter((m): m is KumaMonitorRow => !!m);
  const notifications = rowsOf(d.notificationList).map(toNotification).filter((n): n is KumaNotificationRow => !!n);
  if (monitors.length === 0) throw new KumaParseError("empty");
  return { monitors, notifications };
}

/** Build the same dump from the three tables read out of kuma.db. */
export function dumpFromRows(monitorRows: unknown, notificationRows: unknown, linkRows: unknown): KumaDump {
  const byMonitor = new Map<string, string[]>();
  for (const l of rowsOf(linkRows)) {
    const m = str(pick(l, "monitor_id", "monitorId"));
    const n = str(pick(l, "notification_id", "notificationId"));
    if (!m || !n) continue;
    byMonitor.set(m, [...(byMonitor.get(m) ?? []), n]);
  }
  const monitors = rowsOf(monitorRows)
    .map((r) => toMonitor(r, byMonitor.get(String(r.id)) ?? []))
    .filter((m): m is KumaMonitorRow => !!m);
  const notifications = rowsOf(notificationRows).map(toNotification).filter((n): n is KumaNotificationRow => !!n);
  if (monitors.length === 0) throw new KumaParseError("empty");
  return { monitors, notifications };
}
