import { Injectable } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

export interface AuditView {
  id: string;
  actor: string; // resolved to email when the actor is a user, else raw (system/webhook…)
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: Date;
}

const ADMIN: Role[] = [Role.OWNER, Role.ADMIN];
const PAGE = 100;

export interface AuditPage {
  entries: AuditView[];
  nextCursor: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        ...(entry.meta
          ? { meta: entry.meta as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /**
   * Audit entries the user may see. Team OWNER/ADMINs see actions by every
   * member of the selected team (actor-based scope); everyone else sees only
   * their own actions. No write-side teamId needed.
   */
  async list(userId: string, teamId?: string, cursor?: string): Promise<AuditPage> {
    const memberships = await this.prisma.membership.findMany({ where: { userId } });
    const adminTeams = new Set(memberships.filter((m) => ADMIN.includes(m.role)).map((m) => m.teamId));

    let actors: string[];
    if (teamId && adminTeams.has(teamId)) {
      const members = await this.prisma.membership.findMany({ where: { teamId } });
      actors = members.map((m) => m.userId);
    } else {
      actors = [userId];
    }

    const rows = await this.prisma.auditLog.findMany({
      where: { actor: { in: actors } },
      orderBy: { createdAt: "desc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.actor))] } },
      select: { id: true, email: true },
    });
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    const entries = rows.map((r) => ({
      id: r.id,
      actor: emailById.get(r.actor) ?? r.actor,
      action: r.action,
      target: r.target,
      meta: r.meta,
      createdAt: r.createdAt,
    }));
    // A full page implies there may be older rows; the last id is the next cursor.
    const nextCursor = rows.length === PAGE ? rows[rows.length - 1].id : null;
    return { entries, nextCursor };
  }
}
