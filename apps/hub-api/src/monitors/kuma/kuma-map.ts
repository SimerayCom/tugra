import {
  DNS_RECORD_TYPES,
  HTTP_METHODS,
  MonitorHeadersSchema,
  StatusRangeSchema,
  type CreateMonitorInput,
} from "../dto";
import { PING_HOST_RE } from "../checkers";
import type { KumaMonitorRow, KumaNotificationRow } from "./kuma-model";

/** A note about something that did not carry over exactly. The web app localizes it from `code`. */
export interface KumaWarning {
  code:
    | "retry_interval" // Kuma retries on its own shorter interval; Tugra retries on the normal interval
    | "cert_expiry" // certificate-expiry alerts are not imported
    | "auth_method" // an auth scheme other than basic (params.method)
    | "headers_dropped" // some headers were invalid or reserved (params.count)
    | "webhook_format" // Tugra sends its own JSON payload, not Kuma's custom body
    | "ntfy_auth"; // ntfy username/password: only an access token is carried
  params?: Record<string, string | number>;
}

export type MonitorDraft = Pick<
  CreateMonitorInput,
  | "name"
  | "type"
  | "target"
  | "intervalSec"
  | "retries"
  | "timeoutMs"
  | "resendEvery"
  | "enabled"
  | "method"
  | "keyword"
  | "keywordInvert"
  | "acceptedStatus"
  | "headers"
  | "basicAuth"
  | "body"
  | "ignoreTls"
  | "maxRedirects"
  | "upsideDown"
  | "dnsRecordType"
  | "dnsServer"
>;

export type MonitorMapping =
  | { ok: true; ref: string; draft: MonitorDraft; warnings: KumaWarning[]; channelRefs: string[] }
  | { ok: false; ref: string; reason: "group" | "type" | "target" | "keyword" | "dns_type"; kumaType: string };

const TYPE_MAP: Record<string, MonitorDraft["type"]> = {
  http: "HTTP",
  keyword: "KEYWORD",
  port: "TCP",
  ping: "PING",
  dns: "DNS",
};

const MIN_INTERVAL = 10;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120_000;

