/**
 * Shoutrrr-style notification URLs (the format Beszel stores for a user's webhooks, e.g. `telegram://TOKEN@telegram?chats=ID`)
 * mapped onto Tugra notification channels. Clean-room: written from the documented URL shapes, no library. Pure and
 * synchronous; the channel config it returns carries secrets, so it is only ever handed to the channel service, while the
 * caller shows {@link ParsedChannel.label} (which never contains a token) in the preview.
 */

export type ChannelNoteCode = "genericPayload" | "multipleChats";
export type ChannelSkipReason = "invalidUrl" | "unsupportedService" | "unsupportedAuth" | "unsupportedBot";

export interface ParsedChannel {
  /** Shoutrrr scheme as written (lowercased), e.g. "telegram". */
  service: string;
  /** Human target without any secret, e.g. "chat @ops" or "hooks.example.com". */
  label: string;
  /** The Tugra channel type, or null when the service is not carried. */
  type: string | null;
  config: Record<string, unknown>;
  reason?: ChannelSkipReason;
  notes: ChannelNoteCode[];
}

const SKIP = (service: string, reason: ChannelSkipReason, label = ""): ParsedChannel => ({ service, label, type: null, config: {}, reason, notes: [] });
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const yes = (v: string | null): boolean => v != null && ["yes", "true", "1"].includes(v.toLowerCase());

