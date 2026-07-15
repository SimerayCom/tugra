/**
 * Notification providers — abstract base + a registry, after Uptime Kuma's pattern. Each provider
 * renders a RenderedMessage into its NATIVE rich format; config is a free JSON blob so adding a
 * provider (or a config field) needs zero DB migration. Most providers are fetch-based; SMTP uses
 * nodemailer.
 */
import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import {
  escapeHtml,
  fieldsAsLines,
  levelColorHex,
  levelColorInt,
  levelPriority,
  levelPriorityGotify,
  levelPriorityPushover,
  levelTag,
  sanitizeHeader,
  sanitizeNtfyHeader,
  toPlain,
  type MsgLevel,
  type RenderedMessage,
} from "./rendered-message";
import { allowPrivateTargets, safeSend } from "./safe-url";

export type ChannelConfig = Record<string, unknown>;

/** Read a numeric config field; missing/empty-string → undefined (a blank web field must NOT read as 0). */
function numCfg(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Hard-truncate to a provider length limit (no ellipsis). */
function clampLen(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Provider-specific NAMED color vocabularies (Teams AdaptiveCard / Lark card) — deliberately NOT in the
// hex PALETTE, whose contract is one hex per level.
const TEAMS_COLOR: Record<MsgLevel, string> = { success: "good", failure: "attention", warning: "warning", info: "default" };
const LARK_COLOR: Record<MsgLevel, string> = { success: "green", failure: "red", warning: "orange", info: "blue" };

/**
 * Headers a user's custom-header map may never set: the ones we control (content-type + signature) and
 * the request-framing / hop-by-hop headers (content-length, transfer-encoding, connection, host) — a
 * user-supplied Content-Length/Transfer-Encoding would desync the body and enable request smuggling.
 */
const RESERVED_HEADERS = new Set([
  "content-type",
  "x-tugra-signature",
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
]);
/** RFC 7230 header field-name token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Merge user-supplied `config.headers` into `base`, defensively: skip non-string values, invalid
 * names, reserved names, and any value containing CR/LF (header injection). A second line of defense
 * even if create-time DTO validation was somehow bypassed.
 */
function mergeCustomHeaders(base: Record<string, string>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (!HEADER_NAME.test(k)) continue;
    if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
    if (/[\r\n]/.test(v)) continue;
    base[k] = v;
  }
}

export abstract class NotificationProvider {
  abstract readonly type: string;
  abstract send(config: ChannelConfig, msg: RenderedMessage): Promise<void>;

  protected async postJson(url: string, body: unknown): Promise<void> {
    // Route through the SSRF-guarded, IP-pinned transport (no redirect follow) instead of raw fetch.
    await safeSend(url, JSON.stringify(body), { "content-type": "application/json" }, { allowPrivate: allowPrivateTargets() });
  }
}

class WebhookProvider extends NotificationProvider {
  readonly type = "webhook";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    // Serialize ONCE: the HMAC must be over the exact bytes on the wire (postJson would re-stringify).
    const body = JSON.stringify({
      version: 1,
      event: msg.event,
      level: msg.level,
      title: msg.title,
      summary: msg.summary,
      fields: msg.fields,
      links: msg.links,
      timestamp: msg.timestamp,
    });
    const headers: Record<string, string> = {};
    mergeCustomHeaders(headers, config.headers); // user headers first...
    headers["content-type"] = "application/json"; // ...reserved headers set LAST so they always win
    const secret = typeof config.signingSecret === "string" ? config.signingSecret : "";
    if (secret) {
      headers["X-Tugra-Signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    }
    await safeSend(String(config.url), body, headers, { allowPrivate: allowPrivateTargets() });
  }
}

class TelegramProvider extends NotificationProvider {
  readonly type = "telegram";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const lines = msg.fields.map((f) => `${escapeHtml(f.label)}: ${escapeHtml(f.value)}`).join("\n");
    const text = `<b>${escapeHtml(msg.title)}</b>\n\n${escapeHtml(msg.summary)}${lines ? "\n\n" + lines : ""}`;
    const body: Record<string, unknown> = {
      chat_id: String(config.chatId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (msg.links.length) body.reply_markup = { inline_keyboard: [msg.links.map((l) => ({ text: l.label, url: l.url }))] };
    if (config.messageThreadId != null) body.message_thread_id = Number(config.messageThreadId);
    await this.postJson(`https://api.telegram.org/bot${String(config.botToken)}/sendMessage`, body);
  }
}

class NtfyProvider extends NotificationProvider {
  readonly type = "ntfy";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const server = String(config.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const asciiTitle = sanitizeNtfyHeader(msg.title);
    const headers: Record<string, string> = {
      "X-Priority": String(config.priority ?? levelPriority(msg.level)),
      "X-Tags": levelTag(msg.level),
    };
    if (asciiTitle) headers["X-Title"] = asciiTitle;
    if (msg.links.length) {
      // Sanitize BOTH parts: a newline in the label/url would inject an extra header, and `,`/`;` are
      // ntfy's action field/entry delimiters — a crafted label must not split into extra actions.
      headers["X-Actions"] = msg.links
        .map((l) => `view, ${sanitizeNtfyHeader(l.label).replace(/[,;]/g, " ")}, ${sanitizeNtfyHeader(l.url)}`)
        .join("; ");
    }
    if (config.accessToken) headers["Authorization"] = `Bearer ${String(config.accessToken)}`;
    // Lossless: if the ASCII header couldn't carry the full (unicode) title, put it in the body.
    const bodyTitle = asciiTitle === msg.title ? "" : msg.title;
    const body = [bodyTitle, msg.summary, fieldsAsLines(msg.fields)].filter(Boolean).join("\n\n");
    await safeSend(`${server}/${String(config.topic)}`, body, headers, { allowPrivate: allowPrivateTargets() });
  }
}

class DiscordProvider extends NotificationProvider {
  readonly type = "discord";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const links = msg.links.map((l) => `[${l.label}](${l.url})`).join(" · ");
    const body: Record<string, unknown> = {
      embeds: [
        {
          title: msg.title,
          description: links ? `${msg.summary}\n\n${links}` : msg.summary,
          color: levelColorInt(msg.level),
          fields: msg.fields.map((f) => ({ name: f.label, value: f.value, inline: !!f.inline })),
          footer: { text: "Tugra" },
          timestamp: msg.timestamp,
        },
      ],
      ...(msg.critical ? { content: "@here" } : {}),
    };
    await this.postJson(String(config.webhookUrl), body);
  }
}

class SlackProvider extends NotificationProvider {
  readonly type = "slack";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const links = msg.links.map((l) => `<${l.url}|${l.label}>`).join(" · ");
    await this.postJson(String(config.webhookUrl), {
      attachments: [
        {
          color: levelColorHex(msg.level),
          pretext: msg.title,
          text: links ? `${msg.summary}\n${links}` : msg.summary,
          fields: msg.fields.map((f) => ({ title: f.label, value: f.value, short: !!f.inline })),
          mrkdwn_in: ["fields", "pretext", "text"],
        },
      ],
    });
  }
}

class GotifyProvider extends NotificationProvider {
  readonly type = "gotify";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const server = String(config.server).replace(/\/$/, "");
    const body = JSON.stringify({
      title: msg.title,
      message: [msg.summary, fieldsAsLines(msg.fields)].filter(Boolean).join("\n\n"),
      priority: Number(config.priority ?? levelPriorityGotify(msg.level)),
    });
    await safeSend(
      `${server}/message?token=${String(config.token)}`,
      body,
      { "content-type": "application/json" },
      { allowPrivate: allowPrivateTargets() },
    );
  }
}

