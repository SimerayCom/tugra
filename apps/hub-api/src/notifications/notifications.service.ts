import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { webBaseUrl } from "../common/web-url";
import { getProvider, PROVIDER_TYPES } from "./providers";
import { renderEvent, type RenderEnv } from "./event";
import { type RenderedMessage } from "./rendered-message";
import { WebhookConfigSchema } from "./dto";
import { assertSafeHost, assertSafeUrl, SsrfError } from "./safe-url";

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  teamId: string;
  enabled: boolean;
  eventTypes: string[];
  canWrite: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  /** Environment threaded into pure templates for building web deep-links. */
  private renderEnv(): RenderEnv {
    return { webBaseUrl: webBaseUrl(this.config) };
  }

  private view(
    c: {
      id: string;
      name: string;
      type: string;
      teamId: string;
      enabled: boolean;
      eventTypes: string[];
    },
    canWrite: boolean,
  ): ChannelView {
    return { id: c.id, name: c.name, type: c.type, teamId: c.teamId, enabled: c.enabled, eventTypes: c.eventTypes, canWrite };
  }

  private decodeConfig(configEnc: string): Record<string, unknown> {
    try {
      return JSON.parse(this.crypto.decrypt(configEnc));
    } catch {
      return {};
    }
  }

  async list(userId: string): Promise<ChannelView[]> {
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const teamIds = [...permsByTeam.keys()];
    if (!teamIds.length) return [];
    const rows = await this.prisma.notificationChannel.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((c) => this.view(c, permsByTeam.get(c.teamId)?.has("integrations") ?? false));
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
    // pushover/resend use fixed API hosts (api.pushover.net / api.resend.com) — nothing user-controlled
    // to validate at create; send-time safeSend still resolves+pins those fixed public hosts.
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

  async create(
    userId: string,
    dto: { name: string; type: string; teamId: string; config: Record<string, unknown>; eventTypes?: string[] },
  ): Promise<ChannelView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    if (!PROVIDER_TYPES.includes(dto.type)) {
      throw new BadRequestException(`unsupported channel type: ${dto.type}`);
    }
    await this.validateChannelConfig(dto.type, dto.config);
    const c = await this.prisma.notificationChannel.create({
      data: {
        name: dto.name,
        type: dto.type,
        teamId: dto.teamId,
        configEnc: this.crypto.encrypt(JSON.stringify(dto.config)),
        eventTypes: dto.eventTypes ?? [],
      },
    });
    await this.audit.log({ actor: userId, action: "channel.create", target: c.id });
    return this.view(c, true); // only writers reach here (requireRole above)
  }

  async update(
    userId: string,
    id: string,
    dto: { name?: string; enabled?: boolean; eventTypes?: string[]; config?: Record<string, unknown> },
  ): Promise<ChannelView> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requirePermission(userId, c.teamId, "integrations");
    // The update DTO has no `type`, so validate against the stored channel's type.
    if (dto.config) await this.validateChannelConfig(c.type, dto.config);
    const updated = await this.prisma.notificationChannel.update({
      where: { id },
      data: {
        name: dto.name ?? c.name,
        enabled: dto.enabled ?? c.enabled,
        eventTypes: dto.eventTypes ?? c.eventTypes,
        ...(dto.config ? { configEnc: this.crypto.encrypt(JSON.stringify(dto.config)) } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "channel.update", target: id });
    return this.view(updated, true); // only writers reach here (requireRole above)
  }

  async remove(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requirePermission(userId, c.teamId, "integrations");
    await this.prisma.notificationChannel.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "channel.remove", target: id });
  }

  async test(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    if (!(await this.access.teamRole(userId, c.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    const msg: RenderedMessage = {
      level: "info",
      event: "test",
      title: "Tugra test notification",
      summary: "This channel is working.",
      fields: [],
      links: [],
      timestamp: new Date().toISOString(),
    };
    await getProvider(c.type).send(this.decodeConfig(c.configEnc), msg);
  }

  /**
   * Fire all enabled channels attached to a monitor (called by the runner). Recipients come from the
   * MonitorChannel link table (not the eventTypes filter); the event id (monitor_up/down) is derived
   * from ctx.status purely to select the template.
   */
  async fireForMonitor(monitorId: string, ctx: Record<string, unknown> = {}): Promise<void> {
    const links = await this.prisma.monitorChannel.findMany({
      where: { monitorId },
      include: { channel: true },
    });
    const enabled = links.filter((l) => l.channel.enabled);
    if (!enabled.length) return;
    const type = String(ctx.status).toUpperCase() === "UP" ? "monitor_up" : "monitor_down";
    // teamId is unused by English templates but threaded (real m.teamId) for Dilim 7 team-scoped i18n.
    const msg = renderEvent({ type, teamId: String(ctx.teamId ?? ""), ctx }, this.renderEnv());
    for (const l of enabled) {
      await this.dispatch(l.channel.type, l.channel.configEnc, msg, l.channelId);
    }
  }

  /** Fire all enabled team channels subscribed to a global event (deploy/server/backup/ssl). */
  async fireForEvent(teamId: string, eventType: string, ctx: Record<string, unknown> = {}): Promise<void> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { teamId, enabled: true, eventTypes: { has: eventType } },
    });
    if (!channels.length) return;
    const msg = renderEvent({ type: eventType, teamId, ctx }, this.renderEnv());
    for (const ch of channels) {
      await this.dispatch(ch.type, ch.configEnc, msg, ch.id);
    }
  }

  private async dispatch(type: string, configEnc: string, msg: RenderedMessage, channelId: string): Promise<void> {
    try {
      await getProvider(type).send(this.decodeConfig(configEnc), msg);
    } catch {
      // Log ONLY the channel id — never the error (which could carry config/secret detail).
      await this.audit.log({ actor: "system", action: "notification.failed", target: channelId });
    }
  }
}
