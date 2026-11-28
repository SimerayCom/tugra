/**
 * Pure mappers from Coolify's settings endpoints to {@link RawSettings} rows and, for notifications, to Tugra channels.
 * No I/O. Parsing is tolerant: Coolify's notification endpoints return the settings row's columns without a published
 * schema, so a field that is missing means "not readable" (never a guess), and an unknown event is reported, not dropped.
 */
import type { EventType } from "@tugra/shared";
import { isValidCron } from "../../common/cron";
import type { ChannelGroup, ChannelKind, RawChannel, RawChannelEvent, RawMember, RawServerCleanup, RawSharedVar, RawStorage, RawTag, RawTask } from "./settings-types";

/**
 * Coolify notification event -> the Tugra events that carry the same information. An empty list means Tugra has no such
 * event yet; the preview then names the Coolify event as "not carried" instead of mapping it to something unrelated.
 */
export const COOLIFY_EVENT_MAP: Readonly<Record<string, readonly EventType[]>> = {
  deployment_success: ["deploy_success"],
  deployment_failure: ["deploy_failed"],
  status_change: ["container_crashed", "container_unhealthy"],
  backup_success: ["backup_success", "volume_backup_success"],
  backup_failure: ["backup_failed", "volume_backup_failed"],
  scheduled_task_success: ["scheduled_task_success"],
  scheduled_task_failure: ["scheduled_task_failed"],
  docker_cleanup_success: ["docker_cleanup_success"],
  docker_cleanup_failure: ["docker_cleanup_failed"],
  server_reachable: ["server_online"],
  server_unreachable: ["server_offline"],
  // Known Coolify events with no Tugra event today (kept explicit so the note can say so):
  server_disk_usage: [],
  server_patch: [],
  traefik_outdated: [],
  server_validation_failed: [],
  server_restart_limit: [],
  image_vulnerability: [],
};

/** Column prefix of each Coolify channel's settings row (email's event columns live under `smtp_`). */
const PREFIX: Record<ChannelKind, string> = { telegram: "telegram", discord: "discord", slack: "slack", pushover: "pushover", webhook: "webhook", email: "smtp" };

export const CHANNEL_KINDS: readonly ChannelKind[] = ["telegram", "discord", "slack", "pushover", "webhook", "email"];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/** The settings row, whether the API returned it bare or wrapped in `data` / `settings`. */
function row(body: unknown): Record<string, unknown> {
  const o = obj(body);
  if ("data" in o && typeof o.data === "object" && o.data) return obj(o.data);
  if ("settings" in o && typeof o.settings === "object" && o.settings) return obj(o.settings);
  return o;
}

/** A Telegram topic id: digits only (anything else is ignored rather than guessed). */
const threadOf = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{1,12}$/.test(s) ? s : undefined;
};

/** The enabled events of a settings row, with their per-event topic. Sorted so the result is stable. */
function readEvents(r: Record<string, unknown>, prefix: string): RawChannelEvent[] {
  const head = `${prefix}_notifications_`;
  const out: RawChannelEvent[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (!k.startsWith(head) || k.endsWith("_thread_id")) continue;
    if (!bool(v)) continue;
    const event = k.slice(head.length);
    if (!/^[a-z0-9_]{1,64}$/.test(event)) continue;
    const thread = prefix === "telegram" ? threadOf(r[`${k}_thread_id`]) : undefined;
    out.push(thread ? { event, threadId: thread } : { event });
  }
  return out.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}

/**
 * One Coolify channel settings row -> a {@link RawChannel}. `null` when the body has nothing that looks like this
 * channel (an older Coolify answering with an empty object). Secrets are copied into `config` for the apply and nowhere else.
 */
export function parseCoolifyChannel(kind: ChannelKind, body: unknown): RawChannel | null {
  const r = row(body);
  if (Object.keys(r).length === 0) return null;
  const channel = parseChannelRow(kind, r);
  return channel ? { ...channel, configured: channelConfigured(kind, r, channel.enabled) } : null;
}

/** A column that holds something: a non-empty text, a number other than 0, or a true flag (an unset column, "", 0 and false do not count). */
const filled = (v: unknown): boolean => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : str(v) !== undefined && v !== "0" && v !== "false");