function validHttpUrl(v: string | null): v is string {
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Kuma stores request headers as a JSON object string. Invalid / reserved ones are dropped and counted. */
function mapHeaders(raw: string | null): { headers: Record<string, string> | undefined; dropped: number } {
  if (!raw) return { headers: undefined, dropped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { headers: undefined, dropped: 1 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { headers: undefined, dropped: 1 };
  const out: Record<string, string> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const one = MonitorHeadersSchema.safeParse({ [k]: typeof v === "string" ? v : String(v) });
    if (one.success) Object.assign(out, one.data);
    else dropped++;
  }
  return { headers: Object.keys(out).length ? out : undefined, dropped };
}

export function mapKumaMonitor(k: KumaMonitorRow): MonitorMapping {
  if (k.type === "group") return { ok: false, ref: k.id, reason: "group", kumaType: k.type };
  const type = TYPE_MAP[k.type];
  if (!type) return { ok: false, ref: k.id, reason: "type", kumaType: k.type };

  const warnings: KumaWarning[] = [];
  const intervalSec = Math.max(MIN_INTERVAL, Math.round(k.intervalSec));
  const draft: MonitorDraft = {
    name: k.name.slice(0, 200),
    type,
    target: "",
    intervalSec,
    retries: Math.max(0, Math.min(100, Math.round(k.maxRetries))),
    timeoutMs:
      k.timeoutSec && k.timeoutSec > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(k.timeoutSec * 1000)))
        : 10_000,
    resendEvery: Math.max(0, Math.round(k.resendInterval)),
    enabled: k.active,
    upsideDown: k.upsideDown || undefined,
  };
  if (k.retryIntervalSec != null && Math.round(k.retryIntervalSec) !== Math.round(k.intervalSec) && draft.retries) {
    warnings.push({ code: "retry_interval", params: { seconds: Math.round(k.retryIntervalSec) } });
  }
  if (k.expiryNotification) warnings.push({ code: "cert_expiry" });

  if (type === "HTTP" || type === "KEYWORD") {
    if (!validHttpUrl(k.url)) return { ok: false, ref: k.id, reason: "target", kumaType: k.type };
    draft.target = k.url;
    const method = (k.method ?? "GET").toUpperCase();
    const known = (HTTP_METHODS as readonly string[]).includes(method) ? method : "GET";
    if (known !== "GET") draft.method = known as MonitorDraft["method"]; // GET is the default; keep the row clean
    const accepted = k.acceptedStatuses.filter((s) => StatusRangeSchema.safeParse(s).success);
    if (accepted.length) draft.acceptedStatus = accepted;
    if (k.ignoreTls) draft.ignoreTls = true;
    if (k.maxRedirects !== 10) draft.maxRedirects = Math.max(0, Math.min(20, Math.round(k.maxRedirects)));

    const { headers, dropped } = mapHeaders(k.headersRaw);
    if (dropped) warnings.push({ code: "headers_dropped", params: { count: dropped } });
    const merged: Record<string, string> = { ...(headers ?? {}) };
    if (k.body) {
      draft.body = k.body.slice(0, 65_536);
      const hasType = Object.keys(merged).some((h) => h.toLowerCase() === "content-type");
      if (!hasType) merged["Content-Type"] = k.bodyEncoding?.toLowerCase() === "xml" ? "text/xml" : "application/json";
    }
    if (Object.keys(merged).length) draft.headers = merged;

    const auth = (k.authMethod ?? "").toLowerCase();
    if (auth === "basic" && (k.basicAuthUser || k.basicAuthPass)) {
      draft.basicAuth = { user: k.basicAuthUser ?? "", pass: k.basicAuthPass ?? "" };
    } else if (auth && auth !== "basic") {
      warnings.push({ code: "auth_method", params: { method: auth } });
    }
    if (type === "KEYWORD") {
      if (!k.keyword) return { ok: false, ref: k.id, reason: "keyword", kumaType: k.type };
      draft.keyword = k.keyword.slice(0, 1024);
      if (k.invertKeyword) draft.keywordInvert = true;
    }
  } else if (type === "TCP") {
    if (!k.hostname || !k.port || k.port < 1 || k.port > 65535) return { ok: false, ref: k.id, reason: "target", kumaType: k.type };
    draft.target = `${k.hostname}:${k.port}`;
  } else if (type === "PING") {
    if (!k.hostname || !PING_HOST_RE.test(k.hostname)) return { ok: false, ref: k.id, reason: "target", kumaType: k.type };
    draft.target = k.hostname;
  } else {
    if (!k.hostname) return { ok: false, ref: k.id, reason: "target", kumaType: k.type };
    draft.target = k.hostname;
    const rt = (k.dnsResolveType ?? "A").toUpperCase();
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(rt)) return { ok: false, ref: k.id, reason: "dns_type", kumaType: k.type };
    draft.dnsRecordType = rt as MonitorDraft["dnsRecordType"];
    if (k.dnsResolveServer && /^[0-9a-fA-F:.]+$/.test(k.dnsResolveServer)) draft.dnsServer = k.dnsResolveServer;
  }

  // Drop the keys that stayed undefined so the draft is a clean create body.
  for (const key of Object.keys(draft) as Array<keyof MonitorDraft>) if (draft[key] === undefined) delete draft[key];
  return { ok: true, ref: k.id, draft, warnings, channelRefs: k.notificationIds };
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export type ChannelMapping =
  | { ok: true; ref: string; name: string; kumaType: string; type: string; config: Record<string, unknown>; warnings: KumaWarning[] }
  | { ok: false; ref: string; name: string; kumaType: string; reason: "type" | "incomplete" };

