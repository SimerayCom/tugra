import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { PatchService } from "./patch.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, agentWs: Partial<AgentWsServer>) {
  return new PatchService(prisma as PrismaService, access as TeamAccessService, audit, agentWs as AgentWsServer);
}

const server = { id: "s1", teamId: "t1" };

describe("PatchService", () => {
  it("forbids a viewer from checking updates", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue(Role.VIEWER) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {}).checkUpdates("u1", "s1")).rejects.toThrow(/insufficient role/);
  });

  it("checkUpdates sends a 'patch' command and parses the output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    let cap = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, _c: string, capability: string) => {
        cap = capability;
        return Promise.resolve({ exitCode: 0, output: "TUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\n" });
      }),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).checkUpdates("u1", "s1");
    expect(cap).toBe("patch");
    expect(r.count).toBe(1);
    expect(r.packages[0].name).toBe("docker-ce");
  });

  it("upgradeAll sends a 'patch' command and returns output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "upgraded 3 packages" }) } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).upgradeAll("u1", "s1");
    expect(r.output).toContain("upgraded");
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("apt-get upgrade -y"), "patch", expect.any(Number));
  });
});
