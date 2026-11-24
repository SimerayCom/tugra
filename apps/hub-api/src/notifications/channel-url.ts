/**
 * One-URL channel definitions: turns a Shoutrrr- or Apprise-style notification URL ("tgram://token@telegram?chats=…",
 * "discord://token@id", "ntfy://host/topic", "matrix://user:pw@host/?rooms=…") into a typed channel config.
 * Clean-room (no library): a tiny authority/path/query splitter plus one small mapper per service.
 *
 * Secrets live inside these URLs, so nothing here ever echoes the input: every failure is a
 * {@link ChannelUrlError} carrying a fixed code, and the preview helper masks credentials. Pure — no Nest, no I/O.
 */

export type ChannelUrlErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "missing_field"
  | "invalid_field"
  | "multiple_targets"
  | "unsupported_auth";

/** Thrown for any URL we cannot map. `message` is a fixed, secret-free sentence. */
export class ChannelUrlError extends Error {
  constructor(
    readonly code: ChannelUrlErrorCode,
    readonly field?: string,
  ) {
    super(
      {
        invalid_url: "that is not a notification URL",
        unsupported_scheme: "that URL scheme is not supported",
        missing_field: `the URL is missing ${field ?? "a required part"}`,
        invalid_field: `the URL has an invalid ${field ?? "part"}`,
        multiple_targets: "one channel takes one target; use one URL per target",
        unsupported_auth: "that sign-in form is not supported; use a token or webhook URL",
      }[code],
    );
    this.name = "ChannelUrlError";
  }
}

export interface ParsedChannelUrl {
  type: string;
  config: Record<string, unknown>;
  /** A short default channel name ("Telegram", "ntfy — alerts"); never contains a secret. */
  suggestedName: string;
}

interface Split {
  scheme: string;
  user?: string;
  pass?: string;
  host: string; // host without port (IPv6 brackets stripped)
  port?: string;
  authority: string; // everything between "//" and the first / ? #, userinfo removed, decoded
  path: string[];
  query: URLSearchParams;
  hash: string;
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new ChannelUrlError("invalid_url");
  }
}

/**
 * Split `scheme://[user[:pass]@]authority[/path][?query][#hash]` by hand. The WHATWG parser is unusable here:
 * Apprise's `tgram://123456:ABC-token/chatid` puts a bot token (with a colon) where a host belongs and the
 * parser rejects the non-numeric "port".
 */
export function splitUrl(raw: string): Split {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s.exec(raw.trim());
  if (!m) throw new ChannelUrlError("invalid_url");
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  let hash = "";
  const h = rest.indexOf("#");
  if (h >= 0) {
    hash = dec(rest.slice(h + 1));
    rest = rest.slice(0, h);
  }
  let queryStr = "";
  const q = rest.indexOf("?");
  if (q >= 0) {
    queryStr = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  const slash = rest.indexOf("/");
  const authRaw = slash >= 0 ? rest.slice(0, slash) : rest;
  const pathRaw = slash >= 0 ? rest.slice(slash + 1) : "";
  let user: string | undefined;
  let pass: string | undefined;
  let hostPort = authRaw;
  const at = authRaw.lastIndexOf("@");
  if (at >= 0) {
    const ui = authRaw.slice(0, at);
    hostPort = authRaw.slice(at + 1);
    const c = ui.indexOf(":");
    user = dec(c >= 0 ? ui.slice(0, c) : ui);
    pass = c >= 0 ? dec(ui.slice(c + 1)) : undefined;
  }
  hostPort = dec(hostPort);
  let host = hostPort;
  let port: string | undefined;
  const pm = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(hostPort);
  if (pm) {
    host = pm[1];
    port = pm[2];
  }
  host = host.replace(/^\[|\]$/g, "");
  const path = pathRaw.split("/").filter(Boolean).map(dec);
  return { scheme, user, pass, host, port, authority: hostPort, path, query: new URLSearchParams(queryStr), hash };
}

const hostPort = (s: Split): string => (s.port ? `${s.host.includes(":") ? `[${s.host}]` : s.host}:${s.port}` : s.host.includes(":") ? `[${s.host}]` : s.host);

function need(v: string | undefined | null, field: string): string {
  if (!v) throw new ChannelUrlError("missing_field", field);
  return v;
}

function match(v: string, re: RegExp, field: string): string {
  if (!re.test(v)) throw new ChannelUrlError("invalid_field", field);
  return v;
}

const q = (s: Split, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = s.query.get(n);
    if (v) return v;
  }
  return undefined;
};

