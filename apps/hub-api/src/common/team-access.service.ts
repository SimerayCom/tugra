import { ForbiddenException, Injectable } from "@nestjs/common";
import { Role } from "@prisma/client";
import { TEAM_PERMISSIONS, type TeamPermission } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";

/** Roles that bypass per-resource scoping entirely — they manage the whole team. */
const BYPASS_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

const ALL_PERMISSIONS = new Set<TeamPermission>(TEAM_PERMISSIONS);

/** The effective resource permissions for a member. A custom role grants exactly its (validated)
 *  permission set; otherwise built-in OWNER/ADMIN get everything and VIEWER gets nothing. A custom
 *  role always takes precedence over the enum tier (its enum role is a VIEWER base). Pure. */
export function resolvePermissions(
  m: { role: Role; teamRole?: { permissions: string[] } | null } | null | undefined,
): Set<TeamPermission> {
  if (!m) return new Set();
  if (m.teamRole) {
    return new Set(m.teamRole.permissions.filter((p): p is TeamPermission => ALL_PERMISSIONS.has(p as TeamPermission)));
  }
  if (m.role === Role.OWNER || m.role === Role.ADMIN) return new Set(ALL_PERMISSIONS);
  return new Set(); // VIEWER (or unknown) — read only
}

/** A member's role plus their per-resource access scoping (see Membership in schema.prisma). */
export interface MembershipAccess {
  role: Role;
  teamRoleId: string | null;
  restrictedAccess: boolean;
  accessedProjects: string[];
  accessedResources: string[];
}

/** True when project scoping actually constrains this member. OWNER/ADMIN bypass it; a CUSTOM-role
 *  member is permission-based and team-wide (scoping is only for a plain restricted VIEWER, whose
 *  reads AND writes it gates); unrestricted members aren't constrained. Pure — safe anywhere. */
export function isScoped(m: MembershipAccess | null | undefined): boolean {
  return !!m && !BYPASS_ROLES.includes(m.role) && !m.teamRoleId && m.restrictedAccess;
}

/** Whether the member may access a project. OWNER/ADMIN and unrestricted members: always. Pure. */
export function canAccessProject(m: MembershipAccess | null | undefined, projectId: string | null): boolean {
  if (!m) return false;
  if (!isScoped(m)) return true;
  return projectId != null && m.accessedProjects.includes(projectId);
}

/** Whether the member may access a resource (app/db). A project grant cascades to its resources. Pure. */
export function canAccessResource(
  m: MembershipAccess | null | undefined,
  resourceId: string,
  projectId: string | null,
): boolean {
  if (!m) return false;
  if (!isScoped(m)) return true;
  return m.accessedResources.includes(resourceId) || (projectId != null && m.accessedProjects.includes(projectId));
}

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

  // ---- granular resource permissions (custom roles) -------------------------

  /** Enforce a resource permission; throws 403 if the member's effective set lacks it. */
  async requirePermission(userId: string, teamId: string, permission: TeamPermission): Promise<void> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true, teamRole: { select: { permissions: true } } },
    });
    if (!resolvePermissions(m).has(permission)) {
      throw new ForbiddenException("insufficient permission for this team");
    }
  }

  /** The member's effective permissions for ONE team (single lookup), or null if not a member. */
  async membershipPermissions(userId: string, teamId: string): Promise<Set<TeamPermission> | null> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true, teamRole: { select: { permissions: true } } },
    });
    return m ? resolvePermissions(m) : null;
  }

  /** Bulk effective permissions for every team the user belongs to (list-view canWrite, no N+1). */
  async permissionsByTeam(userId: string): Promise<Map<string, Set<TeamPermission>>> {
    const ms = await this.prisma.membership.findMany({
      where: { userId },
      select: { teamId: true, role: true, teamRole: { select: { permissions: true } } },
    });
    return new Map(ms.map((m) => [m.teamId, resolvePermissions(m)]));
  }

  // ---- per-resource scoping -------------------------------------------------

  /** The member's role + scoping for one team (null if not a member). */
  async membershipAccess(userId: string, teamId: string): Promise<MembershipAccess | null> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true, teamRoleId: true, restrictedAccess: true, accessedProjects: true, accessedResources: true },
    });
    return m ?? null;
  }

  /** Bulk scoping for every team the user belongs to (for list-view filtering, no N+1). */
  async accessByTeam(userId: string): Promise<Map<string, MembershipAccess>> {
    const ms = await this.prisma.membership.findMany({
      where: { userId },
      select: { teamId: true, role: true, teamRoleId: true, restrictedAccess: true, accessedProjects: true, accessedResources: true },
    });
    return new Map(ms.map((m) => [m.teamId, m]));
  }

  /**
   * Enforce resource access; throws 403 if the member can't reach it. The resource's projectId is
   * resolved LAZILY (only for a genuinely restricted member) so the common unrestricted path costs
   * a single membership read and never touches the environment/project tables.
   */
  async requireResourceAccess(
    userId: string,
    teamId: string,
    resource: { resourceId: string; resolveProjectId: () => Promise<string | null> },
  ): Promise<void> {
    const m = await this.membershipAccess(userId, teamId);
    if (!m) throw new ForbiddenException("no access to this resource");
    if (!isScoped(m)) return; // OWNER/ADMIN or unrestricted — no project lookup needed
    const projectId = await resource.resolveProjectId();
    if (!canAccessResource(m, resource.resourceId, projectId)) {
      throw new ForbiddenException("no access to this resource");
    }
  }

  /** Enforce project access; throws 403 if the member can't reach it. */
  async requireProjectAccess(userId: string, teamId: string, projectId: string): Promise<void> {
    const m = await this.membershipAccess(userId, teamId);
    if (!canAccessProject(m, projectId)) {
      throw new ForbiddenException("no access to this project");
    }
  }

  /** Grant a member access to a project (idempotent — Postgres array push may duplicate, callers
   *  should only call on fresh creates; used for grant-on-create + the management endpoint). */
  async grantProjectAccess(userId: string, teamId: string, projectId: string): Promise<void> {
    await this.prisma.membership.updateMany({
      where: { userId, teamId, NOT: { accessedProjects: { has: projectId } } },
      data: { accessedProjects: { push: projectId } },
    });
  }

  /** Grant a member access to a single resource (app/db id). */
  async grantResourceAccess(userId: string, teamId: string, resourceId: string): Promise<void> {
    await this.prisma.membership.updateMany({
      where: { userId, teamId, NOT: { accessedResources: { has: resourceId } } },
      data: { accessedResources: { push: resourceId } },
    });
  }
}
