import { Role, ServerStatus } from "@prisma/client";
// Signature verification is exercised elsewhere; here we drive the auth branch deterministically.
jest.mock("./agent-auth", () => ({ ...jest.requireActual("./agent-auth"), verifyEd25519: jest.fn(() => true) }));
import { ServersService } from "./servers.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const notifications = { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as import("../notifications/notifications.service").NotificationsService;
const regenerateMagicForServer = jest.fn().mockResolvedValue(undefined);
// ModuleRef stub: setNetwork resolves ApplicationsService lazily to regenerate magic domains.
const moduleRef = { get: jest.fn().mockReturnValue({ regenerateMagicForServer }) } as unknown as import("@nestjs/core").ModuleRef;
// Crypto stub: base64 so the plaintext isn't a literal substring — tests can assert
// the creds were encrypted (not persisted raw).
const crypto = {
  encrypt: (s: string) => "enc:" + Buffer.from(s).toString("base64"),
  decrypt: (s: string) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString(),
} as unknown as import("../crypto/crypto.service").CryptoService;

function svcWith(prisma: Partial<PrismaService>): ServersService {
  // A real TeamAccessService over the same prisma mock — the membership rows drive resolvePermissions
  // (OWNER/ADMIN → all permissions, VIEWER → none), so the existing role-based mocks still work.
  return new ServersService(
    prisma as PrismaService,
    audit,
    notifications,
    moduleRef,
    crypto,
    new TeamAccessService(prisma as PrismaService),
  );
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

describe("ServersService.getForUser (cluster membership exposed)", () => {
  it("resolves clusterId + clusterName from the server's cluster relation", async () => {
    const prisma = {
      ...owner(),
      server: {
        findUnique: jest.fn().mockResolvedValue({ ...row("s1", "teamA"), clusterId: "c1", cluster: { name: "edge-eu" } }),
      },
    } as unknown as PrismaService;
    const view = await svcWith(prisma).getForUser("u1", "s1");
    expect(view.clusterId).toBe("c1");
    expect(view.clusterName).toBe("edge-eu");
  });

  it("returns null cluster fields for a standalone server", async () => {
    const prisma = {
      ...owner(),
      server: { findUnique: jest.fn().mockResolvedValue({ ...row("s2", "teamA"), clusterId: null, cluster: null }) },
    } as unknown as PrismaService;
    const view = await svcWith(prisma).getForUser("u1", "s2");
    expect(view.clusterId).toBeNull();
    expect(view.clusterName).toBeNull();
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
    ).rejects.toThrow(/insufficient (role|permission)/);
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
      // curl|sh bootstrap: fetch the installer from the HTTP base, run it with the ws URL + token.
      expect(res.installCommand).toContain("curl -fsSL https://hub.example.com/install/agent.sh");
      expect(res.installCommand).toContain("sh -s -- --hub wss://hub.example.com/agent --token ");
      expect(res.installCommand).toContain("wss://hub.example.com/agent"); // ws mapping unchanged
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

  it("persists provider + cloudCredentialId when provisioning metadata is passed", async () => {
    const create = jest.fn().mockResolvedValue(row("s1", "teamA"));
    const prisma = {
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
      server: { create },
    } as unknown as PrismaService;
    await svcWith(prisma).createServer("u1", "web", "teamA", undefined, { provider: "hetzner", cloudCredentialId: "cc1" });
    expect(create.mock.calls[0][0].data).toMatchObject({ provider: "hetzner", cloudCredentialId: "cc1" });
  });
});

describe("ServersService.deleteForUser (destroy VM)", () => {
  function svcForDelete(prisma: Partial<PrismaService>, destroyVm = jest.fn().mockResolvedValue(undefined)) {
    const mr = {
      get: jest.fn().mockImplementation((tok: string) =>
        tok === "PROVISIONING_SERVICE" ? { destroyVm } : { releaseResources: jest.fn().mockResolvedValue(undefined) },
      ),
    } as unknown as import("@nestjs/core").ModuleRef;
    const svc = new ServersService(prisma as PrismaService, audit, notifications, mr, crypto, new TeamAccessService(prisma as PrismaService));
    return { svc, destroyVm };
  }

  const provisioned = { id: "s1", teamId: "teamA", provider: "hetzner", providerServerId: "42", cloudCredentialId: "cc1" };

  it("destroys the VM for a provisioned server when destroyVm is requested", async () => {
    const prisma = { ...owner(), server: { findUnique: jest.fn().mockResolvedValue(provisioned), delete: jest.fn().mockResolvedValue(undefined) } } as unknown as PrismaService;
    const { svc, destroyVm } = svcForDelete(prisma);
    await svc.deleteForUser("u1", "s1", { destroyVm: true });
    expect(destroyVm).toHaveBeenCalledWith("hetzner", "cc1", "42");
    expect(prisma.server!.delete as jest.Mock).toHaveBeenCalledWith({ where: { id: "s1" } });
  });

  it("still deletes the row when destroyVm rejects (best-effort)", async () => {
    const prisma = { ...owner(), server: { findUnique: jest.fn().mockResolvedValue(provisioned), delete: jest.fn().mockResolvedValue(undefined) } } as unknown as PrismaService;
    const { svc } = svcForDelete(prisma, jest.fn().mockRejectedValue(new Error("provider down")));
    await svc.deleteForUser("u1", "s1", { destroyVm: true });
    expect(prisma.server!.delete as jest.Mock).toHaveBeenCalled();
  });

  it("does NOT destroy for a manually-enrolled server (no provider fields)", async () => {
    const prisma = {
      ...owner(),
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "teamA", provider: null, providerServerId: null, cloudCredentialId: null }), delete: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const { svc, destroyVm } = svcForDelete(prisma);
    await svc.deleteForUser("u1", "s1", { destroyVm: true });
    expect(destroyVm).not.toHaveBeenCalled();
    expect(prisma.server!.delete as jest.Mock).toHaveBeenCalled();
  });

  it("refuses to delete a server still joined to a cluster's swarm, and never deletes the row", async () => {
    const prisma = {
      ...owner(),
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "teamA", swarmRole: "MANAGER", provider: null, providerServerId: null, cloudCredentialId: null }), delete: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const { svc } = svcForDelete(prisma);
    await expect(svc.deleteForUser("u1", "s1")).rejects.toThrow(/swarm/i);
    expect(prisma.server!.delete as jest.Mock).not.toHaveBeenCalled();
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

  function pendingServer(over: Record<string, unknown> = {}) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1",
          status: ServerStatus.PENDING,
          enrollTokenExpiresAt: new Date(Date.now() + 60_000),
          ipSource: "observed",
          ...over,
        }),
        update,
      },
    } as unknown as PrismaService;
    return { prisma, update };
  }
  const enrollWith = (prisma: PrismaService, observedIp?: string) =>
    svcWith(prisma).enroll({ token: "t", publicKey: "k", agentVersion: "v", hostname: "h", observedIp });

  it("stores an observed IPv4 as the server's public IP on enroll", async () => {
    const { prisma, update } = pendingServer();
    await enrollWith(prisma, "203.0.113.7");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ publicIp: "203.0.113.7", ipSource: "observed" }) }),
    );
  });

  it("stores an observed IPv6 in publicIpv6 on enroll", async () => {
    const { prisma, update } = pendingServer();
    await enrollWith(prisma, "2001:db8::1");
    const data = update.mock.calls[0][0].data;
    expect(data.publicIpv6).toBe("2001:db8::1");
    expect(data.publicIp).toBeUndefined();
  });

  it("never overrides a manually-pinned IP with the observed one", async () => {
    const { prisma, update } = pendingServer({ ipSource: "manual" });
    await enrollWith(prisma, "203.0.113.7");
    const data = update.mock.calls[0][0].data;
    expect(data.publicIp).toBeUndefined();
    expect(data.ipSource).toBeUndefined();
  });

  it("does not store a loopback observed IP (not a reachable address)", async () => {
    const { prisma, update } = pendingServer();
    await enrollWith(prisma, "127.0.0.1");
    const data = update.mock.calls[0][0].data;
    expect(data.publicIp).toBeUndefined();
    expect(data.ipSource).toBeUndefined();
  });
});