/** https unless the URL explicitly asks for plain http (`?scheme=http`, `?disableTLS=yes`). Secure by default. */
function httpScheme(s: Split, secureScheme = false): "http" | "https" {
  if (secureScheme) return "https";
  const sch = q(s, "scheme")?.toLowerCase();
  if (sch === "http") return "http";
  const dis = q(s, "disableTLS", "disabletls")?.toLowerCase();
  if (dis === "yes" || dis === "true" || dis === "1") return "http";
  return "https";
}

const NTFY_PRIORITY: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };

function priorityNum(v: string | undefined, min: number, max: number): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ChannelUrlError("invalid_field", "priority");
  return n;
}

// ---- per-service mappers ----

const TELEGRAM_TOKEN = /^\d{3,}:[A-Za-z0-9_-]{10,}$/;
const TELEGRAM_CHAT = /^(@[A-Za-z0-9_]{4,}|-?\d{1,20})$/;

function telegram(s: Split): ParsedChannelUrl {
  // Shoutrrr: telegram://token@telegram?chats=…   Apprise: tgram://token/chatid[/chatid…]
  const token = s.user != null ? (s.pass != null ? `${s.user}:${s.pass}` : s.user) : s.authority;
  match(need(token, "the bot token"), TELEGRAM_TOKEN, "bot token");
  const chats = [
    ...(q(s, "chats", "channels")?.split(",") ?? []),
    ...(s.user == null ? s.path : []),
  ].map((c) => c.trim()).filter(Boolean);
  if (chats.length === 0) throw new ChannelUrlError("missing_field", "a chat");
  if (chats.length > 1) throw new ChannelUrlError("multiple_targets");
  // Shoutrrr also writes a forum topic inline as "chatId:threadId".
  const sep = chats[0].indexOf(":");
  const chatId = match(sep > 0 ? chats[0].slice(0, sep) : chats[0], TELEGRAM_CHAT, "chat");
  const config: Record<string, unknown> = { botToken: token, chatId };
  const thread = (sep > 0 ? chats[0].slice(sep + 1) : undefined) ?? q(s, "topic", "thread", "threads", "message_thread_id");
  if (thread) {
    if (!/^\d{1,10}$/.test(thread) || Number(thread) < 1) throw new ChannelUrlError("invalid_field", "topic");
    config.messageThreadId = Number(thread);
  }
  return { type: "telegram", config, suggestedName: "Telegram" };
}

function discord(s: Split): ParsedChannelUrl {
  // Shoutrrr: discord://token@webhookid   Apprise: discord://webhookid/token
  const [id, token] = s.user != null ? [s.authority, s.user] : [s.authority, s.path[0]];
  match(need(id, "the webhook id"), /^\d{5,25}$/, "webhook id");
  match(need(token, "the webhook token"), /^[A-Za-z0-9_-]{10,}$/, "webhook token");
  const thread = q(s, "thread_id");
  if (thread && !/^\d{1,25}$/.test(thread)) throw new ChannelUrlError("invalid_field", "thread");
  return {
    type: "discord",
    config: { webhookUrl: `https://discord.com/api/webhooks/${id}/${token}${thread ? `?thread_id=${thread}` : ""}` },
    suggestedName: "Discord",
  };
}

