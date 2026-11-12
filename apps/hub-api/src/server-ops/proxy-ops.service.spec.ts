import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ProxyOpsService } from "./proxy-ops.service";
import { ProxyService } from "../applications/proxy.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { SwarmProxyService } from "../clusters/swarm-proxy.service";
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
  return new ProxyOpsService(prisma, access, audit, agentWs, proxyConfig, {} as unknown as SwarmProxyService);
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
  // and pass the result identically into buildProxySetupScript — so for the same resolved config they build the
  // SAME proxy definition. The ONLY intended difference now is `force`: `start` (operator action) passes
  // force:true (always rm+run, no gate); a domained deploy passes force:false (the reconcile gate is prepended).
  // So the two scripts must be identical MODULO the gate — proving no drift in the proxy definition itself.
  it("start and ProxyService.ensureProxy build the SAME proxy definition (differ only by the reconcile gate)", async () => {
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
    const ops = new ProxyOpsService(opsPrisma, opsAccess, audit, { sendCommand: opsSend } as unknown as AgentWsServer, proxyConfig, {} as unknown as SwarmProxyService);
    await ops.start("u1", "s1");

    const appSend = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const appPrisma = { cluster: { count: jest.fn().mockResolvedValue(0) } } as unknown as PrismaService;
    const app = new ProxyService({ sendCommand: appSend } as unknown as AgentWsServer, appPrisma, proxyConfig);
    await app.ensureProxy("s1");

    const opsScript = opsSend.mock.calls[0][1] as string; // force:true → no gate
    const appScript = appSend.mock.calls[0][1] as string; // force:false → reconcile gate prepended
    // `start` is the operator path: it must NOT carry the skip gate (so Start rebuilds even when the hash matches).
    expect(opsScript).not.toContain("exit 0; fi");
    expect(appScript).toContain("exit 0; fi");
    // Strip ONLY the gate lines from the deploy script → it must be byte-identical to the operator script.
    const stripGate = (s: string) =>
      s
        .split("\n")
        .filter((l) => !/^(DESIRED=|CUR=|STATE=|if \[ "\$CUR")/.test(l))
        .join("\n");
    expect(stripGate(appScript)).toBe(opsScript);
    // ...and both stamp the SAME confighash label (same resolved config ⇒ same hash).
    const label = (s: string) => s.match(/--label tugra\.proxy\.confighash='[a-f0-9]{12}'/)?.[0];
    expect(label(opsScript)).toBeTruthy();
    expect(label(appScript)).toBe(label(opsScript));
  });

  it("recreateClassic (start) forces a rebuild — no reconcile gate, so Start recreates even when the hash matches", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" });
    await make(Role.OWNER, send).start("u1", "s1");
    const script = send.mock.calls[0][1] as string;
    expect(script).not.toContain("exit 0; fi"); // force path: no skip
    expect(script).not.toContain("DESIRED=");
    expect(script).toContain("docker rm -f tugra-proxy");
    expect(script).toContain("docker run -d --name tugra-proxy");
  });
});

describe("ProxyOpsService dynamic configs", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeDyn(role: Role | null, send: jest.Mock, pdc: Record<string, jest.Mock> = {}) {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server) },
      proxyDynamicConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        ...pdc,
      },
    } as unknown as PrismaService;
    const perms = new Set(role === Role.OWNER || role === Role.ADMIN ? ALL_PERMS : []);
    const access = {
      teamRole: jest.fn().mockResolvedValue(role),
      requirePermission: jest.fn((_u: string, _t: string, perm: string) =>
        perms.has(perm) ? Promise.resolve(undefined) : Promise.reject(new ForbiddenException("insufficient role for this team")),
      ),
    } as unknown as TeamAccessService;
    const svc = new ProxyOpsService(prisma, access, audit, { sendCommand: send } as unknown as AgentWsServer, {} as unknown as ProxyConfigService, {} as unknown as SwarmProxyService);
    return { svc, prisma };
  }

  it("writes a valid YAML config to /dynamic as user-<name>.yml, then records + audits it", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const { svc, prisma } = makeDyn(Role.OWNER, send);
    await svc.putDynamicConfig("u1", "s1", "my-mw", "http:\n  middlewares:\n    foo:\n      headers:\n        stsSeconds: 1\n");
    expect(send.mock.calls[0][1]).toContain("/etc/tugra/proxy-dynamic/user-my-mw.yml");
    expect(send.mock.calls[0][2]).toBe("deploy");
    expect((prisma.proxyDynamicConfig as unknown as { upsert: jest.Mock }).upsert).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.proxy.dynamic.put" }));
  });

  it("rejects invalid YAML and a non-mapping doc BEFORE touching the proxy", async () => {
    const send = jest.fn();
    const { svc } = makeDyn(Role.OWNER, send);
    await expect(svc.putDynamicConfig("u1", "s1", "bad", "http:\n  foo: [unterminated")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.putDynamicConfig("u1", "s1", "scalar", "just a string")).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a bad name (uppercase / dots / path) without writing", async () => {
    const send = jest.fn();
    const { svc } = makeDyn(Role.OWNER, send);
    await expect(svc.putDynamicConfig("u1", "s1", "Bad.Name", "http: {}")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.putDynamicConfig("u1", "s1", "../escape", "http: {}")).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it("does NOT persist when the proxy write fails (fail-closed)", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 1, output: "permission denied" });
    const { svc, prisma } = makeDyn(Role.OWNER, send);
    await expect(svc.putDynamicConfig("u1", "s1", "mw", "http: {}")).rejects.toBeInstanceOf(BadRequestException);
    expect((prisma.proxyDynamicConfig as unknown as { upsert: jest.Mock }).upsert).not.toHaveBeenCalled();
  });

  it("delete removes the DB row and sends an rm for user-<name>.yml", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const { svc } = makeDyn(Role.OWNER, send);
    await svc.deleteDynamicConfig("u1", "s1", "mw");
    expect(send.mock.calls[0][1]).toBe("rm -f /etc/tugra/proxy-dynamic/user-mw.yml");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.proxy.dynamic.delete" }));
  });

  it("forbids a viewer from writing a dynamic config", async () => {
    await expect(makeDyn(Role.VIEWER, jest.fn()).svc.putDynamicConfig("u1", "s1", "mw", "http: {}")).rejects.toThrow(/insufficient role/);
  });
});

