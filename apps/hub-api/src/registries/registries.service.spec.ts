import { Role } from "@prisma/client";
import { RegistriesService } from "./registries.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, agentWs: Partial<AgentWsServer> = {}) {
  return new RegistriesService(prisma as PrismaService, access as TeamAccessService, audit, crypto, agentWs as AgentWsServer);
}

describe("RegistriesService", () => {
  it("encrypts the password on create and never returns it", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "r1", name: "ghcr", teamId: "t1", type: "ghcr", url: "ghcr.io",
      username: "bot", imagePrefix: "org", createdAt: new Date(),
    });
    const svc = make({ registry: { create } } as unknown as PrismaService, { requireRole: jest.fn().mockResolvedValue(undefined) });
    const v = await svc.create("u1", { name: "ghcr", teamId: "t1", type: "ghcr", url: "ghcr.io", username: "bot", password: "s3cr3t", imagePrefix: "org" });
    const data = create.mock.calls[0][0].data;
    expect(data.passwordEnc).toBe("enc(s3cr3t)");
    expect(data).not.toHaveProperty("password");
    expect(v).not.toHaveProperty("passwordEnc");
    expect(v).not.toHaveProperty("password");
    expect(v).toMatchObject({ id: "r1", username: "bot", canWrite: true });
  });

  it("create requires a WRITE role", async () => {
    const requireRole = jest.fn().mockRejectedValue(new Error("insufficient role for this team"));
    const svc = make({ registry: { create: jest.fn() } } as unknown as PrismaService, { requireRole });
    await expect(svc.create("u1", { name: "x", teamId: "t1", type: "generic", username: "u", password: "p" })).rejects.toThrow(/insufficient role/);
    expect(requireRole).toHaveBeenCalledWith("u1", "t1", [Role.OWNER, Role.ADMIN]);
  });

  it("update only re-encrypts the password when one is supplied", async () => {
    const update = jest.fn().mockResolvedValue({ id: "r1", name: "n", teamId: "t1", type: "generic", url: null, username: "u", imagePrefix: null, createdAt: new Date() });
    const prisma = {
      registry: { findUnique: jest.fn().mockResolvedValue({ id: "r1", teamId: "t1" }), update },
    } as unknown as PrismaService;
    const svc = make(prisma, { requireRole: jest.fn().mockResolvedValue(undefined) });
    // no password → passwordEnc untouched
    await svc.update("u1", "r1", { name: "renamed" });
    expect("passwordEnc" in update.mock.calls[0][0].data).toBe(false);
    // password given → re-encrypted
    await svc.update("u1", "r1", { password: "new" });
    expect(update.mock.calls[1][0].data.passwordEnc).toBe("enc(new)");
  });

  it("list() sets canWrite per the caller's role in each registry's team", async () => {
    const row = (id: string, teamId: string) => ({ id, name: id, teamId, type: "generic", url: null, username: "u", imagePrefix: null, createdAt: new Date() });
    const prisma = {
      registry: { findMany: jest.fn().mockResolvedValue([row("r1", "tOwner"), row("r2", "tViewer")]) },
    } as unknown as PrismaService;
    const access = {
      roleByTeam: jest.fn().mockResolvedValue(new Map([["tOwner", Role.OWNER], ["tViewer", Role.VIEWER]])),
    } as unknown as TeamAccessService;
    const list = await make(prisma, access).list("u1");
    expect(list.find((r) => r.id === "r1")!.canWrite).toBe(true);
    expect(list.find((r) => r.id === "r2")!.canWrite).toBe(false);
    expect(list[0]).not.toHaveProperty("passwordEnc");
  });

  it("testLogin fails with 400 when no team server is online", async () => {
    const prisma = {
      registry: { findUnique: jest.fn().mockResolvedValue({ id: "r1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "enc(tok)" }) },
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]) },
    } as unknown as PrismaService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(false) } as unknown as AgentWsServer;
    const svc = make(prisma, { teamRole: jest.fn().mockResolvedValue(Role.ADMIN) }, agentWs);
    await expect(svc.testLogin("u1", "r1")).rejects.toThrow(/no online server/);
  });

  it("testLogin runs a docker login on an online server and reports success on exit 0", async () => {
    const prisma = {
      registry: { findUnique: jest.fn().mockResolvedValue({ id: "r1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "enc(tok)" }) },
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1" }]) },
    } as unknown as PrismaService;
    let sent = "";
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => {
        sent = cmd;
        return Promise.resolve({ exitCode: 0, output: "TUGRA_REGISTRY_OK" });
      }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, { teamRole: jest.fn().mockResolvedValue(Role.ADMIN) }, agentWs);
    expect(await svc.testLogin("u1", "r1")).toEqual({ ok: true });
    // real docker login via stdin (token never inlined in argv)
    expect(sent).toContain("docker --config \"$sd\" login 'ghcr.io' -u 'bot' --password-stdin");
    expect(sent).not.toContain("tok");
  });

  it("testLogin surfaces a failed login as 400", async () => {
    const prisma = {
      registry: { findUnique: jest.fn().mockResolvedValue({ id: "r1", teamId: "t1", url: null, username: "bot", passwordEnc: "enc(bad)" }) },
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1" }]) },
    } as unknown as PrismaService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "denied" }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, { teamRole: jest.fn().mockResolvedValue(Role.ADMIN) }, agentWs);
    await expect(svc.testLogin("u1", "r1")).rejects.toThrow(/registry login failed/);
  });
});
