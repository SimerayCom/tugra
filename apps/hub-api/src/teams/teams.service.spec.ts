import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { TeamsService } from "./teams.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new TeamsService(prisma as PrismaService, access as TeamAccessService, audit);
}

describe("TeamsService", () => {
  it("creates a team with the creator as OWNER", async () => {
    const create = jest.fn().mockResolvedValue({ id: "t1", name: "Acme" });
    const svc = make({ team: { create } } as unknown as PrismaService, {} as TeamAccessService);
    const view = await svc.create("u1", "Acme");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ memberships: { create: { userId: "u1", role: Role.OWNER } } }) }),
    );
    expect(view.role).toBe(Role.OWNER);
  });

  it("forbids rename for a viewer", async () => {
    const access = { requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(make({} as PrismaService, access).rename("u1", "t1", "x")).rejects.toThrow(/nope/);
  });

  it("refuses to delete a team that still has resources", async () => {
    const prisma = {
      server: { count: jest.fn().mockResolvedValue(1) },
      application: { count: jest.fn().mockResolvedValue(0) },
      database: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    await expect(make(prisma, access).remove("u1", "t1")).rejects.toThrow(ConflictException);
  });

  it("delete requires owner (admin rejected)", async () => {
    const access = { teamRole: jest.fn().mockResolvedValue(Role.ADMIN) } as unknown as TeamAccessService;
    await expect(make({} as PrismaService, access).remove("u1", "t1")).rejects.toThrow(/owner/);
  });

  it("refuses to demote the last owner", async () => {
    const prisma = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }),
        count: jest.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue(Role.OWNER),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access).setRole("u1", "t1", "u2", Role.ADMIN)).rejects.toThrow(ConflictException);
  });

  it("invites a user and returns a token", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: "i1", email: "b@x.com", role: Role.VIEWER, token: "tok", expiresAt: new Date() });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      teamInvitation: { upsert },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const inv = await make(prisma, access).invite("u1", "t1", "B@X.com", Role.VIEWER);
    expect(inv.token).toBe("tok");
    expect(upsert.mock.calls[0][0].create.email).toBe("b@x.com"); // lowercased
  });

  it("rejects inviting an existing member", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: "u2" }) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue(Role.VIEWER),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access).invite("u1", "t1", "b@x.com", Role.VIEWER)).rejects.toThrow(ConflictException);
  });

  it("rejects accepting an invitation for a different account", async () => {
    const prisma = {
      teamInvitation: { findUnique: jest.fn().mockResolvedValue({ id: "i1", email: "b@x.com", teamId: "t1", expiresAt: new Date(Date.now() + 1e6) }) },
      user: { findUnique: jest.fn().mockResolvedValue({ email: "other@x.com" }) },
    } as unknown as PrismaService;
    await expect(make(prisma, {} as TeamAccessService).acceptInvitation("u2", "tok")).rejects.toThrow(/different account/);
  });
});

describe("TeamsService.get", () => {
  const teamRow = { id: "t1", name: "Shop", _count: { memberships: 3 } };

  it("returns the team view for a member", async () => {
    const prisma = { team: { findUnique: jest.fn().mockResolvedValue(teamRow) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue(Role.ADMIN) } as unknown as TeamAccessService;
    const view = await make(prisma, access).get("u1", "t1");
    expect(view).toEqual({ id: "t1", name: "Shop", role: Role.ADMIN, memberCount: 3 });
  });

  it("throws NotFound when the team does not exist", async () => {
    const prisma = { team: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    await expect(make(prisma, {} as TeamAccessService).get("u1", "gone")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("forbids a non-member", async () => {
    const prisma = { team: { findUnique: jest.fn().mockResolvedValue(teamRow) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue(null) } as unknown as TeamAccessService;
    await expect(make(prisma, access).get("u9", "t1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
