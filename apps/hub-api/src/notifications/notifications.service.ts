import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { getProvider, PROVIDER_TYPES } from "./providers";
import { plainToRendered, type RenderedMessage } from "./rendered-message";

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
  ) {}

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

  async create(
    userId: string,
    dto: { name: string; type: string; teamId: string; config: Record<string, unknown>; eventTypes?: string[] },
  ): Promise<ChannelView> {
    await this.access.requirePermission(userId, dto.teamId, "integrations");
    if (!PROVIDER_TYPES.includes(dto.type)) {
      throw new BadRequestException(`unsupported channel type: ${dto.type}`);
    }
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

  /** Fire all enabled channels attached to a monitor (called by the runner). */
  async fireForMonitor(monitorId: string, message: string): Promise<void> {
    const links = await this.prisma.monitorChannel.findMany({
      where: { monitorId },
      include: { channel: true },
    });
    const msg = plainToRendered(message); // SHIM until Dilim 3's typed templates
    for (const link of links) {
      if (!link.channel.enabled) continue;
      await this.dispatch(link.channel.type, link.channel.configEnc, msg, link.channelId);
    }
  }

  /** Fire all enabled team channels subscribed to a global event (deploy/server). */
  async fireForEvent(teamId: string, eventType: string, message: string): Promise<void> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { teamId, enabled: true, eventTypes: { has: eventType } },
    });
    const msg = plainToRendered(message); // SHIM until Dilim 3's typed templates
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
