import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { getProvider, PROVIDER_TYPES } from "./providers";

const WRITE_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  teamId: string;
  enabled: boolean;
  eventTypes: string[];
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  private view(c: {
    id: string;
    name: string;
    type: string;
    teamId: string;
    enabled: boolean;
    eventTypes: string[];
  }): ChannelView {
    return { id: c.id, name: c.name, type: c.type, teamId: c.teamId, enabled: c.enabled, eventTypes: c.eventTypes };
  }

  private decodeConfig(configEnc: string): Record<string, unknown> {
    try {
      return JSON.parse(this.crypto.decrypt(configEnc));
    } catch {
      return {};
    }
  }

  async list(userId: string): Promise<ChannelView[]> {
    const teamIds = await this.access.teamIds(userId);
    if (!teamIds.length) return [];
    const rows = await this.prisma.notificationChannel.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((c) => this.view(c));
  }

  async create(
    userId: string,
    dto: { name: string; type: string; teamId: string; config: Record<string, unknown>; eventTypes?: string[] },
  ): Promise<ChannelView> {
    await this.access.requireRole(userId, dto.teamId, WRITE_ROLES);
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
    return this.view(c);
  }

  async update(
    userId: string,
    id: string,
    dto: { name?: string; enabled?: boolean; eventTypes?: string[]; config?: Record<string, unknown> },
  ): Promise<ChannelView> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requireRole(userId, c.teamId, WRITE_ROLES);
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
    return this.view(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requireRole(userId, c.teamId, WRITE_ROLES);
    await this.prisma.notificationChannel.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "channel.remove", target: id });
  }

  async test(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    if (!(await this.access.teamRole(userId, c.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    await getProvider(c.type).send(this.decodeConfig(c.configEnc), "🏛️ Tugra test bildirimi — kanal çalışıyor.");
  }

  /** Fire all enabled channels attached to a monitor (called by the runner). */
  async fireForMonitor(monitorId: string, message: string): Promise<void> {
    const links = await this.prisma.monitorChannel.findMany({
      where: { monitorId },
      include: { channel: true },
    });
    for (const link of links) {
      if (!link.channel.enabled) continue;
      await this.dispatch(link.channel.type, link.channel.configEnc, message, link.channelId);
    }
  }

  /** Fire all enabled team channels subscribed to a global event (deploy/server). */
  async fireForEvent(teamId: string, eventType: string, message: string): Promise<void> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { teamId, enabled: true, eventTypes: { has: eventType } },
    });
    for (const ch of channels) {
      await this.dispatch(ch.type, ch.configEnc, message, ch.id);
    }
  }

  private async dispatch(type: string, configEnc: string, message: string, channelId: string): Promise<void> {
    try {
      await getProvider(type).send(this.decodeConfig(configEnc), message);
    } catch {
      await this.audit.log({ actor: "system", action: "notification.failed", target: channelId });
    }
  }
}