/** The columns that only hold something once the channel was set up (a credential or where it posts). Their presence is read, never their value. */
const SETUP_FIELDS: Record<ChannelKind, readonly string[]> = {
  telegram: ["telegram_token", "telegram_chat_id"],
  discord: ["discord_webhook_url"],
  slack: ["slack_webhook_url"],
  webhook: ["webhook_url"],
  pushover: ["pushover_api_token", "pushover_user_key"],
  email: ["smtp_host", "smtp_recipients", "smtp_from_address", "smtp_username", "resend_api_key", "resend_enabled", "smtp_enabled", "use_instance_email_settings"],
};

/**
 * Whether the channel was ever set up in Coolify: it is switched on, or it holds a credential or a destination. A channel that is off and empty is
 * simply not there: saying "Coolify did not hand over the value" about it would send the owner looking for something that does not exist.
 */
function channelConfigured(kind: ChannelKind, r: Record<string, unknown>, enabled: boolean): boolean {
  return enabled || SETUP_FIELDS[kind].some((k) => filled(r[k]));
}

function parseChannelRow(kind: ChannelKind, r: Record<string, unknown>): RawChannel | null {
  const p = PREFIX[kind];
  const events = readEvents(r, p);
  const base = { kind, events, config: {} as Record<string, string> };
  switch (kind) {
    case "telegram": {
      const botToken = str(r.telegram_token);
      const chatId = str(r.telegram_chat_id);
      return { ...base, enabled: bool(r.telegram_enabled), providerType: "telegram", secretsReadable: !!botToken && !!chatId, config: botToken && chatId ? { botToken, chatId } : {} };
    }
    case "discord": {
      const webhookUrl = str(r.discord_webhook_url);
      return { ...base, enabled: bool(r.discord_enabled), providerType: "discord", secretsReadable: !!webhookUrl, config: webhookUrl ? { webhookUrl } : {} };
    }
    case "slack": {
      const webhookUrl = str(r.slack_webhook_url);
      return { ...base, enabled: bool(r.slack_enabled), providerType: "slack", secretsReadable: !!webhookUrl, config: webhookUrl ? { webhookUrl } : {} };
    }
    case "webhook": {
      const url = str(r.webhook_url);
      return { ...base, enabled: bool(r.webhook_enabled), providerType: "webhook", secretsReadable: !!url, config: url ? { url } : {} };
    }
    case "pushover": {
      const token = str(r.pushover_api_token);
      const userKey = str(r.pushover_user_key);
      return { ...base, enabled: bool(r.pushover_enabled), providerType: "pushover", secretsReadable: !!token && !!userKey, config: token && userKey ? { token, userKey } : {} };
    }
    case "email": {
      const resend = bool(r.resend_enabled);
      const enabled = resend || bool(r.smtp_enabled);
      if (bool(r.use_instance_email_settings) && !resend) return { ...base, enabled, providerType: "smtp", secretsReadable: false, instanceEmail: true };
      const to = str(r.smtp_recipients);
      const from = str(r.smtp_from_address);
      if (resend) {
        const apiKey = str(r.resend_api_key);
        return { ...base, enabled, providerType: "resend", secretsReadable: !!apiKey && !!to && !!from, config: apiKey && to && from ? { apiKey, from, to } : {} };
      }
      const host = str(r.smtp_host);
      const port = str(r.smtp_port) ?? "587";
      const user = str(r.smtp_username);
      const pass = str(r.smtp_password);
      const encryption = (str(r.smtp_encryption) ?? "").toLowerCase();
      const secure = encryption === "tls" || encryption === "ssl" || port === "465";
      // The password is the readable-only-with-sensitive field; a server without auth has neither user nor password.
      const readable = !!host && !!to && !!from && (!user || !!pass);
      return { ...base, enabled, providerType: "smtp", secretsReadable: readable, config: readable ? { host, port, secure: secure ? "true" : "false", ...(user ? { user } : {}), ...(pass ? { pass } : {}), from, to } : {} };
    }
  }
}

/**
 * Group a channel's enabled events into the Tugra channels that carry them. A Tugra Telegram channel has ONE topic, so
 * each distinct Coolify topic becomes its own channel; every other kind is a single channel. Coolify events with no Tugra
 * event are left out of every group (the caller reports them via {@link unmappedEvents}).
 */
