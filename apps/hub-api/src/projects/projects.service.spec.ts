import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ProjectsService } from "./projects.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new ProjectsService(prisma as PrismaService, access as TeamAccessService, audit);
}

describe("ProjectsService", () => {
  it("creates a project with a default production environment", async () => {
    const create = jest.fn().mockResolvedValue({ id: "p1" });
    const prisma = {
      project: {
        create,
        findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1", name: "web", environments: [{ id: "e1", name: "production", createdAt: new Date() }], createdAt: new Date() }),
      },
      application: { findMany: jest.fn().mockResolvedValue([]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue(Role.OWNER),
    } as unknown as TeamAccessService;
    const view = await make(prisma, access).create("u1", "t1", "web");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ teamId: "t1", name: "web", environments: { create: { name: "production" } } }) }),
    );
    expect(view.environments[0].name).toBe("production");
  });

  it("forbids creating a project for a team the user can't write to", async () => {
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(make({} as PrismaService, access).create("u1", "t1", "web")).rejects.toThrow(/nope/);
  });

  it("lists projects grouped by the user's teams with resource counts", async () => {
    const prisma = {
      project: {
        findMany: jest.fn().mockResolvedValue([
          { id: "p1", teamId: "t1", name: "web", environments: [{ id: "e1", name: "production", createdAt: new Date() }], createdAt: new Date() },
        ]),
      },
      application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", environmentId: "e1" }]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      roleByTeam: jest.fn().mockResolvedValue(new Map([["t1", Role.ADMIN]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access).list("u1");
    expect(out[0].environments[0].appCount).toBe(1);
    expect(out[0].canWrite).toBe(true);
  });

  it("refuses to remove a project whose environments still hold resources", async () => {
    const prisma = {
      project: { findUnique: jest.fn().mockResolvedValue({ id: "p1", teamId: "t1" }) },
      environment: { findMany: jest.fn().mockResolvedValue([{ id: "e1" }]) },
      application: { count: jest.fn().mockResolvedValue(1) },
      database: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access).remove("u1", "p1")).rejects.toThrow(ConflictException);
  });

  it("refuses to remove an environment that still holds resources", async () => {
    const prisma = {
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", projectId: "p1", project: { teamId: "t1" } }) },
      application: { count: jest.fn().mockResolvedValue(0) },
      database: { count: jest.fn().mockResolvedValue(2) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access).removeEnvironment("u1", "e1")).rejects.toThrow(ConflictException);
  });
});
