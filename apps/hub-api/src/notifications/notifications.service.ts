import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { getProvider, PROVIDER_TYPES } from "./providers";

const WRITE_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  teamId: string;
  enabled: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<ChannelView[]> {
    const teamIds = await this.access.teamIds(userId);
    if (!teamIds.length) return [];
    const rows = await this.prisma.notificationChannel.findMany({
      where: { teamId: { in: teamIds } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      teamId: c.teamId,
      enabled: c.enabled,
    }));
  }

  async create(
    userId: string,
    dto: { name: string; type: string; teamId: string; config: Record<string, unknown> },
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
        config: dto.config as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({ actor: userId, action: "channel.create", target: c.id });
    return { id: c.id, name: c.name, type: c.type, teamId: c.teamId, enabled: c.enabled };
  }

  async remove(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    await this.access.requireRole(userId, c.teamId, WRITE_ROLES);
    await this.prisma.notificationChannel.delete({ where: { id } });
  }

  async test(userId: string, id: string): Promise<void> {
    const c = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException("channel not found");
    if (!(await this.access.teamRole(userId, c.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    await getProvider(c.type).send(
      c.config as Record<string, unknown>,
      "🏛️ Tugra test bildirimi — kanal çalışıyor.",
    );
  }

  /** Fire all enabled channels attached to a monitor (called by the runner). */
  async fireForMonitor(monitorId: string, message: string): Promise<void> {
    const links = await this.prisma.monitorChannel.findMany({
      where: { monitorId },
      include: { channel: true },
    });
    for (const link of links) {
      if (!link.channel.enabled) continue;
      try {
        await getProvider(link.channel.type).send(
          link.channel.config as Record<string, unknown>,
          message,
        );
      } catch {
        await this.audit.log({
          actor: "system",
          action: "notification.failed",
          target: link.channelId,
        });
      }
    }
  }
}