export function planChannelGroups(ch: RawChannel): ChannelGroup[] {
  const byThread = new Map<string, ChannelGroup>();
  for (const e of ch.events) {
    const tugra = COOLIFY_EVENT_MAP[e.event] ?? [];
    if (tugra.length === 0) continue;
    const key = ch.kind === "telegram" ? (e.threadId ?? "") : "";
    const g = byThread.get(key) ?? { ...(key ? { threadId: key } : {}), coolifyEvents: [], tugraEvents: [] };
    g.coolifyEvents.push(e.event);
    for (const t of tugra) if (!g.tugraEvents.includes(t)) g.tugraEvents.push(t);
    byThread.set(key, g);
  }
  const groups = [...byThread.values()].sort((a, b) => (a.threadId ?? "") .localeCompare(b.threadId ?? "", "en", { numeric: true }));
  // A channel that is on but sends nothing mappable still carries over (it may serve monitors): one empty group.
  return groups.length ? groups : [{ coolifyEvents: [], tugraEvents: [] }];
}

/** Enabled Coolify events Tugra has no event for (known-unmapped and unknown ones), sorted. */
export function unmappedEvents(ch: RawChannel): string[] {
  return [...new Set(ch.events.filter((e) => (COOLIFY_EVENT_MAP[e.event] ?? []).length === 0).map((e) => e.event))].sort();
}

const CHANNEL_LABEL: Record<ChannelKind, string> = { telegram: "Telegram", discord: "Discord", slack: "Slack", pushover: "Pushover", webhook: "Webhook", email: "Email" };

/** The Tugra channel name for one group: stable, so a second run recognises the channel it already created. */
export function channelName(kind: ChannelKind, group: ChannelGroup): string {
  return `${CHANNEL_LABEL[kind]} (Coolify)${group.threadId ? ` - topic ${group.threadId}` : ""}`;
}

// ── shared variables ─────────────────────────────────────────────────────────────────────────────

/** Rows of a shared-variable list (`/team/envs`, `/projects/{uuid}/envs`, ...). Previews carry no value; the value is `real_value ?? value`. */
export function parseSharedRows(rows: unknown, scope: RawSharedVar["scope"], where: { projectRef?: string; projectName?: string; environmentName?: string } = {}): RawSharedVar[] {
  if (!Array.isArray(rows)) return [];
  const out: RawSharedVar[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    const key = typeof r.key === "string" ? r.key : "";
    if (!key || r.is_preview === true) continue;
    const value = typeof r.real_value === "string" ? r.real_value : typeof r.value === "string" ? r.value : undefined;
    out.push({ scope, ...where, key, ...(value !== undefined ? { value } : {}), locked: r.is_shown_once === true });
  }
  return out;
}

// ── S3 / backup storages ─────────────────────────────────────────────────────────────────────────

export function parseStorageRows(rows: unknown): RawStorage[] {
  if (!Array.isArray(rows)) return [];
  const out: RawStorage[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    const ref = str(r.uuid);
    if (!ref) continue;
    out.push({
      ref,
      name: str(r.name) ?? ref,
      type: (str(r.type) ?? "s3").toLowerCase(),
      endpoint: str(r.endpoint) ?? "",
      bucket: str(r.bucket) ?? "",
      region: str(r.region) ?? "",
      skipTlsVerification: r.skip_tls_verification === true,
    });
  }
  return out;
}

// ── scheduled tasks ──────────────────────────────────────────────────────────────────────────────