/** Parse one URL into one channel (telegram with several chats yields one entry per chat, hence the array). */
export function parseShoutrrr(raw: string): ParsedChannel[] {
  const text = raw.trim();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
  if (!m) return [SKIP("", "invalidUrl")];
  const scheme = m[1].toLowerCase();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return [SKIP(scheme, "invalidUrl")];
  }
  const user = dec(u.username);
  const pass = dec(u.password);
  const host = u.host; // keeps the port
  const segs = u.pathname.split("/").filter(Boolean).map(dec);
  const q = u.searchParams;

  switch (scheme) {
    case "discord": {
      // discord://TOKEN@WEBHOOKID[?thread_id=…]
      if (!user || !host) return [SKIP(scheme, "invalidUrl")];
      const thread = q.get("thread_id");
      const url = `https://discord.com/api/webhooks/${encodeURIComponent(host)}/${encodeURIComponent(user)}${thread ? `?thread_id=${encodeURIComponent(thread)}` : ""}`;
      return [{ service: scheme, label: `webhook ${host}`, type: "discord", config: { webhookUrl: url }, notes: [] }];
    }
    case "slack": {
      // Incoming webhook only: slack://hook:T-B-X@webhook  or  slack://[bot@]T/B/X
      let parts: string[] | null = null;
      if (user === "hook" && pass) parts = pass.split("-");
      else if (host && segs.length === 2) parts = [dec(host), segs[0], segs[1]];
      if (!parts || parts.length !== 3 || parts.some((p) => !p)) return [SKIP(scheme, "unsupportedBot")]; // a bot token (xoxb) is not a webhook
      return [{ service: scheme, label: "incoming webhook", type: "slack", config: { webhookUrl: `https://hooks.slack.com/services/${parts.map(encodeURIComponent).join("/")}` }, notes: [] }];
    }
    case "telegram": {
      // telegram://BOT_ID:BOT_TOKEN@telegram?chats=@name,123[&threads=…]
      const botToken = pass ? `${user}:${pass}` : "";
      const chats = (q.get("chats") ?? q.get("channels") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
      if (!botToken || chats.length === 0) return [SKIP(scheme, "invalidUrl")];
      return chats.map((chat) => {
        const sep = chat.indexOf(":"); // "chatId:threadId"
        const chatId = sep > 0 ? chat.slice(0, sep) : chat;
        const thread = sep > 0 ? Number(chat.slice(sep + 1)) : NaN;
        return {
          service: scheme,
          label: `chat ${chatId}`,
          type: "telegram",
          config: { botToken, chatId, ...(Number.isFinite(thread) ? { messageThreadId: thread } : {}) },
          notes: chats.length > 1 ? (["multipleChats"] as ChannelNoteCode[]) : [],
        };
      });
    }
    case "ntfy": {
      // ntfy://[user:pass@]host[:port]/topic[?scheme=http]
      const topic = segs[0];
      if (!host || !topic) return [SKIP(scheme, "invalidUrl")];
      if (user || pass) return [SKIP(scheme, "unsupportedAuth", `${host}/${topic}`)];
      const proto = (q.get("scheme") ?? "https").toLowerCase() === "http" ? "http" : "https";
      return [{ service: scheme, label: `${host}/${topic}`, type: "ntfy", config: { server: `${proto}://${host}`, topic }, notes: [] }];
    }
    case "gotify": {
      // gotify://host[:port][/path]/TOKEN[?disabletls=yes]
      if (!host || segs.length === 0) return [SKIP(scheme, "invalidUrl")];
      const token = segs[segs.length - 1];
      const path = segs.slice(0, -1).map(encodeURIComponent).join("/");
      const proto = yes(q.get("disabletls")) ? "http" : "https";
      return [{ service: scheme, label: host, type: "gotify", config: { server: `${proto}://${host}${path ? `/${path}` : ""}`, token }, notes: [] }];
    }
    case "pushover": {
      // pushover://shoutrrr:APITOKEN@USERKEY[/?devices=…]
      if (!pass || !host) return [SKIP(scheme, "invalidUrl")];
      return [{ service: scheme, label: "pushover", type: "pushover", config: { token: pass, userKey: dec(host) }, notes: [] }];
    }
    case "mattermost": {
      // mattermost://[user@]host[:port]/TOKEN[/channel]
      if (!host || segs.length === 0) return [SKIP(scheme, "invalidUrl")];
      const proto = yes(q.get("disabletls")) ? "http" : "https";
      return [{ service: scheme, label: host, type: "mattermost", config: { webhookUrl: `${proto}://${host}/hooks/${encodeURIComponent(segs[0])}` }, notes: [] }];
    }
    case "teams": {
      // teams://GROUP@TENANT/ALTID/GROUPOWNER?host=org.webhook.office.com
      const tenant = dec(host);
      const hookHost = q.get("host");
      if (!user || !tenant || segs.length < 2 || !hookHost) return [SKIP(scheme, "invalidUrl")];
      const url = `https://${hookHost}/webhookb2/${encodeURIComponent(user)}@${encodeURIComponent(tenant)}/IncomingWebhook/${encodeURIComponent(segs[0])}/${encodeURIComponent(segs[1])}`;
      return [{ service: scheme, label: hookHost, type: "teams", config: { webhookUrl: url }, notes: [] }];
    }
    case "lark": {
      // lark://open.larksuite.com/TOKEN
      if (!host || segs.length === 0) return [SKIP(scheme, "invalidUrl")];
      return [{ service: scheme, label: host, type: "lark", config: { webhookUrl: `https://${host}/open-apis/bot/v2/hook/${encodeURIComponent(segs[0])}` }, notes: [] }];
    }
    case "smtp": {
      // smtp://user:pass@host:port/?from=a@b&to=c@d
      const to = q.get("toaddresses") ?? q.get("to");
      if (!host || !to) return [SKIP(scheme, "invalidUrl")];
      const port = u.port ? Number(u.port) : 587;
      const enc = (q.get("encryption") ?? "").toLowerCase();
      const secure = enc === "implicittls" || (enc === "" && port === 465);
      const from = q.get("fromaddress") ?? q.get("from") ?? user;
      return [
        {
          service: scheme,
          label: host,
          type: "smtp",
          config: { host: u.hostname, port, secure, ...(user ? { user, pass } : {}), ...(from ? { from } : {}), to },
          notes: [],
        },
      ];
    }
    default:
      break;
  }

  if (scheme === "generic" || scheme.startsWith("generic+")) {
    // generic://host/path?disabletls=yes  |  generic+https://host/path  — every query key that is not a shoutrrr setting stays.
    const proto = scheme === "generic" ? (yes(q.get("disabletls")) ? "http" : "https") : scheme.slice("generic+".length);
    if (proto !== "http" && proto !== "https") return [SKIP(scheme, "unsupportedService")];
    if (!host) return [SKIP(scheme, "invalidUrl")];
    const settings = new Set(["template", "messagekey", "titlekey", "method", "contenttype", "requestmethod", "disabletls", "title", "json"]);
    const headers: Record<string, string> = {};
    const keep = new URLSearchParams();
    for (const [k, v] of q) {
      if (k.startsWith("@")) headers[k.slice(1)] = v; // @Header=value (shoutrrr custom headers)
      else if (k.startsWith("$")) continue; // $extra JSON field
      else if (!settings.has(k.toLowerCase())) keep.append(k, v);
    }
    const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ""}@` : "";
    const qs = keep.toString();
    const url = `${proto}://${auth}${host}${u.pathname}${qs ? `?${qs}` : ""}`;
    return [
      {
        service: "generic",
        label: host,
        type: "webhook",
        config: { url, ...(Object.keys(headers).length ? { headers } : {}) },
        notes: ["genericPayload"],
      },
    ];
  }
  return [SKIP(scheme, "unsupportedService", host)];
}
