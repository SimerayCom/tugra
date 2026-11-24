import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { categoryOfEvent, type NotificationCategory, type NotificationSeverity } from "@tugra/shared";
import { PROVIDER_TYPES } from "./providers";
import { type NotificationEvent } from "./event";
import { CHANNEL_CONFIG_SCHEMAS, WebhookConfigSchema, type PolicyInput } from "./dto";
import { ChannelUrlError, parseChannelUrl, previewConfig } from "./channel-url";
import { parsePolicy, type ChannelPolicy } from "./policy";
import { channelWantsEvent, channelWantsMonitorEvent, eventSeverity } from "./routing";
import { assertSafeHost, assertSafeUrl, SsrfError } from "./safe-url";
import { NotificationQueueService } from "./queue.service";
import { filterByQuery } from "../common/query-filter";

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  teamId: string;
  enabled: boolean;
  eventTypes: string[];
  /** Routing rule: categories (empty = eventTypes only), minimum severity, Telegram topic per category. */
  categories: string[];
  minSeverity: string;
  topics: Record<string, number> | null;
  /** Delivery policy (quiet hours / rate limit / repeat window); {} = defaults. */
  policy: ChannelPolicy;
  canWrite: boolean;
}

/** Strip nulls/empties from a policy body so the stored JSON only carries real settings (null/absent = default). */
export function normalizePolicy(p: PolicyInput | null | undefined): ChannelPolicy | null {
  if (!p) return null;
  const out: ChannelPolicy = {};
  if (p.quietHours) out.quietHours = { ...p.quietHours, allowCritical: p.quietHours.allowCritical !== false };
  if (p.rateLimitPerMin != null) out.rateLimitPerMin = p.rateLimitPerMin;
  if (p.dedupeWindowSec != null) out.dedupeWindowSec = p.dedupeWindowSec;
  return Object.keys(out).length ? out : null;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly queue: NotificationQueueService,
  ) {}

  private view(
    c: {
      id: string;
      name: string;
      type: string;
      teamId: string;
      enabled: boolean;
      eventTypes: string[];
      categories?: string[] | null;
      minSeverity?: string | null;
      topics?: unknown;
      policy?: unknown;
    },
    canWrite: boolean,
  ): ChannelView {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      teamId: c.teamId,
      enabled: c.enabled,
      eventTypes: c.eventTypes,
      categories: c.categories ?? [],
      minSeverity: c.minSeverity ?? "info",
      topics: c.topics && typeof c.topics === "object" ? (c.topics as Record<string, number>) : null,
      policy: parsePolicy(c.policy),
      canWrite,
    };
  }

  async list(userId: string, q?: string): Promise<ChannelView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const teamIds = [...permsByTeam.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.notificationChannel.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    const views = rows.map((c) => this.view(c, permsByTeam.get(c.teamId)?.has("integrations") ?? false));
    return filterByQuery(views, q, (c) => [c.name, c.type]);
  }

  // The user-controlled host/URL field per provider type (telegram is a fixed api.telegram.org host).
  private static readonly HOST_FIELD: Record<string, string> = {
    webhook: "url",
    ntfy: "server",
    gotify: "server",
    discord: "webhookUrl",
    slack: "webhookUrl",
    smtp: "host",
    teams: "webhookUrl",
    mattermost: "webhookUrl",
    lark: "webhookUrl",
    matrix: "homeserver",
    googlechat: "webhookUrl",
    rocketchat: "webhookUrl",
    zulip: "server",
    bark: "server",
    signal: "server",
    // pushover/resend/pagerduty/opsgenie/sms use fixed API hosts (api.pushover.net / api.resend.com / the
    // PagerDuty, Opsgenie and Twilio APIs) — nothing user-controlled to validate at create; send-time
    // safeSend still resolves+pins those fixed public hosts.
  };

  /**
   * Validate a channel's config before it is encrypted+stored: webhook shape (signingSecret/headers)
   * and the SSRF policy on its outbound host/URL — a channel must not be able to point the hub at
   * cloud-metadata / loopback / (by default) private LAN addresses. Throws BadRequestException.
   */
  private async validateChannelConfig(type: string, config: Record<string, unknown>): Promise<void> {
    if (type === "webhook") {
      const parsed = WebhookConfigSchema.safeParse(config);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const schema = CHANNEL_CONFIG_SCHEMAS[type];
    if (schema) {
      const parsed = schema.safeParse(config);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "));
    }
    const field = NotificationsService.HOST_FIELD[type];
    if (!field) return; // telegram (fixed host) — nothing user-controlled to validate
    const value = config[field];
    if (value == null || value === "") return; // unset (e.g. ntfy defaults to https://ntfy.sh) → nothing to check
    const allowPrivate = this.config.get<string>("NOTIFY_ALLOW_PRIVATE_TARGETS") === "true";
    try {
      // smtp stores a bare host; the others store a full URL.
      if (type === "smtp") await assertSafeHost(String(value), { allowPrivate });
      else await assertSafeUrl(String(value), { allowPrivate });
    } catch (e) {
      if (e instanceof SsrfError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Forum topics are a Telegram concept; refuse a topic map on any other channel type. */
  private assertTopicsAllowed(type: string, topics: Record<string, number> | null | undefined): void {
    if (topics && Object.keys(topics).length > 0 && type !== "telegram") {
      throw new BadRequestException("topics are only supported on telegram channels");
    }
  }

  async create(
    userId: string,
    dto: {
      name: string;
      type: string;
      teamId: string;
      config: Record<string, unknown>;
      eventTypes?: string[];
      categories?: string[];
      minSeverity?: string;
      topics?: Record<string, number>;
      policy?: PolicyInput;
      locale?: string;
    },
  ): Promise<ChannelView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    if (!PROVIDER_TYPES.includes(dto.type)) {
      throw new BadRequestException(`unsupported channel type: ${dto.type}`);
    }
    // A push channel always targets the creating user's own devices: the recipient is written here, never taken
    // from the request (otherwise a writer could point it at someone else's devices).
    const config = dto.type === "push" ? { userId, teamId: dto.teamId } : dto.config;
    await this.validateChannelConfig(dto.type, config);
    this.assertTopicsAllowed(dto.type, dto.topics);
    const c = await this.prisma.notificationChannel.create({
      data: {
        name: dto.name,
        type: dto.type,
        teamId: dto.teamId,
        configEnc: this.crypto.encrypt(JSON.stringify(config)),
        eventTypes: dto.eventTypes ?? [],
        categories: dto.categories ?? [],
        minSeverity: dto.minSeverity ?? "info",
        ...(dto.topics ? { topics: dto.topics } : {}),
        ...(normalizePolicy(dto.policy) ? { policy: normalizePolicy(dto.policy) as Prisma.InputJsonValue } : {}),
        locale: dto.locale ?? "en",
      },
    });
    await this.audit.log({ actor: userId, action: "channel.create", target: c.id });
    return this.view(c, true); // only writers reach here (requireRole above)
  }

  async update(
    userId: string,
    id: string,
    dto: {
      name?: string;
      enabled?: boolean;
      eventTypes?: string[];
      categories?: string[];
      minSeverity?: string;
      topics?: Record<string, number> | null;
      config?: Record<string, unknown>;
      policy?: PolicyInput | null;
      locale?: string;
    },
  ): Promise<ChannelView> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requirePermission(userId, c.teamId, "integrations");
    // The update DTO has no `type`, so validate against the stored channel's type.
    // A push channel's config is the hub-written recipient; an edit can never retarget it.
    const newConfig = c.type === "push" ? undefined : dto.config;
    if (newConfig) await this.validateChannelConfig(c.type, newConfig);
    this.assertTopicsAllowed(c.type, dto.topics);
    const updated = await this.prisma.notificationChannel.update({
      where: { id },
      data: {
        name: dto.name ?? c.name,
        enabled: dto.enabled ?? c.enabled,
        eventTypes: dto.eventTypes ?? c.eventTypes,
        categories: dto.categories ?? c.categories,
        minSeverity: dto.minSeverity ?? c.minSeverity,
        // undefined = keep, null = clear the map, object = replace it
        ...(dto.topics === undefined ? {} : { topics: dto.topics === null ? Prisma.DbNull : dto.topics }),
        // undefined = keep, null / all-default = clear, object = replace
        ...(dto.policy === undefined ? {} : { policy: (normalizePolicy(dto.policy) as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
        locale: dto.locale ?? c.locale,
        ...(newConfig ? { configEnc: this.crypto.encrypt(JSON.stringify(newConfig)) } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "channel.update", target: id });
    return this.view(updated, true); // only writers reach here (requireRole above)
  }

  /** Map a Shoutrrr/Apprise URL to a typed config; a bad URL is a 400 whose message never echoes the URL. */
  private parseUrl(url: string): { type: string; config: Record<string, unknown>; suggestedName: string } {
    try {
      return parseChannelUrl(url);
    } catch (e) {
      if (e instanceof ChannelUrlError) throw new BadRequestException(e.message);
      throw new BadRequestException("that is not a notification URL");
    }
  }

  /** Dry run for the "paste a URL" box: what channel would this create? Credentials are masked. */
  async previewUrl(userId: string, dto: { teamId: string; url: string }): Promise<{ type: string; suggestedName: string; config: Record<string, string> }> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    const parsed = this.parseUrl(dto.url);
    await this.validateChannelConfig(parsed.type, parsed.config);
    return { type: parsed.type, suggestedName: parsed.suggestedName, config: previewConfig(parsed.config) };
  }

  /** Create a channel from one Shoutrrr/Apprise-style URL (same validation, SSRF guard and encryption as create). */
  async createFromUrl(
    userId: string,
    dto: { teamId: string; url: string; name?: string; eventTypes?: string[]; categories?: string[]; minSeverity?: string; locale?: string },
  ): Promise<ChannelView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    const parsed = this.parseUrl(dto.url);
    return this.create(userId, {
      name: dto.name ?? parsed.suggestedName,
      type: parsed.type,
      teamId: dto.teamId,
      config: parsed.config,
      eventTypes: dto.eventTypes,
      categories: dto.categories,
      minSeverity: dto.minSeverity,
      locale: dto.locale,
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requirePermission(userId, c.teamId, "integrations");
    await this.prisma.notificationChannel.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "channel.remove", target: id });
  }

  async test(userId: string, id: string, category?: NotificationCategory): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    if (!(await this.access.teamRole(userId, c.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    // A push channel buzzes its recipient's own devices, so only that person may fire its test.
    if (c.type === "push") {
      let recipient: unknown;
      try {
        recipient = (JSON.parse(this.crypto.decrypt(c.configEnc)) as { userId?: unknown }).userId;
      } catch {
        recipient = undefined;
      }
      if (recipient !== userId) throw new ForbiddenException("only the recipient can test a push channel");
    }
    // Synchronous send (the button reports pass/fail immediately) that also records a delivery row.
    // The testTemplate renders the (localized) confirmation message; ctx carries nothing.
    // With a category the test is sent the way that category routes (its Telegram topic) and names it, so
    // the operator can see each route work. The test deliberately ignores the channel's category/severity
    // filter: it checks the transport and the topic, not the rule.
    await this.queue.deliverNow(c.id, { type: "test", teamId: c.teamId, locale: c.locale, ctx: category ? { category } : {} });
  }

  /** A channel's recent delivery history — any team member may read it (mirrors test()/list()). */
  async listDeliveries(userId: string, channelId: string) {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id: channelId } });
    if (!c) throw new NotFoundException("channel not found");
    if (!(await this.access.teamRole(userId, c.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return this.prisma.notificationDelivery.findMany({
      where: { channelId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /**
   * Fire all enabled channels attached to a monitor (called by the runner). Recipients come from the
   * MonitorChannel link table (not the eventTypes filter); the event id (monitor_up/down) is derived
   * from ctx.status purely to select the template. Each channel is enqueued for durable delivery.
   */
  async fireForMonitor(monitorId: string, ctx: Record<string, unknown> = {}): Promise<void> {
    const links = await this.prisma.monitorChannel.findMany({
      where: { monitorId },
      include: { channel: true },
    });
    const enabled = links.filter((l) => l.channel.enabled);
    if (!enabled.length) return;
    const type = String(ctx.status).toUpperCase() === "UP" ? "monitor_up" : "monitor_down";
    const teamId = String(ctx.teamId ?? "");
    // The link is the recipient list; the channel's routing rule can still narrow it (uptime category,
    // minimum severity). A legacy channel (no rule) passes everything, as before.
    const severity = eventSeverity({ type, teamId, ctx });
    for (const l of enabled) {
      if (!channelWantsMonitorEvent(l.channel, severity)) continue;
      // Per-channel locale → the notification renders in each channel's configured language.
      const event: NotificationEvent = { type, teamId, locale: l.channel.locale, ctx };
      await this.queue.enqueue(l.channelId, event, { channel: { type: l.channel.type, policy: l.channel.policy } });
    }
  }

  /** Fire all enabled team channels subscribed to a global event (deploy/server/backup/ssl). */
  async fireForEvent(teamId: string, eventType: string, ctx: Record<string, unknown> = {}): Promise<void> {
    // Subscribed by event id (legacy/fine-grained) or by the event's category (routing rule).
    const category = categoryOfEvent(eventType);
    const candidates = await this.prisma.notificationChannel.findMany({
      where: {
        teamId,
        enabled: true,
        OR: [{ eventTypes: { has: eventType } }, ...(category ? [{ categories: { has: category } }] : [])],
      },
    });
    if (!candidates.length) return;
    const severity: NotificationSeverity = eventSeverity({ type: eventType, teamId, ctx });
    const channels = candidates.filter((ch) => channelWantsEvent(ch, eventType, severity));
    for (const ch of channels) {
      const event: NotificationEvent = { type: eventType, teamId, locale: ch.locale, ctx };
      await this.queue.enqueue(ch.id, event, { channel: { type: ch.type, policy: ch.policy } });
    }
  }
}
