import { Role, ServerStatus } from "@prisma/client";
import { ServersService } from "./servers.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function svcWith(prisma: Partial<PrismaService>): ServersService {
  return new ServersService(prisma as PrismaService, audit);
}

describe("ServersService.listForUser (cross-team, role-aware)", () => {
  it("returns servers across all the user's teams with correct canWrite", async () => {
    const prisma = {
      membership: {
        findMany: jest.fn().mockResolvedValue([
          { teamId: "teamA", role: Role.OWNER },
          { teamId: "teamB", role: Role.VIEWER },
        ]),
      },
      server: {
        findMany: jest.fn().mockResolvedValue([
          row("s1", "teamA"),
          row("s2", "teamB"),
          row("s3", "teamC"), // not a member — must be filtered out
        ]),
      },
    } as unknown as PrismaService;

    const list = await svcWith(prisma).listForUser("u1");
    expect(list.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(list.find((s) => s.id === "s1")!.canWrite).toBe(true); // OWNER
    expect(list.find((s) => s.id === "s2")!.canWrite).toBe(false); // VIEWER
  });

  it("returns empty when the user is in no teams", async () => {
    const prisma = {
      membership: { findMany: jest.fn().mockResolvedValue([]) },
      server: { findMany: jest.fn() },
    } as unknown as PrismaService;
    expect(await svcWith(prisma).listForUser("u1")).toEqual([]);
  });
});

describe("ServersService.createServer (team role enforced)", () => {
  it("forbids a VIEWER from creating a server", async () => {
    const prisma = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({ role: Role.VIEWER }),
      },
    } as unknown as PrismaService;
    await expect(
      svcWith(prisma).createServer("u1", "web", "teamA"),
    ).rejects.toThrow(/insufficient role/);
  });

  it("lets an OWNER create a server and returns an enroll token", async () => {
    const prisma = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }),
      },
      server: {
        create: jest.fn().mockResolvedValue(row("s1", "teamA")),
      },
    } as unknown as PrismaService;

    const res = await svcWith(prisma).createServer("u1", "web", "teamA");
    expect(res.enrollToken).toMatch(/^tugra_en_/);
    expect(res.server.id).toBe("s1");
    expect(res.installCommand).toContain(res.enrollToken);
  });
});

describe("ServersService.enroll (token validation)", () => {
  it("rejects an expired enroll token", async () => {
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1",
          status: ServerStatus.PENDING,
          enrollTokenExpiresAt: new Date(Date.now() - 1000),
        }),
      },
    } as unknown as PrismaService;
    await expect(
      svcWith(prisma).enroll({
        token: "t",
        publicKey: "k",
        agentVersion: "v",
        hostname: "h",
      }),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("enrolls a valid pending server and issues a seal", async () => {
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1",
          status: ServerStatus.PENDING,
          enrollTokenExpiresAt: new Date(Date.now() + 60_000),
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const res = await svcWith(prisma).enroll({
      token: "t",
      publicKey: "k",
      agentVersion: "v",
      hostname: "h",
    });
    expect(res.serverId).toBe("s1");
    expect(res.seal).toMatch(/^seal_/);
  });
});

function row(id: string, teamId: string) {
  return {
    id,
    name: `name-${id}`,
    status: ServerStatus.PENDING,
    teamId,
    hostname: null,
    lastSeenAt: null,
    createdAt: new Date(),
  };
}
