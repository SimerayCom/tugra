import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Role } from "@prisma/client";
import { TEAM_PERMISSIONS } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { MailService } from "../mail/mail.service";
import { teamInviteEmail } from "../mail/templates";
import { TeamAccessService } from "../common/team-access.service";
import { TeamDefaultsService } from "./team-defaults.service";
import { webBaseUrl } from "../common/web-url";

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
  teamRoleId: string | null;
  roleName: string | null; // the custom role's name, when one is assigned
  restrictedAccess: boolean;
  accessedProjects: string[];
}
export interface TeamRoleView {
  id: string;
  name: string;
  permissions: string[];
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
export interface InvitationPreviewView {
  teamName: string;
  inviterName: string | null;
  role: Role;
  email: string;
  expiresAt: Date;
  expired: boolean;
}

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly teamDefaults: TeamDefaultsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
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
    // Atomic: team + OWNER membership + default project/env commit or roll back as
    // one unit, so a failure never leaves a persisted team without its defaults
    // (mirrors the auth register / OAuth bootstrap paths).
    const team = await this.prisma.$transaction(async (tx) => {
      const created = await tx.team.create({
        data: { name, memberships: { create: { userId, role: Role.OWNER } } },
      });
      await this.teamDefaults.ensureDefaults(created.id, tx);
      return created;
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
      include: { user: { select: { id: true, email: true, name: true } }, teamRole: { select: { name: true } } },
      orderBy: { role: "asc" },
    });
    return ms.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      teamRoleId: m.teamRoleId,
      roleName: m.teamRole?.name ?? null,
      restrictedAccess: m.restrictedAccess,
      accessedProjects: m.accessedProjects,
    }));
  }

  /** Set a member's per-resource access scoping (restrict them to a set of projects). Manager-only;
   *  granted project ids are validated to belong to this team. OWNER/ADMIN bypass scoping regardless,
   *  so this is only meaningful for a VIEWER. */
  async setMemberAccess(
    userId: string,
    id: string,
    targetUserId: string,
    input: { restrictedAccess: boolean; accessedProjects: string[] },
  ): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    const target = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
    });
    if (!target) throw new NotFoundException("member not found");
    // Project scoping is only meaningful for a plain VIEWER — a custom role is permission-based and
    // team-wide, so refuse to set an (unenforceable) scope on one rather than imply false confinement.
    if (target.teamRoleId) throw new ConflictException("project scoping doesn't apply to a member with a custom role");
    // Only keep project ids that actually belong to this team (drop cross-team / stale ids).
    const owned = await this.prisma.project.findMany({
      where: { id: { in: input.accessedProjects }, teamId: id },
      select: { id: true },
    });
    const validIds = new Set(owned.map((p) => p.id));
    const accessedProjects = [...new Set(input.accessedProjects)].filter((pid) => validIds.has(pid));
    await this.prisma.membership.update({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
      data: { restrictedAccess: input.restrictedAccess, accessedProjects },
    });
    await this.audit.log({
      actor: userId,
      action: "team.member.access",
      target: id,
      meta: { targetUserId, restrictedAccess: input.restrictedAccess, projects: accessedProjects.length },
    });
  }

  /**
   * Assign a member a built-in role OR a custom team role. Manager-only (built-in ADMIN/OWNER); a
   * custom-role member can't reach here, so it can't self-escalate. A custom role grants only
   * resource permissions and sits on a VIEWER enum base (never OWNER), so owner powers stay put.
   */
  async setRole(
    userId: string,
    id: string,
    targetUserId: string,
    input: { role?: Role; teamRoleId?: string | null },
  ): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    const target = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
    });
    if (!target) throw new NotFoundException("member not found");

    if (input.teamRoleId) {
      const customRole = await this.prisma.teamRole.findFirst({ where: { id: input.teamRoleId, teamId: id } });
      if (!customRole) throw new NotFoundException("role not found");
      // Moving an owner onto a custom role is a demotion — keep at least one owner, owner-gated.
      if (target.role === Role.OWNER) {
        await this.requireOwner(userId, id);
        await this.assertNotLastOwner(id);
      }
      await this.prisma.membership.update({
        where: { userId_teamId: { userId: targetUserId, teamId: id } },
        data: { role: Role.VIEWER, teamRoleId: input.teamRoleId },
      });
      await this.audit.log({ actor: userId, action: "team.member.role", target: id, meta: { targetUserId, teamRoleId: input.teamRoleId } });
      return;
    }

    const role = input.role ?? Role.VIEWER;
    // Promoting to or demoting an OWNER is owner-only.
    if (role === Role.OWNER || target.role === Role.OWNER) await this.requireOwner(userId, id);
    // Never leave a team without an owner.
    if (target.role === Role.OWNER && role !== Role.OWNER) await this.assertNotLastOwner(id);
    await this.prisma.membership.update({
      where: { userId_teamId: { userId: targetUserId, teamId: id } },
      data: { role, teamRoleId: null }, // clear any custom role when a built-in role is set
    });
    await this.audit.log({ actor: userId, action: "team.member.role", target: id, meta: { targetUserId, role } });
  }

  // ---- custom roles (granular permission presets) ---------------------------

  /** Keep only valid, de-duplicated permission strings from the shared catalog. */
  private validPermissions(perms: string[]): string[] {
    const valid = new Set<string>(TEAM_PERMISSIONS);
    return [...new Set(perms)].filter((p) => valid.has(p));
  }

  async listRoles(userId: string, id: string): Promise<TeamRoleView[]> {
    if (!(await this.access.teamRole(userId, id))) throw new ForbiddenException("not a member");
    const roles = await this.prisma.teamRole.findMany({ where: { teamId: id }, orderBy: { name: "asc" } });
    return roles.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions }));
  }

  async createRole(userId: string, id: string, input: { name: string; permissions: string[] }): Promise<TeamRoleView> {
    // Managing the role CATALOG is built-in-admin only (a custom role can't grant team administration).
    await this.access.requireRole(userId, id, MANAGE);
    const name = input.name.trim();
    if (!name) throw new ConflictException("role name is required");
    const created = await this.prisma.teamRole
      .create({ data: { teamId: id, name, permissions: this.validPermissions(input.permissions) } })
      .catch(() => {
        throw new ConflictException("a role with this name already exists");
      });
    await this.audit.log({ actor: userId, action: "team.role.create", target: id, meta: { name } });
    return { id: created.id, name: created.name, permissions: created.permissions };
  }

  async updateRole(
    userId: string,
    id: string,
    roleId: string,
    input: { name?: string; permissions?: string[] },
  ): Promise<TeamRoleView> {
    await this.access.requireRole(userId, id, MANAGE);
    const role = await this.prisma.teamRole.findFirst({ where: { id: roleId, teamId: id } });
    if (!role) throw new NotFoundException("role not found");
    const updated = await this.prisma.teamRole
      .update({
        where: { id: roleId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.permissions !== undefined ? { permissions: this.validPermissions(input.permissions) } : {}),
        },
      })
      .catch(() => {
        throw new ConflictException("a role with this name already exists");
      });
    await this.audit.log({ actor: userId, action: "team.role.update", target: id, meta: { roleId } });
    return { id: updated.id, name: updated.name, permissions: updated.permissions };
  }

  async deleteRole(userId: string, id: string, roleId: string): Promise<void> {
    await this.access.requireRole(userId, id, MANAGE);
    // Members assigned this role revert to their enum role (teamRoleId → null via onDelete: SetNull).
    await this.prisma.teamRole.deleteMany({ where: { id: roleId, teamId: id } });
    await this.audit.log({ actor: userId, action: "team.role.delete", target: id, meta: { roleId } });
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
    // Email the invite too (on top of the copy-link the caller still gets back). Load the
    // personalization, then FIRE-AND-FORGET the SMTP send AFTER the DB write so a mail hiccup can
    // never block invitation creation (MailService.send is already fail-soft / never-throws).
    const [team, inviter] = await Promise.all([
      this.prisma.team.findUnique({ where: { id }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    const acceptUrl = `${webBaseUrl(this.config)}/invite/${token}`;
    void this.mail
      .send(addr, teamInviteEmail({ inviterName: inviter?.name ?? null, teamName: team?.name ?? "a team", acceptUrl }))
      .then((sent) => this.audit.log({ actor: userId, action: "team.invite.sent", target: id, meta: { email: addr, delivered: sent } }))
      .catch(() => undefined);
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

  /**
   * PUBLIC preview of an invitation by its token — no email match (the viewer isn't logged in yet).
   * Reveals the team, inviter, role, and the invited address so the /invite page can render and the
   * signup form can pre-fill the email; the token is the invite secret (emailed only to that address)
   * and acceptance is still gated by email-match + expiry, so a leaked token can't join.
   */
  async previewInvitation(token: string): Promise<InvitationPreviewView> {
    const inv = await this.prisma.teamInvitation.findUnique({ where: { token } });
    if (!inv) throw new NotFoundException("invitation not found");
    const [team, inviter] = await Promise.all([
      this.prisma.team.findUnique({ where: { id: inv.teamId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: inv.invitedBy }, select: { name: true } }),
    ]);
    return {
      teamName: team?.name ?? "a team",
      inviterName: inviter?.name ?? null,
      role: inv.role,
      email: inv.email,
      expiresAt: inv.expiresAt,
      expired: inv.expiresAt.getTime() < Date.now(),
    };
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