describe("ServersService.markOnline (server_online recovery edge)", () => {
  beforeEach(() => (notifications.fireForEvent as jest.Mock).mockClear());

  const onlineRow = { id: "s1", name: "node-1", teamId: "teamA", hostname: "h1", publicIp: "1.2.3.4" };
  const withPrev = (status: ServerStatus) => {
    const update = jest.fn().mockResolvedValue(onlineRow);
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ status }), update },
    } as unknown as PrismaService;
    return { prisma, update };
  };

  it("fires server_online ONLY on an OFFLINE→ONLINE recovery edge", async () => {
    const { prisma, update } = withPrev(ServerStatus.OFFLINE);
    await svcWith(prisma).markOnline("s1");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" }, data: expect.objectContaining({ status: ServerStatus.ONLINE }) }),
    );
    expect(notifications.fireForEvent).toHaveBeenCalledWith(
      "teamA",
      "server_online",
      expect.objectContaining({ serverId: "s1", serverName: "node-1", hostname: "h1", publicIp: "1.2.3.4" }),
    );
  });

  it("does NOT fire when the server was already ONLINE (every reconnect would otherwise spam)", async () => {
    const { prisma } = withPrev(ServerStatus.ONLINE);
    await svcWith(prisma).markOnline("s1");
    expect(notifications.fireForEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire when the server was PENDING (first enroll is not a recovery)", async () => {
    const { prisma } = withPrev(ServerStatus.PENDING);
    await svcWith(prisma).markOnline("s1");
    expect(notifications.fireForEvent).not.toHaveBeenCalled();
  });
});

