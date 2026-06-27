import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";

const MANAGE: Role[] = [Role.OWNER, Role.ADMIN];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TeamView {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
}
export interface TeamMemberView {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
}
export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: Date;
}
export interface MyInvitationView {
  token: string;
  teamName: string;
  role: Role;
  expiresAt: Date;
}

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<TeamView[]> {
    const roles = await this.access.roleByTeam(userId);
    const ids = [...roles.keys()];
    if (!ids.length) return [];
    const teams = await this.prisma.team.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { memberships: true } } },
      orderBy: { createdAt: "asc" },
    });
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      role: roles.get(t.id)!,
      memberCount: t._count.memberships,
    }));
  }

  async get(userId: string, id: string): Promise<TeamView> {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { _count: { select: { memberships: true } } },
    });
    if (!team) throw new NotFoundException("team not found");
    const role = await this.access.teamRole(userId, id);
    if (!role) throw new ForbiddenException("not a member of this team");
    return { id: team.id, name: team.name, role, memberCount: team._count.memberships };
  }

  async create(userId: string, name: string): Promise<TeamView> {
    const team = await this.prisma.team.create({
      data: { name, memberships: { create: { userId, role: Role.OWNER } } },
    });
    await this.audit.log({ actor: userId, action: "team.create", target: team.id });
    return { id: team.id, name: team.name, role: Role.OWNER, memberCount: 1 };
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    await this.prisma.team.update({ where: { id }, data: { name } });
    await this.audit.log({ actor: userId, action: "team.rename", target: id });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.requireOwner(userId, id);
    const [servers, apps, dbs] = await Promise.all([
      this.prisma.server.count({ where: { teamId: id } }),
      this.prisma.application.count({ where: { teamId: id } }),
      this.prisma.database.count({ where: { teamId: id } }),
    ]);
    if (servers + apps + dbs > 0) {
      throw new ConflictException("team has resources; remove servers/apps/databases first");
    }
    await this.prisma.team.delete({ where: { id } }); // memberships + invitations cascade
    await this.audit.log({ actor: userId, action: "team.remove", target: id });
  }

  async members(userId: string, id: string): Promise<TeamMemberView[]> {
    if (!(await this.access.teamRole(userId, id))) throw new ForbiddenException("not a member");
    const ms = await this.prisma.membership.findMany({
      where: { teamId: id },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { role: "asc" },
    });
    return ms.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role }));
  }

  async setRole(userId: string, id: string, targetUserId: string, role: Role): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    const target = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
    });
    if (!target) throw new NotFoundException("member not found");
    // Promoting to or demoting an OWNER is owner-only.
    if (role === Role.OWNER || target.role === Role.OWNER) await this.requireOwner(userId, id);
    // Never leave a team without an owner.
    if (target.role === Role.OWNER && role !== Role.OWNER) await this.assertNotLastOwner(id);
    await this.prisma.membership.update({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
      data: { role },
    });
    await this.audit.log({ actor: userId, action: "team.member.role", target: id, meta: { targetUserId, role } });
  }

  async removeMember(userId: string, id: string, targetUserId: string): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    const target = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
    });
    if (!target) throw new NotFoundException("member not found");
    if (target.role === Role.OWNER) {
      await this.requireOwner(userId, id);
      await this.assertNotLastOwner(id);
    }
    await this.prisma.membership.delete({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
    });
    await this.audit.log({ actor: userId, action: "team.member.remove", target: id, meta: { targetUserId } });
  }

  async invite(userId: string, id: string, email: string, role: Role): Promise<InvitationView> {
    await this.access.requireRole(userId, id, MANAGE);
    if (role === Role.OWNER) await this.requireOwner(userId, id);
    const addr = email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email: addr } });
    if (existing && (await this.access.teamRole(existing.id, id))) {
      throw new ConflictException("user is already a member");
    }
    const token = `tugra_inv_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const inv = await this.prisma.teamInvitation.upsert({
      where: { teamId_email: { teamId: id, email: addr } },
      create: { teamId: id, email: addr, role, token, invitedBy: userId, expiresAt },
      update: { role, token, invitedBy: userId, expiresAt },
    });
    await this.audit.log({ actor: userId, action: "team.invite", target: id, meta: { email: addr, role } });
    return { id: inv.id, email: inv.email, role: inv.role, token: inv.token, expiresAt: inv.expiresAt };
  }

  async teamInvitations(userId: string, id: string): Promise<InvitationView[]> {
    await this.access.requireRole(userId, id, MANAGE);
    const invs = await this.prisma.teamInvitation.findMany({ where: { teamId: id }, orderBy: { createdAt: "desc" } });
    return invs.map((i) => ({ id: i.id, email: i.email, role: i.role, token: i.token, expiresAt: i.expiresAt }));
  }

  async revokeInvitation(userId: string, id: string, invId: string): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    await this.prisma.teamInvitation.deleteMany({ where: { id: invId, teamId: id } });
    await this.audit.log({ actor: userId, action: "team.invite.revoke", target: id });
  }

  async myInvitations(userId: string): Promise<MyInvitationView[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return [];
    const invs = await this.prisma.teamInvitation.findMany({
      where: { email: user.email.toLowerCase(), expiresAt: { gt: new Date() } },
      include: { team: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return invs.map((i) => ({ token: i.token, teamName: i.team.name, role: i.role, expiresAt: i.expiresAt }));
  }

  async acceptInvitation(userId: string, token: string): Promise<void> {
    const inv = await this.prisma.teamInvitation.findUnique({ where: { token } });
    if (!inv) throw new NotFoundException("invitation not found");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email.toLowerCase() !== inv.email) {
      throw new ForbiddenException("invitation is for a different account");
    }
    if (inv.expiresAt.getTime() < Date.now()) throw new GoneException("invitation expired");
    await this.prisma.$transaction([
      this.prisma.membership.upsert({
        where: { userId_teamId: { userId, teamId: inv.teamId } },
        create: { userId, teamId: inv.teamId, role: inv.role },
        update: { role: inv.role },
      }),
      this.prisma.teamInvitation.delete({ where: { id: inv.id } }),
    ]);
    await this.audit.log({ actor: userId, action: "team.invite.accept", target: inv.teamId });
  }

  async declineInvitation(userId: string, token: string): Promise<void> {
    const inv = await this.prisma.teamInvitation.findUnique({ where: { token } });
    if (!inv) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user && user.email.toLowerCase() === inv.email) {
      await this.prisma.teamInvitation.delete({ where: { id: inv.id } });
    }
  }

  // ── helpers ──
  private async requireOwner(userId: string, teamId: string): Promise<void> {
    if ((await this.access.teamRole(userId, teamId)) !== Role.OWNER) {
      throw new ForbiddenException("only the team owner can do this");
    }
  }

  private async assertNotLastOwner(teamId: string): Promise<void> {
    const owners = await this.prisma.membership.count({ where: { teamId, role: Role.OWNER } });
    if (owners <= 1) throw new ConflictException("a team must keep at least one owner");
  }
}