function slack(s: Split): ParsedChannelUrl {
  const tok = /^[A-Za-z0-9]{6,}$/;
  let a: string | undefined;
  let b: string | undefined;
  let c: string | undefined;
  if (s.user === "hook" && s.pass) {
    // Shoutrrr: slack://hook:T…-B…-X…@webhook
    [a, b, c] = s.pass.split("-");
  } else if (s.user === "xoxb" || s.user === "xoxp" || s.user === "xoxa") {
    throw new ChannelUrlError("unsupported_auth"); // bot/user tokens need chat.postMessage, not a webhook
  } else {
    // Apprise: slack://[botname@]A/B/C
    [a, b, c] = [s.authority, s.path[0], s.path[1]];
  }
  match(need(a, "the first token"), tok, "token");
  match(need(b, "the second token"), tok, "token");
  match(need(c, "the third token"), tok, "token");
  return { type: "slack", config: { webhookUrl: `https://hooks.slack.com/services/${a}/${b}/${c}` }, suggestedName: "Slack" };
}

function ntfy(s: Split, secure: boolean): ParsedChannelUrl {
  const topicRe = /^[A-Za-z0-9_-]{1,64}$/;
  let server: string;
  let topic: string;
  if (s.path.length === 0) {
    // Apprise: ntfy://topic (the hosted ntfy.sh)
    topic = match(s.authority, topicRe, "topic");
    server = "https://ntfy.sh";
  } else {
    topic = match(s.path[s.path.length - 1], topicRe, "topic");
    const base = s.path.slice(0, -1).map(encodeURIComponent).join("/");
    server = `${httpScheme(s, secure)}://${hostPort(s)}${base ? `/${base}` : ""}`;
  }
  const config: Record<string, unknown> = { server, topic };
  const prio = q(s, "priority");
  if (prio) {
    const n = NTFY_PRIORITY[prio.toLowerCase()] ?? priorityNum(prio, 1, 5);
    if (n) config.priority = n;
  }
  if (s.user != null && s.pass != null) {
    config.username = s.user;
    config.password = s.pass;
  } else if (s.user) {
    config.accessToken = s.user;
  }
  return { type: "ntfy", config, suggestedName: `ntfy — ${topic}` };
}

function pushover(s: Split, appriseOrder: boolean): ParsedChannelUrl {
  // Shoutrrr: pushover://shoutrrr:apiToken@userKey   Apprise: pover://userKey@apiToken
  const key = /^[A-Za-z0-9]{10,40}$/;
  const [userKey, token] = appriseOrder ? [s.user, s.authority] : [s.authority, s.pass];
  match(need(userKey, "the user key"), key, "user key");
  match(need(token, "the API token"), key, "API token");
  const config: Record<string, unknown> = { token, userKey };
  const prio = priorityNum(q(s, "priority"), -2, 2);
  if (prio !== undefined) config.priority = prio;
  return { type: "pushover", config, suggestedName: "Pushover" };
}

