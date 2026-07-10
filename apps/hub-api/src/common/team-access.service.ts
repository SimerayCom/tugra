import { ForbiddenException, Injectable } from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** Roles that bypass per-resource scoping entirely — they manage the whole team. */
const BYPASS_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

/** A member's role plus their per-resource access scoping (see Membership in schema.prisma). */
export interface MembershipAccess {
  role: Role;
  restrictedAccess: boolean;
  accessedProjects: string[];
  accessedResources: string[];
}

/** True when scoping actually constrains this member (a restricted VIEWER). OWNER/ADMIN and
 *  unrestricted members are never constrained. Pure — safe to call anywhere. */
export function isScoped(m: MembershipAccess | null | undefined): boolean {
  return !!m && !BYPASS_ROLES.includes(m.role) && m.restrictedAccess;
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

  // ---- per-resource scoping -------------------------------------------------

  /** The member's role + scoping for one team (null if not a member). */
  async membershipAccess(userId: string, teamId: string): Promise<MembershipAccess | null> {
    const m = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true, restrictedAccess: true, accessedProjects: true, accessedResources: true },
    });
    return m ?? null;
  }

  /** Bulk scoping for every team the user belongs to (for list-view filtering, no N+1). */
  async accessByTeam(userId: string): Promise<Map<string, MembershipAccess>> {
    const ms = await this.prisma.membership.findMany({
      where: { userId },
      select: { teamId: true, role: true, restrictedAccess: true, accessedProjects: true, accessedResources: true },
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
