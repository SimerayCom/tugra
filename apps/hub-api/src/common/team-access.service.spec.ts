import { Role } from "@prisma/client";
import { ForbiddenException } from "@nestjs/common";
import {
  TeamAccessService,
  canAccessProject,
  canAccessResource,
  isScoped,
  resolvePermissions,
  type MembershipAccess,
} from "./team-access.service";
import { PrismaService } from "../prisma/prisma.service";

describe("resolvePermissions (built-in tiers + custom roles)", () => {
  it("grants OWNER and ADMIN every permission", () => {
    expect(resolvePermissions({ role: Role.OWNER }).has("servers:manage")).toBe(true);
    expect(resolvePermissions({ role: Role.ADMIN }).has("apps:deploy")).toBe(true);
    expect(resolvePermissions({ role: Role.OWNER }).size).toBeGreaterThanOrEqual(12);
  });

  it("grants VIEWER nothing", () => {
    expect(resolvePermissions({ role: Role.VIEWER }).size).toBe(0);
  });

  it("a custom role grants exactly its permission set, overriding the enum tier", () => {
    const perms = resolvePermissions({ role: Role.VIEWER, teamRole: { permissions: ["apps:deploy", "monitors"] } });
    expect([...perms].sort()).toEqual(["apps:deploy", "monitors"]);
    expect(perms.has("databases")).toBe(false);
  });

  it("filters out unknown/invalid permission strings in a custom role", () => {
    const perms = resolvePermissions({ role: Role.VIEWER, teamRole: { permissions: ["apps:deploy", "totally:bogus", ""] } });
    expect([...perms]).toEqual(["apps:deploy"]);
  });

  it("returns an empty set for a null membership", () => {
    expect(resolvePermissions(null).size).toBe(0);
  });
});

const m = (over: Partial<MembershipAccess>): MembershipAccess => ({
  role: Role.VIEWER,
  teamRoleId: null,
  restrictedAccess: false,
  accessedProjects: [],
  accessedResources: [],
  ...over,
});

describe("team-access scoping (pure)", () => {
  it("isScoped only for a restricted non-owner/admin member", () => {
    expect(isScoped(null)).toBe(false);
    expect(isScoped(m({ role: Role.OWNER, restrictedAccess: true }))).toBe(false); // owner bypasses
    expect(isScoped(m({ role: Role.ADMIN, restrictedAccess: true }))).toBe(false); // admin bypasses
    expect(isScoped(m({ role: Role.VIEWER, restrictedAccess: false }))).toBe(false); // not restricted
    expect(isScoped(m({ role: Role.VIEWER, restrictedAccess: true }))).toBe(true);
    // A custom-role member is permission-based and team-wide — scoping never constrains them
    // (their writes are permission-gated, so a "restriction" would silently not apply to writes).
    expect(isScoped(m({ role: Role.VIEWER, teamRoleId: "role1", restrictedAccess: true }))).toBe(false);
  });

  it("OWNER/ADMIN and unrestricted members access every project/resource", () => {
    for (const mem of [
      m({ role: Role.OWNER, restrictedAccess: true, accessedProjects: [] }),
      m({ role: Role.ADMIN, restrictedAccess: true }),
      m({ role: Role.VIEWER, restrictedAccess: false }),
    ]) {
      expect(canAccessProject(mem, "p-any")).toBe(true);
      expect(canAccessResource(mem, "r-any", "p-any")).toBe(true);
    }
  });

  it("a restricted VIEWER only reaches granted projects — empty grant = nothing (fail-safe)", () => {
    const none = m({ role: Role.VIEWER, restrictedAccess: true, accessedProjects: [] });
    expect(canAccessProject(none, "p1")).toBe(false);
    expect(canAccessResource(none, "r1", "p1")).toBe(false);

    const granted = m({ role: Role.VIEWER, restrictedAccess: true, accessedProjects: ["p1"] });
    expect(canAccessProject(granted, "p1")).toBe(true);
    expect(canAccessProject(granted, "p2")).toBe(false);
  });

  it("a project grant cascades to that project's resources; a direct resource grant also works", () => {
    const viaProject = m({ role: Role.VIEWER, restrictedAccess: true, accessedProjects: ["p1"] });
    expect(canAccessResource(viaProject, "r1", "p1")).toBe(true); // cascades from project
    expect(canAccessResource(viaProject, "r2", "p2")).toBe(false);

    const viaResource = m({ role: Role.VIEWER, restrictedAccess: true, accessedResources: ["r9"] });
    expect(canAccessResource(viaResource, "r9", "p2")).toBe(true); // direct grant, any project
    expect(canAccessResource(viaResource, "r8", "p2")).toBe(false);
  });

  it("a null membership never has access", () => {
    expect(canAccessProject(null, "p1")).toBe(false);
    expect(canAccessResource(null, "r1", "p1")).toBe(false);
  });
});

describe("TeamAccessService.requireResourceAccess (lazy project resolution)", () => {
  const svc = (membership: MembershipAccess | null) =>
    new TeamAccessService({
      membership: { findUnique: jest.fn().mockResolvedValue(membership) },
    } as unknown as PrismaService);

  it("skips the project lookup entirely for an unrestricted member", async () => {
    const resolveProjectId = jest.fn();
    await svc(m({ role: Role.OWNER, restrictedAccess: false })).requireResourceAccess("u1", "t1", {
      resourceId: "r1",
      resolveProjectId,
    });
    expect(resolveProjectId).not.toHaveBeenCalled(); // no env/project query on the common path
  });

  it("resolves the project and denies a restricted member without the grant", async () => {
    const resolveProjectId = jest.fn().mockResolvedValue("p-forbidden");
    await expect(
      svc(m({ role: Role.VIEWER, restrictedAccess: true, accessedProjects: ["p-ok"] })).requireResourceAccess(
        "u1",
        "t1",
        { resourceId: "r1", resolveProjectId },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(resolveProjectId).toHaveBeenCalledTimes(1);
  });

  it("allows a restricted member whose granted project matches the resource", async () => {
    await expect(
      svc(m({ role: Role.VIEWER, restrictedAccess: true, accessedProjects: ["p-ok"] })).requireResourceAccess(
        "u1",
        "t1",
        { resourceId: "r1", resolveProjectId: () => Promise.resolve("p-ok") },
      ),
    ).resolves.toBeUndefined();
  });

  it("denies a non-member (no membership row)", async () => {
    await expect(
      svc(null).requireResourceAccess("u1", "t1", { resourceId: "r1", resolveProjectId: () => Promise.resolve(null) }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