function matrix(s: Split, secure: boolean): ParsedChannelUrl {
  const rooms = [
    ...(q(s, "rooms", "room")?.split(",") ?? []),
    ...s.path.filter((p) => p.startsWith("!") || p.startsWith("#")),
    ...(s.hash ? s.hash.split("/").map((r) => (/^[#!]/.test(r) ? r : `#${r}`)) : []),
  ].map((r) => r.trim()).filter(Boolean);
  if (rooms.length === 0) throw new ChannelUrlError("missing_field", "a room");
  if (rooms.length > 1) throw new ChannelUrlError("multiple_targets");
  const room = match(rooms[0], /^[#!][^\s:]+:[A-Za-z0-9.:-]+$/, "room");
  const config: Record<string, unknown> = {
    homeserver: `${httpScheme(s, secure)}://${hostPort(s)}`,
    roomId: room,
  };
  if (s.user != null && s.pass != null) {
    config.user = s.user;
    config.password = s.pass;
  } else if (s.user) {
    config.accessToken = s.user;
  } else {
    throw new ChannelUrlError("missing_field", "a user or access token");
  }
  return { type: "matrix", config, suggestedName: "Matrix" };
}

function gotify(s: Split, secure: boolean): ParsedChannelUrl {
  if (s.path.length === 0) throw new ChannelUrlError("missing_field", "the app token");
  const token = match(s.path[s.path.length - 1], /^[A-Za-z0-9_.-]{8,}$/, "app token");
  const base = s.path.slice(0, -1).map(encodeURIComponent).join("/");
  const config: Record<string, unknown> = {
    server: `${httpScheme(s, secure)}://${hostPort(s)}${base ? `/${base}` : ""}`,
    token,
  };
  const prio = priorityNum(q(s, "priority"), 0, 10);
  if (prio !== undefined) config.priority = prio;
  return { type: "gotify", config, suggestedName: "Gotify" };
}

function bark(s: Split, secure: boolean): ParsedChannelUrl {
  // Shoutrrr: bark://:devicekey@host   Apprise: bark://devicekey@host or bark://host/devicekey
  const deviceKey = s.pass || s.user || s.path[0];
  match(need(deviceKey, "the device key"), /^[A-Za-z0-9_-]{6,64}$/, "device key");
  const config: Record<string, unknown> = { server: `${httpScheme(s, secure)}://${hostPort(s)}`, deviceKey };
  const group = q(s, "group");
  if (group) config.group = group.slice(0, 64);
  return { type: "bark", config, suggestedName: "Bark" };
}

function zulip(s: Split): ParsedChannelUrl {
  const stream = need(q(s, "stream", "to"), "the stream");
  const topic = q(s, "topic");
  let email: string;
  let apiKey: string;
  let server: string;
  if (s.user && s.user.includes("@") && s.pass) {
    // Shoutrrr: zulip://bot-mail:bot-key@host/?stream=…&topic=…  (the @ in the mail is percent-encoded)
    email = s.user;
    apiKey = s.pass;
    server = `https://${hostPort(s)}`;
  } else if (s.user) {
    // Apprise: zulip://botname@organization/token
    apiKey = need(s.path[0], "the API key");
    const dom = s.host.includes(".") ? s.host : `${s.host}.zulipchat.com`;
    email = `${s.user}-bot@${dom}`;
    server = `https://${dom}`;
  } else {
    throw new ChannelUrlError("missing_field", "the bot name");
  }
  match(email, /^[^\s@]+@[^\s@]+$/, "bot email");
  match(apiKey, /^[A-Za-z0-9]{8,64}$/, "API key");
  return {
    type: "zulip",
    config: { server, email, apiKey, stream, ...(topic ? { topic } : {}) },
    suggestedName: `Zulip — ${stream}`,
  };
}

function opsgenie(s: Split): ParsedChannelUrl {
  const key = /^[A-Za-z0-9-]{16,64}$/;
  // Apprise: opsgenie://apikey   Shoutrrr: opsgenie://host/apikey
  const apiKey = s.path.length ? s.path[0] : s.authority;
  match(need(apiKey, "the API key"), key, "API key");
  const eu = s.path.length ? /\.eu\./.test(s.host) : q(s, "region")?.toLowerCase() === "eu";
  return { type: "opsgenie", config: { apiKey, region: eu ? "eu" : "us" }, suggestedName: "Opsgenie" };
}

function pagerduty(s: Split): ParsedChannelUrl {
  // Apprise: pagerduty://integrationKey@apikey  — only the Events v2 routing (integration) key is needed.
  const routingKey = s.user || s.authority;
  match(need(routingKey, "the integration key"), /^[A-Za-z0-9]{16,64}$/, "integration key");
  return { type: "pagerduty", config: { routingKey }, suggestedName: "PagerDuty" };
}

function googlechat(s: Split): ParsedChannelUrl {
  if (s.host.toLowerCase() === "chat.googleapis.com") {
    // Shoutrrr: googlechat://chat.googleapis.com/v1/spaces/FOO/messages?key=bar&token=baz
    if (s.path[0] !== "v1" || s.path[1] !== "spaces" || !s.path[2] || s.path[3] !== "messages") throw new ChannelUrlError("invalid_field", "path");
    const key = need(q(s, "key"), "the key");
    const token = need(q(s, "token"), "the token");
    const ok = /^[A-Za-z0-9_-]+$/;
    match(s.path[2], ok, "space");
    match(key, ok, "key");
    match(token, ok, "token");
    return {
      type: "googlechat",
      config: { webhookUrl: `https://chat.googleapis.com/v1/spaces/${s.path[2]}/messages?key=${key}&token=${token}` },
      suggestedName: "Google Chat",
    };
  }
  // Apprise: gchat://workspace/key/token
  const [space, key, token] = [s.authority, s.path[0], s.path[1]];
  const ok = /^[A-Za-z0-9_-]+$/;
  match(need(space, "the space"), ok, "space");
  match(need(key, "the key"), ok, "key");
  match(need(token, "the token"), ok, "token");
  return {
    type: "googlechat",
    config: { webhookUrl: `https://chat.googleapis.com/v1/spaces/${space}/messages?key=${key}&token=${token}` },
    suggestedName: "Google Chat",
  };
}

function rocketchat(s: Split, secure: boolean): ParsedChannelUrl {
  // Shoutrrr: rocketchat://[user@]host[:port]/tokenA/tokenB[/channel]
  if (s.pass != null) throw new ChannelUrlError("unsupported_auth");
  const ok = /^[A-Za-z0-9_-]{8,}$/;
  match(need(s.path[0], "the webhook token"), ok, "webhook token");
  match(need(s.path[1], "the webhook token"), ok, "webhook token");
  return {
    type: "rocketchat",
    config: { webhookUrl: `${httpScheme(s, secure)}://${hostPort(s)}/hooks/${s.path[0]}/${s.path[1]}` },
    suggestedName: "Rocket.Chat",
  };
}

function mattermost(s: Split, secure: boolean): ParsedChannelUrl {
  // Shoutrrr: mattermost://[user@]host[:port]/token[/channel]
  const token = match(need(s.path[0], "the webhook token"), /^[A-Za-z0-9_-]{8,}$/, "webhook token");
  return {
    type: "mattermost",
    config: { webhookUrl: `${httpScheme(s, secure)}://${hostPort(s)}/hooks/${token}` },
    suggestedName: "Mattermost",
  };
}

const PHONE = /^\+?[0-9]{6,15}$/;

function twilio(s: Split): ParsedChannelUrl {
  // Apprise: twilio://AccountSID:AuthToken@FromPhone/ToPhone
  const sid = match(need(s.user, "the account SID"), /^AC[A-Fa-f0-9]{32}$/, "account SID");
  const authToken = match(need(s.pass, "the auth token"), /^[A-Za-z0-9]{16,64}$/, "auth token");
  const from = need(s.authority, "the sender");
  if (!PHONE.test(from) && !/^MG[A-Fa-f0-9]{32}$/.test(from)) throw new ChannelUrlError("invalid_field", "sender");
  if (s.path.length === 0) throw new ChannelUrlError("missing_field", "a recipient");
  if (s.path.length > 1) throw new ChannelUrlError("multiple_targets");
  const to = match(s.path[0], PHONE, "recipient");
  return {
    type: "sms",
    config: { accountSid: sid, authToken, from, to },
    suggestedName: "SMS (Twilio)",
  };
}

function signal(s: Split, secure: boolean): ParsedChannelUrl {
  // Apprise: signal://host[:port]/FromPhone/ToPhone[/ToPhone…] (a signal-cli REST API)
  const [from, ...to] = s.path;
  match(need(from, "the sender number"), /^\+[0-9]{6,15}$/, "sender number");
  if (to.length === 0) throw new ChannelUrlError("missing_field", "a recipient");
  for (const r of to) match(r, /^(\+[0-9]{6,15}|group\.[A-Za-z0-9+/=_-]+)$/, "recipient");
  return {
    type: "signal",
    config: { server: `${secure ? "https" : q(s, "scheme")?.toLowerCase() === "https" ? "https" : "http"}://${hostPort(s)}`, number: from, recipients: to.join(",") },
    suggestedName: "Signal",
  };
}

function generic(s: Split, secure: boolean): ParsedChannelUrl {
  need(s.host, "the host");
  const path = s.path.map(encodeURIComponent).join("/");
  return {
    type: "webhook",
    config: { url: `${httpScheme(s, secure)}://${hostPort(s)}${path ? `/${path}` : ""}` },
    suggestedName: "Webhook",
  };
}

/** Webhook URLs pasted as-is: recognise the three vendors whose URL alone identifies the service. */
function fromHttpUrl(raw: string): ParsedChannelUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (u.username || u.password) return null;
  if ((host === "discord.com" || host === "discordapp.com") && u.pathname.startsWith("/api/webhooks/")) {
    return { type: "discord", config: { webhookUrl: u.toString() }, suggestedName: "Discord" };
  }
  if (host === "hooks.slack.com" && u.pathname.startsWith("/services/")) {
    return { type: "slack", config: { webhookUrl: u.toString() }, suggestedName: "Slack" };
  }
  if (host === "chat.googleapis.com" && u.pathname.startsWith("/v1/spaces/")) {
    return { type: "googlechat", config: { webhookUrl: u.toString() }, suggestedName: "Google Chat" };
  }
  return null;
}

/** The schemes {@link parseChannelUrl} understands (for docs / the UI hint). */
export const CHANNEL_URL_SCHEMES = [
  "tgram", "telegram", "discord", "slack", "ntfy", "ntfys", "pushover", "pover", "matrix", "matrixs", "gotify", "gotifys",
  "bark", "barks", "zulip", "opsgenie", "pagerduty", "pd", "googlechat", "gchat", "rocketchat", "rocket", "rockets",
  "mattermost", "mmost", "twilio", "signal", "signals", "json", "jsons", "generic",
] as const;

/**
 * Map one Shoutrrr/Apprise-style URL to `{ type, config }`. Throws {@link ChannelUrlError} (never echoing the
 * input) for anything malformed or unsupported. The caller still validates the config (SSRF, per-type schema).
 */
export function parseChannelUrl(raw: string): ParsedChannelUrl {
  const input = raw.trim();
  if (!input || input.length > 2048 || /[\r\n\t ]/.test(input)) throw new ChannelUrlError("invalid_url");
  if (/^https?:\/\//i.test(input)) {
    const hit = fromHttpUrl(input);
    if (hit) return hit;
    throw new ChannelUrlError("unsupported_scheme");
  }
  const s = splitUrl(input);
  switch (s.scheme) {
    case "tgram":
    case "telegram":
      return telegram(s);
    case "discord":
      return discord(s);
    case "slack":
      return slack(s);
    case "ntfy":
      return ntfy(s, false);
    case "ntfys":
      return ntfy(s, true);
    case "pushover":
      return pushover(s, false);
    case "pover":
      return pushover(s, true);
    case "matrix":
      return matrix(s, false);
    case "matrixs":
      return matrix(s, true);
    case "gotify":
      return gotify(s, false);
    case "gotifys":
      return gotify(s, true);
    case "bark":
      return bark(s, false);
    case "barks":
      return bark(s, true);
    case "zulip":
      return zulip(s);
    case "opsgenie":
      return opsgenie(s);
    case "pagerduty":
    case "pd":
      return pagerduty(s);
    case "googlechat":
    case "gchat":
      return googlechat(s);
    case "rocketchat":
    case "rocket":
      return rocketchat(s, false);
    case "rockets":
      return rocketchat(s, true);
    case "mattermost":
    case "mmost":
      return mattermost(s, false);
    case "twilio":
      return twilio(s);
    case "signal":
      return signal(s, false);
    case "signals":
      return signal(s, true);
    case "json":
    case "generic":
      return generic(s, false);
    case "jsons":
      return generic(s, true);
    default:
      throw new ChannelUrlError("unsupported_scheme");
  }
}

// ---- preview (never reveals a credential) ----

const SECRET_KEYS = new Set([
  "botToken", "token", "accessToken", "password", "apiKey", "routingKey", "authToken", "deviceKey", "userKey", "signingSecret", "pass",
]);
const URL_KEYS = new Set(["webhookUrl", "url"]);

/**
 * A display-safe view of a parsed config: credentials become "••••", webhook URLs (whose path carries the
 * token) collapse to their origin. Safe to return from the API and show in the UI.
 */
export function previewConfig(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v == null || v === "") continue;
    if (SECRET_KEYS.has(k)) out[k] = "••••";
    else if (URL_KEYS.has(k)) {
      try {
        out[k] = new URL(String(v)).origin;
      } catch {
        out[k] = "••••";
      }
    } else out[k] = String(v);
  }
  return out;
}
