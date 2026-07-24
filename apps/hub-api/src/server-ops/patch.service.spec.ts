import { ForbiddenException } from "@nestjs/common";
import { PatchService } from "./patch.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";

const audit = { log: jest.fn() } as unknown as AuditService;

function makeLogs(): DeployLogHub {
  return { begin: jest.fn(), push: jest.fn(), finish: jest.fn(), subscribe: jest.fn().mockReturnValue(null) } as unknown as DeployLogHub;
}

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer>,
  logs: DeployLogHub = makeLogs(),
) {
  return new PatchService(prisma as PrismaService, access as TeamAccessService, audit, agentWs as AgentWsServer, logs);
}

const server = { id: "s1", teamId: "t1" };

describe("PatchService", () => {
  it("forbids a viewer from checking updates", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role")) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {}).checkUpdates("u1", "s1")).rejects.toThrow(/insufficient role/);
  });

  it("checkUpdates sends a 'patch' command and parses the output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let cap = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, _c: string, capability: string) => {
        cap = capability;
        return Promise.resolve({ exitCode: 0, output: "TUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\n" });
      }),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).checkUpdates("u1", "s1");
    expect(cap).toBe("patch");
    expect(r.count).toBe(1);
    expect(r.packages[0].name).toBe("docker-ce");
  });

  it("upgradeAll streams via DeployLogHub and returns final output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s, _c, _cap, _t, onChunk?: (c: string) => void) => {
        onChunk?.("Reading package lists...\n");
        return Promise.resolve({ exitCode: 0, output: "upgraded 3 packages" });
      }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const r = await make(prisma, access, agentWs, logs).upgradeAll("u1", "s1");
    expect(r.output).toContain("upgraded");
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("apt-get upgrade -y"), "patch", expect.any(Number), expect.any(Function));
    expect(logs.begin).toHaveBeenCalledWith("s1");
    expect(logs.push).toHaveBeenCalledWith("s1", "Reading package lists...\n");
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "SUCCESS", exitCode: 0 }));
  });

  it("streamLogs subscribes to the server's patch log", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const logs = makeLogs();
    await make(prisma, access, {}, logs).streamLogs("u1", "s1");
    expect(logs.subscribe).toHaveBeenCalledWith("s1");
  });
});
