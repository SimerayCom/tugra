/**
 * Notification providers — abstract base + a registry, after Uptime Kuma's
 * pattern. Each provider only implements send(); config is a free JSON blob so
 * adding a provider needs zero DB migration. Most providers are fetch-based;
 * SMTP uses nodemailer.
 */
import nodemailer from "nodemailer";

export type ChannelConfig = Record<string, unknown>;

export abstract class NotificationProvider {
  abstract readonly type: string;
  abstract send(config: ChannelConfig, message: string): Promise<void>;

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
  async send(config: ChannelConfig, message: string): Promise<void> {
    await this.postJson(String(config.url), { text: message, message });
  }
}

class TelegramProvider extends NotificationProvider {
  readonly type = "telegram";
  async send(config: ChannelConfig, message: string): Promise<void> {
    await this.postJson(
      `https://api.telegram.org/bot${String(config.botToken)}/sendMessage`,
      { chat_id: String(config.chatId), text: message },
    );
  }
}

class NtfyProvider extends NotificationProvider {
  readonly type = "ntfy";
  async send(config: ChannelConfig, message: string): Promise<void> {
    const server = String(config.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const res = await fetch(`${server}/${String(config.topic)}`, {
      method: "POST",
      body: message,
    });
    if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
  }
}

class DiscordProvider extends NotificationProvider {
  readonly type = "discord";
  async send(config: ChannelConfig, message: string): Promise<void> {
    await this.postJson(String(config.webhookUrl), { content: message });
  }
}

class SlackProvider extends NotificationProvider {
  readonly type = "slack";
  async send(config: ChannelConfig, message: string): Promise<void> {
    await this.postJson(String(config.webhookUrl), { text: message });
  }
}

class GotifyProvider extends NotificationProvider {
  readonly type = "gotify";
  async send(config: ChannelConfig, message: string): Promise<void> {
    const server = String(config.server).replace(/\/$/, "");
    const res = await fetch(`${server}/message?token=${String(config.token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Tugra", message }),
    });
    if (!res.ok) throw new Error(`gotify: HTTP ${res.status}`);
  }
}

class SmtpProvider extends NotificationProvider {
  readonly type = "smtp";
  async send(config: ChannelConfig, message: string): Promise<void> {
    const transport = nodemailer.createTransport({
      host: String(config.host),
      port: Number(config.port ?? 587),
      secure: Boolean(config.secure ?? false),
      auth: config.user
        ? { user: String(config.user), pass: String(config.pass ?? "") }
        : undefined,
    });
    await transport.sendMail({
      from: String(config.from ?? config.user ?? "tugra@localhost"),
      to: String(config.to ?? ""),
      subject: "Tugra notification",
      text: message,
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
