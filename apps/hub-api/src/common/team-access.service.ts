import { ForbiddenException, Injectable } from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** Shared team membership / role checks (used by servers, monitors, channels). */
@Injectable()
export class TeamAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async roleByTeam(userId: string): Promise<Map<string, Role>> {
    const ms = await this.prisma.membership.findMany({
      where: { userId },
      select: { teamId: true, role: true },
    });
    return new Map(ms.map((m) => [m.teamId, m.role]));
  }

  async teamIds(userId: string): Promise<string[]> {
    return [...(await this.roleByTeam(userId)).keys()];
  }

  async teamRole(userId: string, teamId: string): Promise<Role | null> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true },
    });
    return m?.role ?? null;
  }

  async requireRole(
    userId: string,
    teamId: string,
    roles: Role[],
  ): Promise<void> {
    const r = await this.teamRole(userId, teamId);
    if (!r || !roles.includes(r)) {
      throw new ForbiddenException("insufficient role for this team");
    }
  }
}