/** Coolify accepts human aliases next to cron strings; this is its alias table (plus the `@` forms). */
const FREQUENCY_ALIASES: Record<string, string> = {
  every_minute: "* * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  monthly: "0 0 1 * *",
  yearly: "0 0 1 1 *",
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

/** A Coolify frequency as a 5-field cron Tugra can schedule, or null when it is neither an alias nor a valid cron. */
export function cronFromFrequency(frequency: string): string | null {
  const f = frequency.trim().toLowerCase();
  const alias = FREQUENCY_ALIASES[f];
  if (alias) return alias;
  const cron = frequency.trim().replace(/\s+/g, " ");
  return /^(\S+ ){4}\S+$/.test(cron) && isValidCron(cron) ? cron : null;
}

export function parseTaskRows(rows: unknown, resource: { kind: RawTask["resourceKind"]; ref: string; name: string }): RawTask[] {
  if (!Array.isArray(rows)) return [];
  const out: RawTask[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    const ref = str(r.uuid);
    const name = str(r.name);
    const command = typeof r.command === "string" ? r.command : "";
    if (!ref || !name || !command.trim()) continue;
    const timeout = typeof r.timeout === "number" && Number.isFinite(r.timeout) ? Math.trunc(r.timeout) : undefined;
    out.push({
      resourceKind: resource.kind,
      resourceRef: resource.ref,
      resourceName: resource.name,
      ref,
      name,
      command,
      frequency: str(r.frequency) ?? "",
      ...(str(r.container) ? { container: str(r.container) } : {}),
      ...(timeout && timeout >= 1 && timeout <= 3600 ? { timeoutSec: timeout } : {}),
      enabled: r.enabled !== false,
    });
  }
  return out;
}

// ── server cleanup ───────────────────────────────────────────────────────────────────────────────

export function parseCleanup(body: unknown, server: { ref: string; name: string }): RawServerCleanup | null {
  const r = row(body);
  const frequency = str(r.docker_cleanup_frequency);
  if (!frequency) return null;
  const threshold = typeof r.docker_cleanup_threshold === "number" ? Math.trunc(r.docker_cleanup_threshold) : undefined;
  return {
    serverRef: server.ref,
    serverName: server.name,
    frequency,
    ...(threshold && threshold >= 1 && threshold <= 100 ? { thresholdPct: threshold } : {}),
    deleteVolumes: r.delete_unused_volumes === true,
    deleteNetworks: r.delete_unused_networks === true,
    forceCleanup: r.force_docker_cleanup === true,
  };
}

// ── tags ─────────────────────────────────────────────────────────────────────────────────────────

export const parseTagNames = (rows: unknown): string[] => (Array.isArray(rows) ? [...new Set(rows.map((r) => str(obj(r).name)).filter((n): n is string => !!n))] : []);

/** Tag rows of one resource (`GET /applications/{uuid}/tags`) as names. */
export const parseResourceTags = parseTagNames;

export function mergeTags(names: string[], byResource: Array<{ kind: RawTag["resources"][number]["kind"]; ref: string; name: string; tags: string[] }>): RawTag[] {
  const map = new Map<string, RawTag>(names.map((n) => [n, { name: n, resources: [] }]));
  for (const res of byResource) {
    for (const t of res.tags) {
      const tag = map.get(t) ?? { name: t, resources: [] };
      tag.resources.push({ kind: res.kind, ref: res.ref, name: res.name });
      map.set(t, tag);
    }
  }
  return [...map.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── members ──────────────────────────────────────────────────────────────────────────────────────

export function parseMembers(rows: unknown): RawMember[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: RawMember[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    const email = str(r.email)?.toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    const role = str(r.role) ?? str(obj(r.pivot).role);
    out.push({ email, name: str(r.name) ?? email, ...(role ? { role: role.toLowerCase() } : {}) });
  }
  return out;
}

/** The Tugra role a source role suggests. An owner is suggested as ADMIN: ownership is handed over in Tugra, never by an import. */
export function suggestedRole(role: string | undefined): "ADMIN" | "VIEWER" {
  return role === "owner" || role === "admin" ? "ADMIN" : "VIEWER";
}

// ── Tugra provider config ────────────────────────────────────────────────────────────────────────

/** The `config` blob a Tugra channel of this provider type takes, from a source channel's readable secrets (SERVER ONLY). */
export function providerConfig(ch: RawChannel, group: ChannelGroup): Record<string, unknown> {
  const c = ch.config;
  switch (ch.providerType) {
    case "telegram":
      return { botToken: c.botToken, chatId: c.chatId, ...(group.threadId ? { messageThreadId: Number(group.threadId) } : {}) };
    case "smtp":
      return { host: c.host, port: Number(c.port), secure: c.secure === "true", ...(c.user ? { user: c.user } : {}), ...(c.pass ? { pass: c.pass } : {}), from: c.from, to: c.to };
    default:
      return { ...c };
  }
}
