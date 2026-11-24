import { ConflictException } from "@nestjs/common";
import { Role, ServerStatus } from "@prisma/client";
// Signature verification is exercised elsewhere; here we drive the auth branch deterministically.
jest.mock("./agent-auth", () => ({ ...jest.requireActual("./agent-auth"), verifyEd25519: jest.fn(() => true) }));
import { DEFAULT_CAPABILITIES, ServersService, plainWsNeedsOptIn } from "./servers.service";
import { AGENT_ENDPOINTS_SERVICE } from "../applications/applications.tokens";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NetworkSettingsSchema } from "./dto/servers.schemas";
import { TeamAccessService } from "../common/team-access.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const notifications = { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as import("../notifications/notifications.service").NotificationsService;
const regenerateMagicForServer = jest.fn().mockResolvedValue(undefined);
// ModuleRef stub: setNetwork resolves ApplicationsService lazily (regenerate magic domains); create/delete
// resolve MonitorsService lazily (auto disk monitor create/teardown). One object serves every lazy token.
const createForServer = jest.fn().mockResolvedValue(undefined);
const removeForServer = jest.fn().mockResolvedValue(undefined);
const ensureProxy = jest.fn().mockResolvedValue(undefined);
const moduleRef = { get: jest.fn().mockReturnValue({ regenerateMagicForServer, createForServer, removeForServer, ensureProxy }) } as unknown as import("@nestjs/core").ModuleRef;
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

  it("a cloud/SSH-provisioned server also gets cleanup on by default", async () => {
    const create = jest.fn().mockResolvedValue(row("s1", "teamA"));
    const prisma = {
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
      server: { create },
    } as unknown as PrismaService;
    await svcWith(prisma).createServer("u1", "web", "teamA", undefined, { provider: "hetzner", cloudCredentialId: "cc1" });
    expect(create.mock.calls[0][0].data).toMatchObject({ cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80 });
    // A default is not an operator choice: the explicit flag stays at its schema default (false).
    expect(create.mock.calls[0][0].data).not.toHaveProperty("cleanupExplicit");
  });

  it("turns disk cleanup on by default (daily cron, 80% threshold)", async () => {
    const create = jest.fn().mockResolvedValue(row("s1", "teamA"));
    const prisma = {
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
      server: { create },
    } as unknown as PrismaService;
    await svcWith(prisma).createServer("u1", "web", "teamA");
    expect(create.mock.calls[0][0].data).toMatchObject({ cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80 });
  });
});

