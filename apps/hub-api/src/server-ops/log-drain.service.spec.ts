import { ForbiddenException } from "@nestjs/common";
import { LogDrainService } from "./log-drain.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, agentWs: Partial<AgentWsServer>) {
  return new LogDrainService(prisma as PrismaService, access as TeamAccessService, crypto, agentWs as AgentWsServer, audit);
}

const server = { id: "s1", teamId: "t1" };

describe("LogDrainService", () => {
  it("forbids a viewer from creating a drain", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient permission")) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {}).create("u1", "s1", { name: "x", endpoint: "https://x" })).rejects.toThrow(/insufficient permission/);
  });

  it("encrypts the token on create and pushes config to the agent", async () => {
    const create = jest.fn().mockResolvedValue({ id: "d1", serverId: "s1", name: "axiom", type: "HTTP", endpoint: "https://x", authTokenEnc: "enc:tok", enabled: true, createdAt: new Date() });
    const sendToAgent = jest.fn();
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server) },
      logDrain: { create, findMany: jest.fn().mockResolvedValue([{ id: "d1", endpoint: "https://x", authTokenEnc: "enc:tok", enabled: true }]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const view = await make(prisma, access, { sendToAgent }).create("u1", "s1", { name: "axiom", endpoint: "https://x", token: "tok" });
    expect(create.mock.calls[0][0].data.authTokenEnc).toBe("enc:tok");
    expect(view.hasToken).toBe(true);
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [{ id: "d1", endpoint: "https://x", token: "tok" }] });
  });

  it("pushToAgent sends only enabled drains with decrypted tokens", async () => {
    const sendToAgent = jest.fn();
    const prisma = {
      logDrain: { findMany: jest.fn().mockResolvedValue([{ id: "d1", endpoint: "https://a", authTokenEnc: "enc:k1", enabled: true }]) },
    } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, { sendToAgent }).pushToAgent("s1");
    expect(prisma.logDrain.findMany).toHaveBeenCalledWith({ where: { serverId: "s1", enabled: true } });
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [{ id: "d1", endpoint: "https://a", token: "k1" }] });
  });

  it("removes a drain and re-pushes config", async () => {
    const del = jest.fn().mockResolvedValue({});
    const sendToAgent = jest.fn();
    const prisma = {
      logDrain: {
        findUnique: jest.fn().mockResolvedValue({ id: "d1", serverId: "s1" }),
        delete: del,
        findMany: jest.fn().mockResolvedValue([]),
      },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, { sendToAgent }).remove("u1", "d1");
    expect(del).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(sendToAgent).toHaveBeenCalledWith("s1", { type: "log_drains", drains: [] });
  });
});