describe("ProxyOpsService.setTrafficAnalytics", () => {
  beforeEach(() => jest.clearAllMocks());

  const classicServer = { id: "s1", teamId: "t1", clusterId: null, swarmNodeId: null, cluster: null };
  const swarmServer = { id: "s1", teamId: "t1", clusterId: "c1", swarmNodeId: "n1", cluster: { swarmStatus: "ACTIVE" } };

  function makeToggle(
    role: Role | null,
    srv: unknown,
    send: jest.Mock,
    swarm: Partial<Record<"status" | "ensure" | "accessLogState", jest.Mock>> = {},
    cfg: ResolvedProxyConfig = { acmeEmail: "me@x.com", bind: "public", accessLog: true },
  ) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(srv), update } } as unknown as PrismaService;
    const perms = new Set(role === Role.OWNER || role === Role.ADMIN ? ALL_PERMS : []);
    const access = {
      teamRole: jest.fn().mockResolvedValue(role),
      requirePermission: jest.fn((_u: string, _t: string, perm: string) =>
        perms.has(perm) ? Promise.resolve(undefined) : Promise.reject(new ForbiddenException("insufficient role for this team")),
      ),
    } as unknown as TeamAccessService;
    const proxyConfig = { resolveFor: jest.fn().mockResolvedValue(cfg) } as unknown as ProxyConfigService;
    const swarmSvc = {
      status: jest.fn(),
      ensure: jest.fn(),
      accessLogState: jest.fn().mockResolvedValue({ inPool: true, effective: true }),
      ...swarm,
    } as unknown as SwarmProxyService;
    const svc = new ProxyOpsService(prisma, access, audit, { sendCommand: send } as unknown as AgentWsServer, proxyConfig, swarmSvc);
    return { svc, update, access, swarmSvc };
  }

  it("rejects a viewer (no servers:manage) without writing the flag or touching the proxy", async () => {
    const send = jest.fn();
    const { svc, update } = makeToggle(Role.VIEWER, classicServer, send);
    await expect(svc.setTrafficAnalytics("u1", "s1", true)).rejects.toThrow(/insufficient role/);
    expect(update).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("is gated by servers:manage (the server-settings gate)", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "running\n" });
    const { svc, access } = makeToggle(Role.OWNER, classicServer, send);
    await svc.setTrafficAnalytics("u1", "s1", true);
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:manage");
  });

  it("404s an unknown server", async () => {
    const { svc } = makeToggle(Role.OWNER, null, jest.fn());
    await expect(svc.setTrafficAnalytics("u1", "nope", true)).rejects.toThrow(/not found/);
  });

  it("classic: persists the flag, then recreates the proxy WITH the access log, and audits", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" }) // status probe (proxy exists)
      .mockResolvedValueOnce({ exitCode: 0, output: "" }); // recreate
    const { svc, update } = makeToggle(Role.OWNER, classicServer, send);
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { trafficAnalytics: true } });
    expect(send.mock.calls[1][1]).toContain("--accesslog=true");
    expect(send.mock.calls[1][1]).toContain("-v /etc/tugra/proxy-logs:/var/log/traefik");
    expect(r).toEqual({ trafficAnalytics: true, apply: "applied", applyError: null });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "server.traffic_analytics.update", meta: { enabled: true, apply: "applied" } }),
    );
  });

  it("classic OFF: the recreate carries no access-log flags", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" })
      .mockResolvedValueOnce({ exitCode: 0, output: "" })
      .mockResolvedValueOnce({ exitCode: 0, output: "" }); // cleanup
    const { svc } = makeToggle(Role.OWNER, classicServer, send, {}, { acmeEmail: "me@x.com", bind: "public", accessLog: false });
    const r = await svc.setTrafficAnalytics("u1", "s1", false);
    expect(send.mock.calls[1][1]).not.toContain("accesslog");
    expect(send.mock.calls[1][1]).not.toContain("proxy-logs");
    // the old log (client IPs) + rotation config are removed after a successful OFF recreate
    expect(send.mock.calls[2][1]).toContain("rm -f /etc/tugra/proxy-logs/access.json");
    expect(r.apply).toBe("applied");
    expect(r.trafficAnalytics).toBe(false);
  });

  it("classic with no proxy yet: flag saved, re-apply deferred (no recreate)", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" }); // status => absent
    const { svc, update } = makeToggle(Role.OWNER, classicServer, send);
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(update).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.apply).toBe("deferred");
  });

  it("classic with a STOPPED proxy: flag saved, deferred, the container is left alone (never resurrected)", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "exited\n" });
    const { svc, update } = makeToggle(Role.OWNER, classicServer, send);
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(update).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1); // status probe only — no docker rm / run
    expect(r.apply).toBe("deferred");
  });

  it("classic re-apply failure: flag stays saved, failure is surfaced (not silent) and audited", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "running\n" })
      .mockResolvedValueOnce({ exitCode: 1, output: "port taken" });
    const { svc, update } = makeToggle(Role.OWNER, classicServer, send);
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { trafficAnalytics: true } });
    expect(r.trafficAnalytics).toBe(true);
    expect(r.apply).toBe("failed");
    expect(r.applyError).toContain("port taken");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: { enabled: true, apply: "failed" } }));
  });

  it("offline agent (command rejects) is reported as failed, flag still saved", async () => {
    const send = jest.fn().mockRejectedValue(new Error("agent offline"));
    const { svc } = makeToggle(Role.OWNER, classicServer, send);
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(r).toEqual({ trafficAnalytics: true, apply: "failed", applyError: "agent offline" });
  });

  it("swarm member: re-ensures the CLUSTER ingress (not the classic proxy)", async () => {
    const send = jest.fn();
    const status = jest.fn().mockResolvedValue({ exitCode: 0, output: "1/1\n" });
    const ensure = jest.fn().mockResolvedValue(undefined);
    const { svc, swarmSvc } = makeToggle(Role.OWNER, swarmServer, send, { status, ensure });
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(swarmSvc.ensure).toHaveBeenCalledWith("c1");
    expect(send).not.toHaveBeenCalled();
    expect(r.apply).toBe("applied");
  });

  it("swarm: a server OUTSIDE the ingress pool is flagged not-in-pool and ensure() is NOT run", async () => {
    const status = jest.fn().mockResolvedValue({ exitCode: 0, output: "1/1\n" });
    const ensure = jest.fn();
    const accessLogState = jest.fn().mockResolvedValue({ inPool: false, effective: false });
    const { svc } = makeToggle(Role.OWNER, swarmServer, jest.fn(), { status, ensure, accessLogState });
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(ensure).not.toHaveBeenCalled();
    expect(r).toEqual({ trafficAnalytics: true, apply: "not-in-pool", applyError: null });
  });

  it("swarm: turning OFF a pool member while another pool node is ON reports cluster-shared (logging continues)", async () => {
    const status = jest.fn().mockResolvedValue({ exitCode: 0, output: "2/2\n" });
    const ensure = jest.fn().mockResolvedValue(undefined);
    const accessLogState = jest.fn().mockResolvedValue({ inPool: true, effective: true });
    const { svc } = makeToggle(Role.OWNER, swarmServer, jest.fn(), { status, ensure, accessLogState });
    const r = await svc.setTrafficAnalytics("u1", "s1", false);
    expect(ensure).toHaveBeenCalledWith("c1");
    expect(r.trafficAnalytics).toBe(false);
    expect(r.apply).toBe("cluster-shared");
  });

  it("swarm member with no ingress yet: deferred, ensure() NOT called (a toggle never creates ingress)", async () => {
    const status = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const ensure = jest.fn();
    const { svc } = makeToggle(Role.OWNER, swarmServer, jest.fn(), { status, ensure });
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(ensure).not.toHaveBeenCalled();
    expect(r.apply).toBe("deferred");
  });

  it("swarm ensure failure is surfaced as failed", async () => {
    const status = jest.fn().mockResolvedValue({ exitCode: 0, output: "1/1\n" });
    const ensure = jest.fn().mockRejectedValue(new Error("swarm manager is offline"));
    const { svc } = makeToggle(Role.OWNER, swarmServer, jest.fn(), { status, ensure });
    const r = await svc.setTrafficAnalytics("u1", "s1", true);
    expect(r).toEqual({ trafficAnalytics: true, apply: "failed", applyError: "swarm manager is offline" });
  });
});
