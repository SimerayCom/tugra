/**
 * Notification providers — abstract base + a registry, after Uptime Kuma's pattern. Each provider
 * renders a RenderedMessage into its NATIVE rich format; config is a free JSON blob so adding a
 * provider (or a config field) needs zero DB migration. Most providers are fetch-based; SMTP uses
 * nodemailer.
 */
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

export type ChannelConfig = Record<string, unknown>;

export abstract class NotificationProvider {
  abstract readonly type: string;
  abstract send(config: ChannelConfig, msg: RenderedMessage): Promise<void>;

  protected async postJson(url: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${this.type}: HTTP ${res.status}`);
  }
}

class WebhookProvider extends NotificationProvider {
  readonly type = "webhook";
  async send(config: ChannelConfig, msg: RenderedMessage): Promise<void> {
    // Structured payload. HMAC signature + custom headers + SSRF guard land in a later slice.
    await this.postJson(String(config.url), {
      version: 1,
      event: msg.event,
      level: msg.level,
      title: msg.title,
      summary: msg.summary,
      fields: msg.fields,
      links: msg.links,
      timestamp: msg.timestamp,
    });
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
    const res = await fetch(`${server}/${String(config.topic)}`, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
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
    const res = await fetch(`${server}/message?token=${String(config.token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: msg.title,
        message: [msg.summary, fieldsAsLines(msg.fields)].filter(Boolean).join("\n\n"),
        priority: Number(config.priority ?? levelPriorityGotify(msg.level)),
      }),
    });
    if (!res.ok) throw new Error(`gotify: HTTP ${res.status}`);
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