function s(config: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = config[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function n(config: Record<string, unknown>, ...keys: string[]): number | undefined {
  const v = s(config, ...keys);
  if (v === undefined) return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Kuma's own type names -> a function that builds the Tugra channel config (undefined = required field missing). */
type Builder = (c: Record<string, unknown>, warnings: KumaWarning[]) => { type: string; config: Record<string, unknown> } | undefined;

const BUILDERS: Record<string, Builder> = {
  telegram: (c) => {
    const botToken = s(c, "telegramBotToken");
    const chatId = s(c, "telegramChatID");
    if (!botToken || !chatId) return undefined;
    return { type: "telegram", config: compact({ botToken, chatId, messageThreadId: n(c, "telegramMessageThreadID") }) };
  },
  discord: (c) => {
    const webhookUrl = s(c, "discordWebhookUrl");
    return webhookUrl ? { type: "discord", config: { webhookUrl } } : undefined;
  },
  slack: (c) => {
    const webhookUrl = s(c, "slackwebhookURL", "slackWebhookURL");
    return webhookUrl ? { type: "slack", config: { webhookUrl } } : undefined;
  },
  teams: (c) => {
    const webhookUrl = s(c, "webhookUrl", "teamsWebhookUrl");
    return webhookUrl ? { type: "teams", config: { webhookUrl } } : undefined;
  },
  mattermost: (c) => {
    const webhookUrl = s(c, "mattermostWebhookUrl");
    return webhookUrl ? { type: "mattermost", config: { webhookUrl } } : undefined;
  },
  lark: (c) => {
    const webhookUrl = s(c, "larkWebhookUrl", "feishuWebHookUrl");
    return webhookUrl ? { type: "lark", config: { webhookUrl } } : undefined;
  },
  feishu: (c, w) => BUILDERS.lark(c, w),
  webhook: (c, w) => {
    const url = s(c, "webhookURL", "webhookUrl");
    if (!url) return undefined;
    let headers: Record<string, string> | undefined;
    const rawHeaders = s(c, "webhookAdditionalHeaders");
    if (rawHeaders) {
      try {
        const parsed: unknown = JSON.parse(rawHeaders);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const entries = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)] as const);
          const ok = MonitorHeadersSchema.safeParse(Object.fromEntries(entries));
          if (ok.success) headers = ok.data;
        }
      } catch {
        headers = undefined;
      }
    }
    w.push({ code: "webhook_format" });
    return { type: "webhook", config: compact({ url, headers }) };
  },
  ntfy: (c, w) => {
    const topic = s(c, "ntfytopic");
    if (!topic) return undefined;
    const accessToken = s(c, "ntfyaccesstoken", "ntfyAccessToken");
    if (!accessToken && s(c, "ntfyusername")) w.push({ code: "ntfy_auth" });
    return { type: "ntfy", config: compact({ topic, server: s(c, "ntfyserverurl"), priority: n(c, "ntfyPriority"), accessToken }) };
  },
  gotify: (c) => {
    const server = s(c, "gotifyserverurl");
    const token = s(c, "gotifyapplicationToken", "gotifyapplicationtoken");
    if (!server || !token) return undefined;
    return { type: "gotify", config: compact({ server, token, priority: n(c, "gotifyPriority") }) };
  },
  smtp: (c) => {
    const host = s(c, "smtpHost");
    const to = s(c, "smtpTo");
    if (!host || !to) return undefined;
    const secure = c.smtpSecure === true || c.smtpSecure === 1 || c.smtpSecure === "1" || c.smtpSecure === "true";
    return {
      type: "smtp",
      config: compact({ host, port: n(c, "smtpPort"), secure, user: s(c, "smtpUsername"), pass: s(c, "smtpPassword"), from: s(c, "smtpFrom"), to }),
    };
  },
  pushover: (c) => {
    const userKey = s(c, "pushoveruserkey");
    const token = s(c, "pushoverapptoken");
    if (!userKey || !token) return undefined;
    return { type: "pushover", config: compact({ userKey, token, priority: n(c, "pushoverpriority") }) };
  },
};

export function mapKumaNotification(k: KumaNotificationRow): ChannelMapping {
  const kumaType = String(k.config.type ?? "").toLowerCase();
  const builder = BUILDERS[kumaType];
  if (!builder) return { ok: false, ref: k.id, name: k.name, kumaType: kumaType || "unknown", reason: "type" };
  const warnings: KumaWarning[] = [];
  const built = builder(k.config, warnings);
  if (!built) return { ok: false, ref: k.id, name: k.name, kumaType, reason: "incomplete" };
  return { ok: true, ref: k.id, name: k.name.slice(0, 120), kumaType, type: built.type, config: built.config, warnings };
}
