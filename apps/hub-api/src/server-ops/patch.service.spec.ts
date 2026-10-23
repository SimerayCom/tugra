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
        return Promise.resolve({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nTUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\n" });
      }),
    } as unknown as AgentWsServer;
    const r = await make(prisma, access, agentWs).checkUpdates("u1", "s1");
    expect(cap).toBe("patch");
    expect(r.count).toBe(1);
    expect(r.packages[0].name).toBe("docker-ce");
  });

  it("checkUpdates SURFACES a host-exec failure (no TUGRA_HOST_ENTERED) as an error — never a false 'unsupported'", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      // the wrapper could not enter the host (e.g. rootless docker) → marker, non-zero, no host-entered
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "TUGRA_HOST_UNAVAILABLE reason=userns\nTUGRA_HOST_EXEC_RC=1\n" }),
    } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).checkUpdates("u1", "s1")).rejects.toThrow(/host patching unavailable: userns/);
  });

  it("checkUpdatesBulk records a host-exec failure in the per-server error field (not a phantom up-to-date)", async () => {
    const prisma = { server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }]) } } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "TUGRA_HOST_UNAVAILABLE reason=no-nsenter\n" }),
    } as unknown as AgentWsServer;
    const { results } = await make(prisma, access, agentWs).checkUpdatesBulk("u1", ["s1"]);
    expect(results[0]).toMatchObject({ serverId: "s1", online: true });
    expect(results[0].updates).toBeUndefined();
    expect(results[0].error).toMatch(/host patching unavailable: no-nsenter/);
  });

  it("upgradeAll streams via DeployLogHub and returns final output", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s, _c, _cap, _t, onChunk?: (c: string) => void) => {
        onChunk?.("Reading package lists...\n");
        return Promise.resolve({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nupgraded 3 packages" });
      }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    const r = await make(prisma, access, agentWs, logs).upgradeAll("u1", "s1");
    expect(r.output).toContain("upgraded");
    // The sent script is the HOST-EXEC wrapper (the real apt command is base64 inside it) — assert we run on
    // the host, not in the agent container.
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("--pid=host"), "patch", expect.any(Number), expect.any(Function));
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("nsenter -t 1"), "patch", expect.any(Number), expect.any(Function));
    expect(logs.begin).toHaveBeenCalledWith("s1");
    expect(logs.push).toHaveBeenCalledWith("s1", "Reading package lists...\n");
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "SUCCESS", exitCode: 0 }));
  });

  it("upgradeAll FAILS (not a false success) when the host was never entered, even on exit 0", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      // exit 0 but NO TUGRA_HOST_ENTERED (e.g. base64 missing → `sh -c ""` exits 0) — must NOT look successful
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    } as unknown as AgentWsServer;
    const logs = makeLogs();
    await expect(make(prisma, access, agentWs, logs).upgradeAll("u1", "s1")).rejects.toThrow(/host patching unavailable/);
    expect(logs.finish).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "FAILED" }));
  });

  it("surfaces a name-mutex conflict as 'a patch is already running' (busy), not a generic error", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 125, output: 'docker: Error response: Conflict. The container name "/tugra-patch" is already in use.\n' }),
    } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).checkUpdates("u1", "s1")).rejects.toThrow(/already running/);
  });

  it("streamLogs subscribes to the server's patch log", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const logs = makeLogs();
    await make(prisma, access, {}, logs).streamLogs("u1", "s1");
    expect(logs.subscribe).toHaveBeenCalledWith("s1");
  });

  it("checkUpdatesBulk checks writable servers, skips non-writable, marks offline ones", async () => {
    const prisma = {
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }, { id: "s2", teamId: "t2" }, { id: "s3", teamId: "t1" }]) },
    } as unknown as PrismaService;
    // Only team t1 grants servers:ops → s2 (team t2) is skipped, not an error.
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockImplementation((id: string) => id === "s1"), // s3 is writable but its agent is offline
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_HOST_ENTERED\nTUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\n" }),
    } as unknown as AgentWsServer;

    const { results, skipped } = await make(prisma, access, agentWs).checkUpdatesBulk("u1", ["s1", "s2", "s3"]);

    expect(skipped).toEqual(["s2"]);
    expect(results.find((r) => r.serverId === "s1")).toMatchObject({ online: true });
    expect(results.find((r) => r.serverId === "s1")!.updates?.count).toBe(1);
    expect(results.find((r) => r.serverId === "s3")).toMatchObject({ online: false });
    expect(agentWs.sendCommand).toHaveBeenCalledTimes(1); // only the one writable + online server
  });

  it("upgradeAllBulk applies to writable online servers and skips cross-team ones", async () => {
    const prisma = {
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", teamId: "t1" }, { id: "s2", teamId: "t2" }]) },
    } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:ops"])]])) } as unknown as TeamAccessService;
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_HOST_ENTERED\ndone" }),
    } as unknown as AgentWsServer;

    const { results, skipped } = await make(prisma, access, agentWs).upgradeAllBulk("u1", ["s1", "s2"]);

    expect(skipped).toEqual(["s2"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ serverId: "s1", online: true, exitCode: 0 });
    expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("--pid=host"), "patch", expect.any(Number));
  });
});