describe("ServersService.createServersBulk (fleet fan-out)", () => {
  it("creates one PENDING server per name, each with its own enroll token", async () => {
    const membershipFind = jest.fn().mockResolvedValue({ role: Role.OWNER });
    const create = jest.fn().mockResolvedValue(row("s1", "teamA"));
    const prisma = { membership: { findUnique: membershipFind }, server: { create } } as unknown as PrismaService;
    const res = await svcWith(prisma).createServersBulk("u1", ["web", "api", "worker"], "teamA");
    expect(res.servers).toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(res.servers.every((s) => /^tugra_en_/.test(s.enrollToken) && s.installCommand.includes(s.enrollToken))).toBe(true);
    // The bulk path shares insertServer, so every server is created with cleanup on by default.
    for (const c of create.mock.calls) expect(c[0].data).toMatchObject({ cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80 });
    // servers:manage is checked ONCE up front, not per name.
    expect(membershipFind).toHaveBeenCalledTimes(1);
  });

  it("trims names and drops blanks + duplicates (order preserved)", async () => {
    const create = jest.fn().mockResolvedValue(row("s1", "teamA"));
    const prisma = { membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) }, server: { create } } as unknown as PrismaService;
    const res = await svcWith(prisma).createServersBulk("u1", ["web", " web ", "api", "   ", ""], "teamA");
    expect(res.servers).toHaveLength(2); // "web" (deduped) + "api"
    expect(create.mock.calls.map((c) => c[0].data.name)).toEqual(["web", "api"]);
  });

  it("rejects when nothing valid is left after trimming", async () => {
    const create = jest.fn();
    const prisma = { membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) }, server: { create } } as unknown as PrismaService;
    await expect(svcWith(prisma).createServersBulk("u1", ["  ", ""], "teamA")).rejects.toThrow(/no valid server names/);
    expect(create).not.toHaveBeenCalled();
  });

  it("forbids a VIEWER and writes nothing", async () => {
    const create = jest.fn();
    const prisma = { membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.VIEWER }) }, server: { create } } as unknown as PrismaService;
    await expect(svcWith(prisma).createServersBulk("u1", ["web", "api"], "teamA")).rejects.toThrow(/insufficient (role|permission)/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("ServersService.deleteForUser (destroy VM)", () => {
  function svcForDelete(prisma: Partial<PrismaService>, destroyVm = jest.fn().mockResolvedValue(undefined)) {
    const mr = {
      get: jest.fn().mockImplementation((tok: string) =>
        tok === "PROVISIONING_SERVICE"
          ? { destroyVm }
          : { releaseResources: jest.fn().mockResolvedValue(undefined), removeForServer: jest.fn().mockResolvedValue(undefined) },
      ),
    } as unknown as import("@nestjs/core").ModuleRef;
    // No app move holds this server (the delete guard) unless a test says so.
    const db = { appMove: { findFirst: jest.fn().mockResolvedValue(null) }, ...prisma } as unknown as PrismaService;
    const svc = new ServersService(db, audit, notifications, mr, crypto, new TeamAccessService(db));
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

  it("does NOT destroy a VM an operator linked by hand for out-of-band access (Tugra did not create it)", async () => {
    const prisma = {
      ...owner(),
      server: { findUnique: jest.fn().mockResolvedValue({ ...provisioned, providerManualLink: true }), delete: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const { svc, destroyVm } = svcForDelete(prisma);
    await svc.deleteForUser("u1", "s1", { destroyVm: true });
    expect(destroyVm).not.toHaveBeenCalled();
    expect(prisma.server!.delete as jest.Mock).toHaveBeenCalledWith({ where: { id: "s1" } });
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

  it("does not store a Cloudflare edge address as the server IP (hub behind the orange cloud)", async () => {
    const { prisma, update } = pendingServer();
    await enrollWith(prisma, "172.64.200.190");
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
    expect(ok).toBe("ok");
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

  it("returns 'unknown' when the server row is gone / never enrolled (→ agent re-enrolls)", async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const prisma = { server: { findUnique, update: jest.fn() } } as unknown as PrismaService;
    expect(await svcWith(prisma).authenticate("gone", "nonce", "sig", null)).toBe("unknown");
  });

  it("returns 'bad_signature' for a KNOWN server whose key does not verify (identity KEPT, no re-enroll)", async () => {
    const authAuth = jest.requireMock("./agent-auth") as { verifyEd25519: jest.Mock };
    authAuth.verifyEd25519.mockReturnValueOnce(false);
    const update = jest.fn();
    const findUnique = jest.fn().mockResolvedValue({ id: "s1", agentPublicKey: "k", ipSource: "observed" });
    const prisma = { server: { findUnique, update } } as unknown as PrismaService;
    expect(await svcWith(prisma).authenticate("s1", "nonce", "badsig", null)).toBe("bad_signature");
    expect(update).not.toHaveBeenCalled(); // never marks online on a failed verify
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

  it("stores the HOST hostname reported via the Docker daemon, ignoring an invalid one", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(null), update } } as unknown as PrismaService;
    await svcWith(prisma).saveHostInfo("s1", hostInfo({ hostname: "olgu-omer-ortak-new" }));
    expect(update.mock.calls[0][0].data.hostname).toBe("olgu-omer-ortak-new");
    await svcWith(prisma).saveHostInfo("s1", hostInfo({ hostname: "bad host;rm -rf" }));
    expect(update.mock.calls[1][0].data.hostname).toBeUndefined();
    await svcWith(prisma).saveHostInfo("s1", hostInfo());
    expect(update.mock.calls[2][0].data.hostname).toBeUndefined();
  });

  it("replaces a Cloudflare edge IP recorded earlier with the reported host IP", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "172.64.200.190", ipSource: "observed", isLocal: false }), update },
    } as unknown as PrismaService;
    await svcWith(prisma).saveHostInfo("s1", hostInfo({ reportedIps: ["2.29.218.211", "100.85.166.104"] }));
    const data = update.mock.calls[0][0].data;
    expect(data.publicIp).toBe("2.29.218.211");
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

  it("files_write is opt-in: it needs files, is stored verbatim with it, and is never in the default grant", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    const svc = svcWith(prisma);
    expect(DEFAULT_CAPABILITIES).not.toContain("files_write");
    expect(DEFAULT_CAPABILITIES).not.toContain("files");
    await expect(svc.setCapabilities("u1", "s1", ["deploy", "files_write"])).rejects.toThrow(/files_write requires files/);
    expect(update).not.toHaveBeenCalled();
    await svc.setCapabilities("u1", "s1", ["files", "files_write"]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { capabilities: ["files", "files_write"] } }));
    // dropping files drops files_write in the same write (the caller sends neither)
    await svc.setCapabilities("u1", "s1", ["deploy"]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { capabilities: ["deploy"] } }));
    // files alone (read-only file manager) is unchanged behaviour
    await svc.setCapabilities("u1", "s1", ["files"]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { capabilities: ["files"] } }));
  });

  it("grantedCapabilities returns the stored set", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ capabilities: ["deploy"] }) },
    } as unknown as PrismaService;
    expect(await svcWith(prisma).grantedCapabilities("s1")).toEqual(["deploy"]);
  });
});

