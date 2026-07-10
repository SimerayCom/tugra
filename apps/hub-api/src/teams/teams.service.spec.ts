import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { TeamsService } from "./teams.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { MailService } from "../mail/mail.service";
import { TeamDefaultsService } from "./team-defaults.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const ensureDefaults = jest.fn().mockResolvedValue(undefined);
const teamDefaults = { ensureDefaults } as unknown as TeamDefaultsService;
const mail = { send: jest.fn().mockResolvedValue(true), isConfigured: () => true } as unknown as MailService;
const config = { get: () => "http://localhost:3001" } as unknown as ConfigService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new TeamsService(prisma as PrismaService, access as TeamAccessService, audit, teamDefaults, mail, config);
}

describe("TeamsService", () => {
  it("creates a team with the creator as OWNER and bootstraps its defaults atomically", async () => {
    ensureDefaults.mockClear();
    const create = jest.fn().mockResolvedValue({ id: "t1", name: "Acme" });
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ team: { create } })),
    } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService);
    const view = await svc.create("u1", "Acme");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ memberships: { create: { userId: "u1", role: Role.OWNER } } }) }),
    );
    // Defaults bootstrapped inside the same transaction as the team.
    expect(ensureDefaults).toHaveBeenCalledWith("t1", expect.anything());
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

  it("invites a user, returns the token, and emails the accept link", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: "i1", email: "b@x.com", role: Role.VIEWER, token: "tok", expiresAt: new Date() });
    const prisma = {
      // 1st user.findUnique = the "already a member?" check (by email → null); 2nd = inviter (by id).
      user: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ name: "Alice" }) },
      team: { findUnique: jest.fn().mockResolvedValue({ name: "Platform" }) },
      teamInvitation: { upsert },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    (mail.send as jest.Mock).mockClear();
    (mail.send as jest.Mock).mockResolvedValue(true);
    const inv = await make(prisma, access).invite("u1", "t1", "B@X.com", Role.VIEWER);
    expect(inv.token).toBe("tok"); // copy-link UX preserved — token still returned
    expect(upsert.mock.calls[0][0].create.email).toBe("b@x.com"); // lowercased
    // emailed to the invitee, carrying the accept link with the EXACT stored token + team name
    expect(mail.send).toHaveBeenCalledTimes(1);
    const storedToken = upsert.mock.calls[0][0].create.token as string;
    const [to, email] = (mail.send as jest.Mock).mock.calls[0];
    expect(to).toBe("b@x.com");
    expect(email.html).toContain(`/teams?invite=${storedToken}`);
    expect(email.html).toContain("Platform");
  });

  it("still creates the invitation (returns the token) when the mailer fails — fail-soft", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: "i1", email: "b@x.com", role: Role.VIEWER, token: "tok", expiresAt: new Date() });
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ name: null }) },
      team: { findUnique: jest.fn().mockResolvedValue({ name: "Platform" }) },
      teamInvitation: { upsert },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    (mail.send as jest.Mock).mockClear();
    (mail.send as jest.Mock).mockResolvedValue(false); // mailer unconfigured / send failed
    const inv = await make(prisma, access).invite("u1", "t1", "b@x.com", Role.VIEWER);
    expect(inv.token).toBe("tok");
    (mail.send as jest.Mock).mockResolvedValue(true); // restore for other tests
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

describe("TeamsService.setMemberAccess", () => {
  it("forbids a non-manager (VIEWER) from changing member access", async () => {
    const access = { requireRole: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role for this team")) } as unknown as TeamAccessService;
    await expect(
      make({} as PrismaService, access).setMemberAccess("viewer", "t1", "target", { restrictedAccess: true, accessedProjects: ["p1"] }),
    ).rejects.toThrow(/insufficient role/);
  });

  it("restricts a member and keeps only projects that belong to the team (drops cross-team ids)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      membership: { findUnique: jest.fn().mockResolvedValue({ userId: "target", teamId: "t1", role: Role.VIEWER }), update },
      // Only p1 belongs to t1; p-foreign is a cross-team id and must be silently dropped.
      project: { findMany: jest.fn().mockResolvedValue([{ id: "p1" }]) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).setMemberAccess("owner", "t1", "target", {
      restrictedAccess: true,
      accessedProjects: ["p1", "p-foreign"],
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { restrictedAccess: true, accessedProjects: ["p1"] } }),
    );
  });

  it("404s when the target is not a member", async () => {
    const prisma = { membership: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access).setMemberAccess("owner", "t1", "ghost", { restrictedAccess: false, accessedProjects: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
