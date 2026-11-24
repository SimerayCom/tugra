import { of, lastValueFrom } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Role } from "@prisma/client";
import { isPortalRoute, normalizeApiPath, portalContext, portalMembershipsHidden } from "./portal-surface";
import { PortalSurfaceInterceptor } from "./portal-surface.interceptor";
import { TeamAccessService } from "./team-access.service";
import type { PrismaService } from "../prisma/prisma.service";

describe("portal surface (Client role)", () => {
  it("allows only the team's apps, uptime, backups and deploy", () => {
    for (const [m, p] of [
      ["GET", "/api/v1/teams"],
      ["GET", "/api/v1/teams/t1"],
      ["GET", "/api/v1/apps"],
      ["GET", "/api/v1/apps/a1"],
      ["GET", "/api/v1/apps/a1/deployments"],
      ["GET", "/api/v1/apps/a1/deployments/d1"],
      ["GET", "/api/v1/apps/a1/volume-backups"],
      ["GET", "/api/v1/monitors"],
      ["GET", "/api/v1/monitors/m1/heartbeats?limit=60"],
      ["GET", "/api/v1/monitors/m1/uptime"],
      ["GET", "/api/v1/databases/d1/backups"],
      ["GET", "/api/v1/projects"],
      ["POST", "/api/v1/apps/a1/deploy"],
      ["POST", "/api/v1/apps/a1/deploy/"],
    ] as const) {
      expect(isPortalRoute(m, p)).toBe(true);
    }
  });

  it("blocks everything else, including secrets, servers, members and every mutation but deploy", () => {
    for (const [m, p] of [
      ["GET", "/api/v1/servers"],
      ["GET", "/api/v1/servers/s1"],
      ["GET", "/api/v1/apps/a1/env"],
      ["GET", "/api/v1/apps/a1/logs"],
      ["GET", "/api/v1/apps/a1/files"],
      ["GET", "/api/v1/apps/domains"],
      ["GET", "/api/v1/apps/templates"],
      ["GET", "/api/v1/teams/t1/members"],
      ["GET", "/api/v1/teams/t1/roles"],
      ["GET", "/api/v1/teams/t1/invitations"],
      ["GET", "/api/v1/teams/t1/status-page"],
      ["GET", "/api/v1/audit"],
      ["GET", "/api/v1/notifications/channels"],
      ["GET", "/api/v1/databases/d1/env"],
      ["GET", "/api/v1/databases/d1/audit"],
      ["POST", "/api/v1/apps/a1/restart"],
      ["POST", "/api/v1/apps/a1/rollback/d1"],
      ["POST", "/api/v1/monitors/m1/check"],
      ["POST", "/api/v1/databases/d1/backups"],
      ["PUT", "/api/v1/apps/a1/env"],
      ["DELETE", "/api/v1/apps/a1"],
      ["GET", "/api/v1/apps/a1/deploy"],
      ["POST", "/mcp"],
    ] as const) {
      expect(isPortalRoute(m, p)).toBe(false);
    }
  });

  it("normalizes the prefix, query and trailing slash", () => {
    expect(normalizeApiPath("/api/v1/apps/a1/?x=1")).toBe("/apps/a1");
    expect(normalizeApiPath("/api/v1")).toBe("/");
  });

  it("the interceptor marks the request for the whole handler", async () => {
    const seen: (boolean | undefined)[] = [];
    const handler: CallHandler = {
      handle: () => {
        seen.push(portalContext.getStore()?.surface);
        return of(portalMembershipsHidden());
      },
    };
    const ctx = (method: string, path: string) =>
      ({ getType: () => "http", switchToHttp: () => ({ getRequest: () => ({ method, path }) }) }) as unknown as ExecutionContext;
    const icp = new PortalSurfaceInterceptor();
    expect(await lastValueFrom(icp.intercept(ctx("GET", "/api/v1/servers"), handler))).toBe(true);
    expect(await lastValueFrom(icp.intercept(ctx("GET", "/api/v1/apps"), handler))).toBe(false);
    expect(seen).toEqual([false, true]);
    expect(portalMembershipsHidden()).toBe(false); // outside a request nothing is hidden
  });
});

describe("TeamAccessService hides Client memberships off the portal surface", () => {
  const clientMembership = { teamId: "t1", role: Role.VIEWER, teamRole: { portal: true, permissions: ["apps:deploy"] } };
  const prisma = {
    membership: {
      findUnique: jest.fn().mockResolvedValue(clientMembership),
      findMany: jest.fn().mockResolvedValue([clientMembership, { teamId: "t2", role: Role.OWNER, teamRole: null }]),
    },
  } as unknown as PrismaService;
  const access = new TeamAccessService(prisma);
  const off = <T>(fn: () => Promise<T>) => portalContext.run({ surface: false }, fn);
  const on = <T>(fn: () => Promise<T>) => portalContext.run({ surface: true }, fn);

  it("is not a member / has no permission / is absent from team lists off the surface", async () => {
    expect(await off(() => access.teamRole("u1", "t1"))).toBeNull();
    expect(await off(() => access.membershipPermissions("u1", "t1"))).toBeNull();
    await expect(off(() => access.requirePermission("u1", "t1", "apps:deploy"))).rejects.toThrow(/insufficient permission/);
    expect([...(await off(() => access.roleByTeam("u1"))).keys()]).toEqual(["t2"]);
    expect([...(await off(() => access.accessByTeam("u1"))).keys()]).toEqual(["t2"]);
    expect([...(await off(() => access.permissionsByTeam("u1"))).keys()]).toEqual(["t2"]);
    expect(await off(() => access.membershipAccess("u1", "t1"))).toBeNull();
  });

  it("is a normal member on the surface, and with no request context at all", async () => {
    expect(await on(() => access.teamRole("u1", "t1"))).toBe(Role.VIEWER);
    expect([...(await on(() => access.roleByTeam("u1"))).keys()].sort()).toEqual(["t1", "t2"]);
    await expect(on(() => access.requirePermission("u1", "t1", "apps:deploy"))).resolves.toBeUndefined();
    expect(await access.teamRole("u1", "t1")).toBe(Role.VIEWER);
  });

  it("a Client without the deploy permission can never deploy, even on the surface", async () => {
    (prisma.membership.findUnique as jest.Mock).mockResolvedValueOnce({ role: Role.VIEWER, teamRole: { portal: true, permissions: [] } });
    await expect(on(() => access.requirePermission("u1", "t1", "apps:deploy"))).rejects.toThrow(/insufficient permission/);
  });
});