class SmtpProvider extends NotificationProvider {
  readonly type = "smtp";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const transport = nodemailer.createTransport({
      host: String(config.host),
      port: Number(config.port ?? 587),
      secure: Boolean(config.secure ?? false),
      auth: config.user ? { user: String(config.user), pass: String(config.pass ?? "") } : undefined,
    });
    const rows = msg.fields
      .map((f) => `<tr><td><b>${escapeHtml(f.label)}</b></td><td>${escapeHtml(f.value)}</td></tr>`)
      .join("");
    const btns = msg.links
      .map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`)
      .join(" &nbsp; ");
    const html =
      `<h2>${escapeHtml(msg.title)}</h2><p>${escapeHtml(msg.summary)}</p>` +
      (rows ? `<table>${rows}</table>` : "") +
      (btns ? `<p>${btns}</p>` : "");
    await transport.sendMail({
      from: String(config.from ?? config.user ?? "tugra@localhost"),
      to: String(config.to ?? ""),
      subject: sanitizeHeader(msg.title),
      text: toPlain(msg),
      html,
    });
  }
}

class PushoverProvider extends NotificationProvider {
  readonly type = "pushover";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const message = clampLen([msg.summary, fieldsAsLines(msg.fields)].filter(Boolean).join("\n\n"), 1024) || msg.title;
    const override = numCfg(config.priority);
    // Emergency (2) only via an explicit config override; a level/critical never auto-escalates to it.
    const priority = override != null ? Math.max(-2, Math.min(2, override)) : msg.critical ? 1 : levelPriorityPushover(msg.level);
    const body: Record<string, unknown> = {
      token: String(config.token ?? ""),
      user: String(config.userKey ?? ""),
      title: clampLen(msg.title, 250),
      message,
      priority,
    };
    const link = msg.links[0];
    if (link) {
      body.url = link.url;
      body.url_title = link.label;
    }
    if (priority === 2) {
      // Pushover requires retry ≥ 30 and a POSITIVE expire ≤ 10800; floor both so a bad API-set value
      // (e.g. expire "0") can't produce a 400 that silently drops the emergency alert.
      body.retry = Math.max(30, numCfg(config.retry) ?? 60);
      body.expire = Math.max(1, Math.min(10800, numCfg(config.expire) ?? 3600));
    }
    await this.postJson("https://api.pushover.net/1/messages.json", body);
  }
}

class TeamsProvider extends NotificationProvider {
  readonly type = "teams";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const body: unknown[] = [
      { type: "TextBlock", text: msg.title, weight: "Bolder", size: "Large", color: TEAMS_COLOR[msg.level], wrap: true },
    ];
    if (msg.summary) body.push({ type: "TextBlock", text: msg.summary, wrap: true });
    if (msg.fields.length) body.push({ type: "FactSet", facts: msg.fields.map((f) => ({ title: f.label, value: f.value })) });
    const content: Record<string, unknown> = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body,
    };
    // Action.OpenUrl lives at the AdaptiveCard ROOT (content.actions), never inside body.
    if (msg.links.length) content.actions = msg.links.map((l) => ({ type: "Action.OpenUrl", title: l.label, url: l.url }));
    await this.postJson(String(config.webhookUrl), {
      type: "message",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content }],
    });
  }
}

class MattermostProvider extends NotificationProvider {
  readonly type = "mattermost";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    // Slack-compatible attachment, minus the top-level text (would render the title twice) and mrkdwn_in.
    const links = msg.links.map((l) => `<${l.url}|${l.label}>`).join(" · ");
    await this.postJson(String(config.webhookUrl), {
      attachments: [
        {
          color: levelColorHex(msg.level),
          pretext: msg.title,
          text: links ? `${msg.summary}\n${links}` : msg.summary,
          fields: msg.fields.map((f) => ({ title: f.label, value: f.value, short: !!f.inline })),
        },
      ],
    });
  }
}

class LarkProvider extends NotificationProvider {
  readonly type = "lark";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const content = [msg.summary, fieldsAsLines(msg.fields)].filter(Boolean).join("\n") || msg.title;
    const elements: unknown[] = [{ tag: "div", text: { tag: "lark_md", content } }];
    if (msg.links.length) {
      elements.push({
        tag: "action",
        actions: msg.links.map((l) => ({ tag: "button", text: { tag: "plain_text", content: l.label }, url: l.url, type: "default" })),
      });
    }
    await this.postJson(String(config.webhookUrl), {
      msg_type: "interactive",
      card: { header: { title: { tag: "plain_text", content: msg.title }, template: LARK_COLOR[msg.level] }, elements },
    });
  }
}

class ResendProvider extends NotificationProvider {
  readonly type = "resend";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    const to = String(config.to ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const rows = msg.fields
      .map((f) => `<tr><td><b>${escapeHtml(f.label)}</b></td><td>${escapeHtml(f.value)}</td></tr>`)
      .join("");
    const btns = msg.links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(" &nbsp; ");
    const html =
      `<h2>${escapeHtml(msg.title)}</h2><p>${escapeHtml(msg.summary)}</p>` +
      (rows ? `<table>${rows}</table>` : "") +
      (btns ? `<p>${btns}</p>` : "");
    const body = JSON.stringify({
      from: String(config.from ?? ""),
      to,
      subject: sanitizeHeader(msg.title),
      html,
      text: toPlain(msg),
    });
    await safeSend(
      "https://api.resend.com/emails",
      body,
      // sanitizeHeader the Bearer value: apiKey is user config; a CRLF would inject a header / throw.
      { "content-type": "application/json", authorization: `Bearer ${sanitizeHeader(String(config.apiKey ?? ""))}` },
      { allowPrivate: allowPrivateTargets() },
    );
  }
}

const list: NotificationProvider[] = [
  new WebhookProvider(),
  new TelegramProvider(),
  new NtfyProvider(),
  new DiscordProvider(),
  new SlackProvider(),
  new GotifyProvider(),
  new SmtpProvider(),
  new PushoverProvider(),
  new TeamsProvider(),
  new MattermostProvider(),
  new LarkProvider(),
  new ResendProvider(),
];

export const providers: Record<string, NotificationProvider> = Object.fromEntries(
  list.map((p) => [p.type, p]),
);

export const PROVIDER_TYPES = list.map((p) => p.type);

export function getProvider(type: string): NotificationProvider {
  const p = providers[type];
  if (!p) throw new Error(`unknown channel type: ${type}`);
  return p;
}