describe("ServersService.authenticate (agentVersion refresh on reconnect)", () => {
  const authPrisma = () => {
    const update = jest.fn().mockResolvedValue({ id: "s1", teamId: "t", name: "n", hostname: null, publicIp: null });
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ id: "s1", agentPublicKey: "k", ipSource: "observed" }) // authenticate's read
      .mockResolvedValue({ status: ServerStatus.ONLINE }); // markOnline's prev-status read
    return { prisma: { server: { findUnique, update } } as unknown as PrismaService, update };
  };

  it("writes the reported agentVersion into the reconnect update", async () => {
    const { prisma, update } = authPrisma();
    const ok = await svcWith(prisma).authenticate("s1", "nonce", "sig", "1.2.3.4", "0.2.0");
    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" }, data: expect.objectContaining({ agentVersion: "0.2.0" }) }),
    );
  });

  it("does NOT blank agentVersion when the agent omits it (older agent)", async () => {
    const { prisma, update } = authPrisma();
    await svcWith(prisma).authenticate("s1", "nonce", "sig", null);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).not.toHaveProperty("agentVersion");
  });
});

describe("ServersService.saveHostInfo + uptime view", () => {
  const hostInfo = (over: Record<string, unknown> = {}) => ({
    os: "ubuntu",
    osVersion: "24.04",
    arch: "x86_64",
    kernel: "6.8.0",
    cpuCores: 4,
    memTotalBytes: 8589934592,
    bootTime: 1_700_000_000,
    ...over,
  });

  it("persists host inventory fields", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(null), update },
    } as unknown as PrismaService;
    await svcWith(prisma).saveHostInfo("s1", hostInfo());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: expect.objectContaining({ os: "ubuntu", arch: "x86_64", cpuCores: 4, memTotalBytes: 8589934592n }),
      }),
    );
  });

  it("stores reportedIps and reconciles them when the observed IP is loopback", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({ publicIp: "127.0.0.1", ipSource: "observed" }),
        update,
      },
    } as unknown as PrismaService;
    await svcWith(prisma).saveHostInfo("s1", hostInfo({ reportedIps: ["192.168.1.5", "127.0.0.1"] }));
    const data = update.mock.calls[0][0].data;
    expect(data.reportedIps).toEqual(["192.168.1.5", "127.0.0.1"]);
    expect(data.publicIp).toBe("192.168.1.5");
    expect(data.ipSource).toBe("reported");
  });

  it("keeps a good observed IP and does not reconcile from reported", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", ipSource: "observed" }),
        update,
      },
    } as unknown as PrismaService;
    await svcWith(prisma).saveHostInfo("s1", hostInfo({ reportedIps: ["10.0.0.5"] }));
    const data = update.mock.calls[0][0].data;
    expect(data.reportedIps).toEqual(["10.0.0.5"]);
    expect(data.publicIp).toBeUndefined(); // observed egress kept
    expect(data.ipSource).toBeUndefined();
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
    await expect(svcWith(prisma).setTags("u1", "s1", ["prod"])).rejects.toThrow(/insufficient (role|permission)/);
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