describe("ServersService.setCapabilitiesBulk", () => {
  const withCaps = (id: string, teamId: string, capabilities: string[]) => ({ ...row(id, teamId), capabilities });
  const memberships = (roles: Record<string, Role | null>) => ({
    membership: { findUnique: jest.fn().mockImplementation(({ where }: { where: { userId_teamId: { teamId: string } } }) => {
      const role = roles[where.userId_teamId.teamId];
      return Promise.resolve(role ? { role } : null);
    }) },
  });

  it("grants terminal to several servers, merges with the existing set and audits each server", async () => {
    const update = jest.fn().mockResolvedValue({});
    const found: Record<string, ReturnType<typeof withCaps>> = {
      s1: withCaps("s1", "teamA", ["deploy"]),
      s2: withCaps("s2", "teamA", ["deploy", "terminal"]),
    };
    const prisma = {
      server: { findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(found[where.id] ?? null)), update },
      ...memberships({ teamA: Role.OWNER }),
    } as unknown as PrismaService;
    const svc = svcWith(prisma);
    const push = jest.fn();
    svc.setCapabilityPusher(push);
    (audit.log as jest.Mock).mockClear();
    const res = await svc.setCapabilitiesBulk("u1", { serverIds: ["s1", "s2"], grant: ["terminal"], revoke: [] });
    expect(res).toEqual([
      { id: "s1", ok: true, capabilities: ["deploy", "terminal"], granted: ["terminal"], revoked: [] },
      { id: "s2", ok: true, capabilities: ["deploy", "terminal"], granted: [], revoked: [] },
    ]);
    // only the server that actually changed is written and pushed; both get an audit entry
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { capabilities: ["deploy", "terminal"] } });
    expect(push).toHaveBeenCalledTimes(1);
    expect(audit.log as jest.Mock).toHaveBeenCalledTimes(2);
    expect(audit.log as jest.Mock).toHaveBeenCalledWith({ actor: "u1", action: "server.capabilities.bulk", target: "s1", meta: { granted: ["terminal"], revoked: [] } });
  });

  it("revoking files also drops files_write, and files_write alone without files is refused for that server only", async () => {
    const update = jest.fn().mockResolvedValue({});
    const found: Record<string, ReturnType<typeof withCaps>> = {
      s1: withCaps("s1", "teamA", ["deploy", "files", "files_write"]),
      s2: withCaps("s2", "teamA", ["deploy"]),
    };
    const prisma = {
      server: { findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(found[where.id])), update },
      ...memberships({ teamA: Role.OWNER }),
    } as unknown as PrismaService;
    const svc = svcWith(prisma);
    const revoke = await svc.setCapabilitiesBulk("u1", { serverIds: ["s1"], grant: [], revoke: ["files"] });
    expect(revoke[0]).toMatchObject({ id: "s1", ok: true, capabilities: ["deploy"], revoked: ["files", "files_write"] });
    const grant = await svc.setCapabilitiesBulk("u1", { serverIds: ["s1", "s2"], grant: ["files_write"], revoke: [] });
    expect(grant.map((r) => r.ok)).toEqual([true, false]);
    expect(grant[1]).toEqual({ id: "s2", ok: false, error: "files_write_requires_files" });
  });

  it("enforces servers:manage per server team and reports missing servers without blocking the rest", async () => {
    const update = jest.fn().mockResolvedValue({});
    const found: Record<string, ReturnType<typeof withCaps>> = {
      s1: withCaps("s1", "teamA", []),
      s2: withCaps("s2", "teamB", []), // caller is only a VIEWER there
      s3: withCaps("s3", "teamC", []), // caller is not a member at all
    };
    const prisma = {
      server: { findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(found[where.id] ?? null)), update },
      ...memberships({ teamA: Role.OWNER, teamB: Role.VIEWER }),
    } as unknown as PrismaService;
    (audit.log as jest.Mock).mockClear();
    const res = await svcWith(prisma).setCapabilitiesBulk("u1", { serverIds: ["s1", "s2", "s3", "missing"], grant: ["terminal"], revoke: [] });
    expect(res.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "forbidden", "forbidden", "not_found"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { capabilities: ["terminal"] } });
    expect(audit.log as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("ignores capabilities outside the opt-in set (never widens a non-opt-in grant through bulk)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(withCaps("s1", "teamA", ["deploy", "backup"])), update },
      ...memberships({ teamA: Role.OWNER }),
    } as unknown as PrismaService;
    const res = await svcWith(prisma).setCapabilitiesBulk("u1", { serverIds: ["s1"], grant: ["migrate", "terminal"], revoke: ["backup"] });
    expect(res[0]).toMatchObject({ ok: true, capabilities: ["deploy", "backup", "terminal"], granted: ["terminal"], revoked: [] });
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

  it("trims DNS credential values before encrypting and refuses an inner line break (service-level, for MCP/internal callers)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    await svcWith(prisma).setNetwork("u1", "s1", { dnsCreds: { CF_DNS_API_TOKEN: "s3cr3t\n" } });
    expect(update.mock.calls[0][0].data.dnsCredsEnc).toBe("enc:" + Buffer.from('{"CF_DNS_API_TOKEN":"s3cr3t"}').toString("base64"));
    update.mockClear();
    await expect(svcWith(prisma).setNetwork("u1", "s1", { dnsCreds: { CF_DNS_API_TOKEN: "a\nINJECTED=1" } })).rejects.toThrow(/DNS credential CF_DNS_API_TOKEN must be a single line/);
    expect(update).not.toHaveBeenCalled();
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

describe("ServersService.setNetwork dnsFromCredentialId", () => {
  beforeEach(() => ensureProxy.mockClear());
  const cred = (over: Record<string, unknown> = {}) => ({ id: "dc1", teamId: "teamA", provider: "cloudflare", apiTokenEnc: crypto.encrypt("CFTOKEN-xyz"), ...over });
  const prismaWith = (credRow: unknown) => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(row("s1", "teamA")), update },
      dnsCredential: { findUnique: jest.fn().mockResolvedValue(credRow) },
      ...owner(Role.OWNER),
    } as unknown as PrismaService;
    return { prisma, update };
  };

  it("copies the team credential's token (encrypted) into the DNS-01 creds, remembers the credential and applies the proxy WITHOUT force", async () => {
    const { prisma, update } = prismaWith(cred());
    (audit.log as jest.Mock).mockClear();
    await svcWith(prisma).setNetwork("u1", "s1", { dnsFromCredentialId: "dc1" });
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({ certMode: "le-dns", dnsProvider: "cloudflare", dnsCredential: { connect: { id: "dc1" } } });
    expect(data.dnsCredsEnc).toBe("enc:" + Buffer.from('{"CF_DNS_API_TOKEN":"CFTOKEN-xyz"}').toString("base64"));
    expect(ensureProxy).toHaveBeenCalledWith("s1"); // no { force: true }
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("CFTOKEN");
    expect((audit.log as jest.Mock).mock.calls[0][0]).toMatchObject({ action: "server.network.update", meta: { dnsFromCredential: true } });
  });

  it("refuses another team's credential and a non-cloudflare one", async () => {
    await expect(svcWith(prismaWith(cred({ teamId: "teamB" })).prisma).setNetwork("u1", "s1", { dnsFromCredentialId: "dc1" })).rejects.toThrow(/does not belong/);
    await expect(svcWith(prismaWith(cred({ provider: "route53" })).prisma).setNetwork("u1", "s1", { dnsFromCredentialId: "dc1" })).rejects.toThrow(/cloudflare/);
    await expect(svcWith(prismaWith(null).prisma).setNetwork("u1", "s1", { dnsFromCredentialId: "dc1" })).rejects.toThrow(/does not belong/);
    expect(ensureProxy).not.toHaveBeenCalled();
  });

  it("is mutually exclusive with dnsCreds (service and schema)", async () => {
    await expect(svcWith(prismaWith(cred()).prisma).setNetwork("u1", "s1", { dnsFromCredentialId: "dc1", dnsCreds: { CF_DNS_API_TOKEN: "x" } })).rejects.toThrow(/mutually exclusive/);
    expect(NetworkSettingsSchema.safeParse({ dnsFromCredentialId: "dc1", dnsCreds: { A: "b" } }).success).toBe(false);
    expect(NetworkSettingsSchema.safeParse({ dnsFromCredentialId: "dc1" }).success).toBe(true);
  });

  it("null forgets the link only; typed creds disconnect it; neither clears stored creds by itself", async () => {
    const { prisma, update } = prismaWith(cred());
    await svcWith(prisma).setNetwork("u1", "s1", { dnsFromCredentialId: null });
    expect(update.mock.calls[0][0].data).toEqual({ dnsCredential: { disconnect: true } });
    const t = prismaWith(cred());
    await svcWith(t.prisma).setNetwork("u1", "s1", { dnsCreds: { CF_DNS_API_TOKEN: "typed" } });
    expect(t.update.mock.calls[0][0].data.dnsCredential).toEqual({ disconnect: true });
    expect(ensureProxy).not.toHaveBeenCalled();
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

describe("ServersService.deleteForUser — app moves", () => {
  function svcFor(holds: unknown) {
    const prisma = {
      ...owner(),
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "teamA" }), delete: jest.fn().mockResolvedValue(undefined) },
      appMove: { findFirst: jest.fn().mockResolvedValue(holds) },
    } as unknown as PrismaService;
    const mr = { get: jest.fn().mockReturnValue({ releaseResources: jest.fn().mockResolvedValue(undefined), removeForServer: jest.fn().mockResolvedValue(undefined) }) } as unknown as import("@nestjs/core").ModuleRef;
    return { svc: new ServersService(prisma, audit, notifications, mr, crypto, new TeamAccessService(prisma)), prisma };
  }

  it("refuses with 409 server_in_active_move when a move uses the server or an archive/leftover still lives there", async () => {
    const { svc, prisma } = svcFor({ id: "mv1" });
    const e = await svc.deleteForUser("u1", "s1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: "server_in_active_move" });
    expect(prisma.server!.delete as jest.Mock).not.toHaveBeenCalled();
    // the query names all three holders: live move, unpurged completed archive, rolled-back/failed target leftovers
    const where = (prisma.appMove!.findFirst as jest.Mock).mock.calls[0][0].where as { OR: Record<string, unknown>[] };
    expect(where.OR).toHaveLength(3);
    expect(JSON.stringify(where)).toContain("sourcePurgedAt");
    expect(JSON.stringify(where)).toContain("targetPurgedAt");
  });

  it("deletes normally when no move holds the server", async () => {
    const { svc, prisma } = svcFor(null);
    await svc.deleteForUser("u1", "s1");
    expect(prisma.server!.delete as jest.Mock).toHaveBeenCalled();
  });
});


describe("ServersService install command transport (IP mode / domain / plain)", () => {
  const prisma = () =>
    ({
      membership: { findUnique: jest.fn().mockResolvedValue({ role: Role.OWNER }) },
      server: { create: jest.fn().mockResolvedValue(row("s1", "teamA")) },
    }) as unknown as PrismaService;
  const svc = (installTransport: unknown) =>
    new ServersService(
      prisma(),
      audit,
      notifications,
      {
        get: jest.fn((token: string) => (token === AGENT_ENDPOINTS_SERVICE ? { installTransport } : { createForServer })),
      } as unknown as import("@nestjs/core").ModuleRef,
      crypto,
      new TeamAccessService(prisma()),
    );
  const withHub = async (url: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.HUB_PUBLIC_URL;
    if (url === undefined) delete process.env.HUB_PUBLIC_URL;
    else process.env.HUB_PUBLIC_URL = url;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.HUB_PUBLIC_URL;
      else process.env.HUB_PUBLIC_URL = prev;
    }
  };
  const PIN = "sha256:" + "cd".repeat(32);

  it("IP mode: the installer is fetched over the pinned certificate and the agent gets wss://<ip>/agent + the fingerprint", async () => {
    await withHub("http://203.0.113.7", async () => {
      const t = { ip: "203.0.113.7", hubUrl: "wss://203.0.113.7/agent", pin: PIN, spkiPin: "SPKI/base64+pin=", origin: "https://203.0.113.7" };
      const res = await svc(jest.fn().mockResolvedValue(t)).createServer("u1", "web", "teamA");
      expect(res.installCommand).toBe(
        `curl -fsSLk --pinnedpubkey 'sha256//SPKI/base64+pin=' https://203.0.113.7/install/agent.sh | sh -s -- --hub wss://203.0.113.7/agent --hub-pin ${PIN} --token ${res.enrollToken}`,
      );
      expect(res.installCommand).not.toContain("ws://203");
      expect(res.installCommand).not.toContain("--hub-insecure");
    });
  });

  it("IP mode not (yet) served: falls back to plain ws:// and says so with an explicit --hub-insecure", async () => {
    await withHub("http://203.0.113.7", async () => {
      const res = await svc(jest.fn().mockResolvedValue(null)).createServer("u1", "web", "teamA");
      expect(res.installCommand).toContain("--hub ws://203.0.113.7/agent --hub-insecure --token ");
    });
  });

  it("a lookup failure never blocks adding a server", async () => {
    await withHub("https://hub.example.com", async () => {
      const res = await svc(jest.fn().mockRejectedValue(new Error("db"))).createServer("u1", "web", "teamA");
      expect(res.installCommand).toContain("--hub wss://hub.example.com/agent --token ");
    });
  });

  it("a domain hub never carries the insecure flag; a loopback / compose-internal plain hub does not need it", () => {
    expect(plainWsNeedsOptIn("wss://hub.example.com/agent")).toBe(false);
    expect(plainWsNeedsOptIn("ws://localhost:3000/agent")).toBe(false);
    expect(plainWsNeedsOptIn("ws://127.0.0.1:3000/agent")).toBe(false);
    expect(plainWsNeedsOptIn("ws://hub-api:3000/agent")).toBe(false);
    expect(plainWsNeedsOptIn("ws://203.0.113.7:3000/agent")).toBe(true);
    expect(plainWsNeedsOptIn("ws://hub.example.com/agent")).toBe(true);
    expect(plainWsNeedsOptIn("ws://[2001:db8::1]:3000/agent")).toBe(true);
    expect(plainWsNeedsOptIn("garbage")).toBe(false);
  });
});

describe("ServersService team-change hook", () => {
  it("notifies the registered listener with the server id and is inert without one", () => {
    const svc = svcWith({} as Partial<PrismaService>);
    expect(() => svc.emitTeamChanged("s1")).not.toThrow();
    const listener = jest.fn();
    svc.setTeamChangeListener(listener);
    svc.emitTeamChanged("s1");
    expect(listener).toHaveBeenCalledWith("s1");
  });

  it("also publishes the id on teamChanged$ so live streams of that server can end", () => {
    const svc = svcWith({} as Partial<PrismaService>);
    const seen: string[] = [];
    const sub = svc.teamChanged$().subscribe((id) => seen.push(id));
    svc.emitTeamChanged("s1");
    sub.unsubscribe();
    svc.emitTeamChanged("s2");
    expect(seen).toEqual(["s1"]);
  });
});
