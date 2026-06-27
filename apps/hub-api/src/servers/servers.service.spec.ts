import { Role, ServerStatus } from "@prisma/client";
import { ServersService } from "./servers.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const notifications = { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as import("../notifications/notifications.service").NotificationsService;

function svcWith(prisma: Partial<PrismaService>): ServersService {
  return new ServersService(prisma as PrismaService, audit, notifications);
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

  it("builds the install command from HUB_PUBLIC_URL (http→ws), no placeholder", async () => {
    const prev = process.env.HUB_PUBLIC_URL;
    process.env.HUB_PUBLIC_URL = "https://hub.example.com";
    try {
      const prisma = {
        membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
        server: { create: jest.fn().mockResolvedValue(row("s1", "teamA")) },
      } as unknown as PrismaService;
      const res = await svcWith(prisma).createServer("u1", "web", "teamA");
      expect(res.installCommand).toContain("wss://hub.example.com/agent");
      expect(res.installCommand).not.toContain("<YOUR_HUB_URL>");
    } finally {
      if (prev === undefined) delete process.env.HUB_PUBLIC_URL;
      else process.env.HUB_PUBLIC_URL = prev;
    }
  });

  it("falls back to the request public URL when HUB_PUBLIC_URL is unset", async () => {
    const prev = process.env.HUB_PUBLIC_URL;
    delete process.env.HUB_PUBLIC_URL;
    try {
      const prisma = {
        membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
        server: { create: jest.fn().mockResolvedValue(row("s1", "teamA")) },
      } as unknown as PrismaService;
      const res = await svcWith(prisma).createServer("u1", "web", "teamA", "http://1.2.3.4:39000");
      expect(res.installCommand).toContain("ws://1.2.3.4:39000/agent");
    } finally {
      if (prev !== undefined) process.env.HUB_PUBLIC_URL = prev;
    }
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

describe("ServersService.saveHostInfo + uptime view", () => {
  it("persists host inventory fields", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { server: { update } } as unknown as PrismaService;
    await svcWith(prisma).saveHostInfo("s1", {
      os: "ubuntu",
      osVersion: "24.04",
      arch: "x86_64",
      kernel: "6.8.0",
      cpuCores: 4,
      memTotalBytes: 8589934592,
      bootTime: 1_700_000_000,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: expect.objectContaining({ os: "ubuntu", arch: "x86_64", cpuCores: 4, memTotalBytes: 8589934592n }),
      }),
    );
  });

  it("derives uptimeSeconds from bootTime in the view", async () => {
    const bootTime = new Date(Date.now() - 3600 * 1000); // 1h ago
    const prisma = {
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
      server: { findUnique: jest.fn().mockResolvedValue({ ...row("s1", "teamA"), bootTime, memTotalBytes: 1024n }) },
    } as unknown as PrismaService;
    const view = await svcWith(prisma).getForUser("u1", "s1");
    expect(view.uptimeSeconds).toBeGreaterThanOrEqual(3590);
    expect(view.memTotalBytes).toBe("1024");
  });
});

describe("ServersService.setTags", () => {
  it("forbids a VIEWER from setting tags", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")) },
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.VIEWER }) },
    } as unknown as PrismaService;
    await expect(svcWith(prisma).setTags("u1", "s1", ["prod"])).rejects.toThrow(/insufficient role/);
  });

  it("normalizes and stores tags for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
    } as unknown as PrismaService;
    await svcWith(prisma).setTags("u1", "s1", ["EU", "eu", " edge "]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" }, data: { tags: ["edge", "eu"] } }),
    );
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

const owner = (role: Role = Role.OWNER) => ({ membership: { findUnique: jest.fn().mockResolvedValue({ role }) } });

describe("ServersService.getInstall", () => {
  it("reveals the install command for a valid PENDING server to a writer", async () => {
    const prisma = {
      ...owner(),
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "teamA", status: ServerStatus.PENDING,
          enrollToken: "tugra_en_abc", enrollTokenExpiresAt: new Date(Date.now() + 60_000),
        }),
      },
    } as unknown as PrismaService;
    const res = await svcWith(prisma).getInstall("u1", "s1");
    expect(res.installCommand).toContain("tugra_en_abc");
    expect(res.status).toBe(ServerStatus.PENDING);
  });

  it("returns null command when the token has expired", async () => {
    const prisma = {
      ...owner(),
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "teamA", status: ServerStatus.PENDING,
          enrollToken: "tugra_en_abc", enrollTokenExpiresAt: new Date(Date.now() - 1000),
        }),
      },
    } as unknown as PrismaService;
    expect((await svcWith(prisma).getInstall("u1", "s1")).installCommand).toBeNull();
  });

  it("returns null command once the server is ONLINE", async () => {
    const prisma = {
      ...owner(),
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "teamA", status: ServerStatus.ONLINE,
          enrollToken: "tugra_en_abc", enrollTokenExpiresAt: new Date(Date.now() + 60_000),
        }),
      },
    } as unknown as PrismaService;
    expect((await svcWith(prisma).getInstall("u1", "s1")).installCommand).toBeNull();
  });

  it("forbids a non-writer (VIEWER)", async () => {
    const prisma = {
      ...owner(Role.VIEWER),
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")) },
    } as unknown as PrismaService;
    await expect(svcWith(prisma).getInstall("u1", "s1")).rejects.toThrow(/insufficient role/);
  });
});

describe("ServersService.reissueEnroll", () => {
  it("mints a fresh token + command for a PENDING server", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      ...owner(),
      server: {
        findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "teamA", status: ServerStatus.PENDING }),
        update,
      },
    } as unknown as PrismaService;
    const res = await svcWith(prisma).reissueEnroll("u1", "s1");
    expect(res.installCommand).toMatch(/tugra_en_/);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1" } }));
  });

  it("rejects reissue once the server is enrolled (ONLINE)", async () => {
    const prisma = {
      ...owner(),
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "teamA", status: ServerStatus.ONLINE }) },
    } as unknown as PrismaService;
    await expect(svcWith(prisma).reissueEnroll("u1", "s1")).rejects.toThrow(/already enrolled/);
  });
});