describe("ServersService capabilities", () => {
  it("forbids a VIEWER from changing capabilities", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")) },
      ...owner(Role.VIEWER),
    } as unknown as PrismaService;
    await expect(svcWith(prisma).setCapabilities("u1", "s1", ["deploy"])).rejects.toThrow(/insufficient (role|permission)/);
  });

  it("stores a restricted (deduped, validated) capability set", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setCapabilities("u1", "s1", ["deploy", "deploy", "bogus" as never, "backup"]);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { capabilities: ["deploy", "backup"] } }));
  });

  it("granting EVERY capability is stored verbatim (not collapsed to [] = fail-open)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    const all = ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch"];
    await svcWith(prisma).setCapabilities("u1", "s1", all);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { capabilities: all } }));
  });

  it("unchecking every capability stores [] (deny-all, fail-safe) — never inverts into 'all'", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setCapabilities("u1", "s1", []);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { capabilities: [] } }));
  });

  it("live-pushes the new capability set to the connected agent (agent fail-closed update)", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update: jest.fn().mockResolvedValue({}) },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    const svc = svcWith(prisma);
    const push = jest.fn();
    svc.setCapabilityPusher(push);
    await svc.setCapabilities("u1", "s1", ["deploy", "backup"]);
    expect(push).toHaveBeenCalledWith("s1", ["deploy", "backup"]);
  });

  it("grantedCapabilities returns the stored set", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ capabilities: ["deploy"] }) },
    } as unknown as PrismaService;
    expect(await svcWith(prisma).grantedCapabilities("s1")).toEqual(["deploy"]);
  });
});

describe("ServersService.setNetwork", () => {
  beforeEach(() => regenerateMagicForServer.mockClear());

  it("forbids a VIEWER from changing network settings", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")) },
      ...owner(Role.VIEWER),
    } as unknown as PrismaService;
    await expect(svcWith(prisma).setNetwork("u1", "s1", { wildcardDomain: "apps.example.com" })).rejects.toThrow(
      /insufficient (role|permission)/,
    );
  });

  it("stores a wildcard domain + magic suffix for a writer and regenerates magic domains", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { wildcardDomain: "apps.example.com", magicSuffix: "nip.io" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { wildcardDomain: "apps.example.com", magicSuffix: "nip.io" },
    });
    expect(regenerateMagicForServer).toHaveBeenCalledWith("s1");
  });

  it("persists the proxy bind mode", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { proxyBind: "none" });
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { proxyBind: "none" } });
  });

  it("pins a manual public IP (ipSource=manual) so observations no longer clobber it", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { publicIp: "203.0.113.7" });
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { publicIp: "203.0.113.7", ipSource: "manual" } });
  });

  it("clearing the public IP (null) resumes observation (ipSource=observed)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { publicIp: null });
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { publicIp: null, ipSource: "observed" } });
  });

  it("rejects a non-public manual IP (SSRF/unreachable guard)", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update: jest.fn() },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await expect(svcWith(prisma).setNetwork("u1", "s1", { publicIp: "10.0.0.5" })).rejects.toThrow(/globally routable/);
  });

  it("pins a manual IPv6 (ipSource=manual) so an observed v6 can't clobber it", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { publicIpv6: "2606:4700:4700::1111" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { publicIpv6: "2606:4700:4700::1111", ipSource: "manual" },
    });
  });

  it("normalizes an empty-string IP to null (never persists \"\")", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { publicIp: "" });
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { publicIp: null, ipSource: "observed" } });
  });

  it("does not touch ipSource when only the wildcard domain changes", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { wildcardDomain: "apps.example.com" });
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { wildcardDomain: "apps.example.com" } });
  });

  it("encrypts DNS creds and stores the cert policy — plaintext creds never persisted", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", {
      certMode: "le-dns",
      dnsProvider: "cloudflare",
      dnsCreds: { CF_DNS_API_TOKEN: "s3cr3t" },
    });
    const data = update.mock.calls[0][0].data;
    expect(data.certMode).toBe("le-dns");
    expect(data.dnsProvider).toBe("cloudflare");
    expect(data.dnsCredsEnc).toBe("enc:" + Buffer.from('{"CF_DNS_API_TOKEN":"s3cr3t"}').toString("base64"));
    expect("dnsCreds" in data).toBe(false); // the plaintext record is never written
    expect(JSON.stringify(data)).not.toContain("s3cr3t");
  });

  it("clears stored DNS creds when dnsCreds is null", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { dnsCreds: null });
    expect(update.mock.calls[0][0].data.dnsCredsEnc).toBeNull();
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
    await expect(svcWith(prisma).getInstall("u1", "s1")).rejects.toThrow(/insufficient (role|permission)/);
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
