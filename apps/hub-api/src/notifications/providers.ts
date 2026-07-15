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
  levelTag,
  sanitizeHeader,
  sanitizeNtfyHeader,
  toPlain,
  type RenderedMessage,
} from "./rendered-message";
import { allowPrivateTargets, safeSend } from "./safe-url";

export type ChannelConfig = Record<string, unknown>;

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

const list: NotificationProvider[] = [
  new WebhookProvider(),
  new TelegramProvider(),
  new NtfyProvider(),
  new DiscordProvider(),
  new SlackProvider(),
  new GotifyProvider(),
  new SmtpProvider(),
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
