import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ProxyOpsService } from "./proxy-ops.service";
import { ProxyService } from "../applications/proxy.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { ProxyConfigService, ResolvedProxyConfig } from "../proxy-config/proxy-config.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const server = { id: "s1", teamId: "t1" };

const ALL_PERMS = [
  "apps:deploy",
  "apps:config",
  "databases",
  "backups",
  "servers:manage",
  "servers:ops",
  "terminal",
  "bulk",
  "monitors",
  "projects",
  "integrations",
  "variables",
];

function make(role: Role | null, send: jest.Mock, cfg: ResolvedProxyConfig = { acmeEmail: "me@x.com", bind: "public" }) {
  const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
  // OWNER/ADMIN hold every granular permission; VIEWER holds none.
  const perms = new Set(role === Role.OWNER || role === Role.ADMIN ? ALL_PERMS : []);
  const access = {
    teamRole: jest.fn().mockResolvedValue(role),
    requirePermission: jest.fn((_u: string, _t: string, perm: string) =>
      perms.has(perm)
        ? Promise.resolve(undefined)
        : Promise.reject(new ForbiddenException("insufficient role for this team")),
    ),
  } as unknown as TeamAccessService;
  const agentWs = { sendCommand: send } as unknown as AgentWsServer;
  const proxyConfig = { resolveFor: jest.fn().mockResolvedValue(cfg) } as unknown as ProxyConfigService;
  return new ProxyOpsService(prisma, access, audit, agentWs, proxyConfig);
}

describe("ProxyOpsService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("forbids a viewer from starting the proxy", async () => {
    await expect(make(Role.VIEWER, jest.fn()).start("u1", "s1")).rejects.toThrow(/insufficient role/);
  });

  it("start runs the Traefik setup script via the deploy capability and audits", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "" }) // setup
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" }); // status-after
    const r = await make(Role.OWNER, send).start("u1", "s1");
    expect(send).toHaveBeenCalledWith("s1", expect.stringContaining("traefik:v3.7"), "deploy", expect.any(Number));
    expect(r.status).toBe("running");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.proxy.start" }));
  });

  it("start throws on a non-zero setup exit, without auditing success or probing status", async () => {
    const send = jest.fn().mockResolvedValueOnce({ exitCode: 125, output: "docker: port is already allocated" });
    await expect(make(Role.OWNER, send).start("u1", "s1")).rejects.toThrow(/port is already allocated/);
    expect(send).toHaveBeenCalledTimes(1); // no status-after call
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "server.proxy.start" }));
  });

  it("start carries the panel router when the resolver returns one (local server)", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" });
    await make(Role.OWNER, send, { acmeEmail: "me@x.com", bind: "public", panel: { domain: "app.example.com", resolver: "le" } }).start("u1", "s1");
    expect(send.mock.calls[0][1]).toContain("/etc/tugra/proxy-dynamic/panel.yml");
  });

  it("status parses the container state", async () => {
    expect((await make(Role.VIEWER, jest.fn().mockResolvedValue({ exitCode: 0, output: "running\n" })).status("u1", "s1")).status).toBe("running");
    expect((await make(Role.VIEWER, jest.fn().mockResolvedValue({ exitCode: 0, output: "exited\n" })).status("u1", "s1")).status).toBe("stopped");
    expect((await make(Role.VIEWER, jest.fn().mockResolvedValue({ exitCode: 0, output: "absent\n" })).status("u1", "s1")).status).toBe("absent");
  });

  it("restart sends docker restart and audits", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" });
    await make(Role.ADMIN, send).restart("u1", "s1");
    expect(send).toHaveBeenCalledWith("s1", "docker restart tugra-proxy", "deploy", expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.proxy.restart" }));
  });

  it("logs returns the tailed proxy output", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "level=info" });
    const r = await make(Role.OWNER, send).logs("u1", "s1", 50);
    expect(send).toHaveBeenCalledWith("s1", expect.stringContaining("docker logs --tail 50 tugra-proxy"), "deploy", expect.any(Number));
    expect(r.output).toContain("level=info");
  });

  // Drift guard: ProxyOpsService.start and ProxyService.ensureProxy BOTH resolve through ProxyConfigService
  // and pass the result identically into buildProxySetupScript — so for the same resolved config the emitted
  // script is byte-identical. This is what guarantees `start` and a domained deploy can never diverge.
  it("start and ProxyService.ensureProxy build the SAME script from the shared resolver (no drift)", async () => {
    const cfg: ResolvedProxyConfig = { acmeEmail: "me@x.com", bind: "public", panel: { domain: "app.example.com", resolver: "le" } };
    const proxyConfig = { resolveFor: jest.fn().mockResolvedValue(cfg) } as unknown as ProxyConfigService;

    const opsSend = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" });
    const opsPrisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const opsAccess = {
      teamRole: jest.fn().mockResolvedValue(Role.OWNER),
      requirePermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    const ops = new ProxyOpsService(opsPrisma, opsAccess, audit, { sendCommand: opsSend } as unknown as AgentWsServer, proxyConfig);
    await ops.start("u1", "s1");

    const appSend = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const appPrisma = { cluster: { count: jest.fn().mockResolvedValue(0) } } as unknown as PrismaService;
    const app = new ProxyService({ sendCommand: appSend } as unknown as AgentWsServer, appPrisma, proxyConfig);
    await app.ensureProxy("s1");

    expect(opsSend.mock.calls[0][1]).toBe(appSend.mock.calls[0][1]);
  });
});
