import { ProxyService } from "./proxy.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { ProxyConfigService, ResolvedProxyConfig } from "../proxy-config/proxy-config.service";

function make(
  cfg: ResolvedProxyConfig,
  result: { exitCode: number; output: string } = { exitCode: 0, output: "" },
  { swarmManaged = 0 }: { swarmManaged?: number } = {},
) {
  const sent: string[] = [];
  const agentWs = {
    sendCommand: jest.fn((_id: string, script: string) => {
      sent.push(script);
      return Promise.resolve(result);
    }),
  } as unknown as AgentWsServer;
  const prisma = {
    cluster: { count: jest.fn().mockResolvedValue(swarmManaged) },
  } as unknown as PrismaService;
  const proxyConfig = { resolveFor: jest.fn().mockResolvedValue(cfg) } as unknown as ProxyConfigService;
  const svc = new ProxyService(agentWs, prisma, proxyConfig);
  return { svc, sent };
}

// The proxy is recreated on EVERY domained deploy via ensureProxy, so it must honor the server's bind mode —
// otherwise a deploy would silently re-publish :80/:443 or fail where another web server holds them.
describe("ProxyService.ensureProxy — proxy bind (resolved via ProxyConfigService)", () => {
  it("publishes :80/:443 on all interfaces by default (public) — unchanged behavior", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "public" });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("-p 80:80 -p 443:443");
  });

  it("publishes NO host ports for a tunnel-only (none) server, so deploys never re-open :80/:443", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "none" });
    await svc.ensureProxy("s1");
    expect(sent[0]).not.toMatch(/ -p \d/);
    expect(sent[0]).not.toContain("127.0.0.1:80");
  });

  it("binds :80/:443 to loopback only for a loopback server", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "loopback" });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("-p 127.0.0.1:80:80 -p 127.0.0.1:443:443");
    expect(sent[0]).not.toContain("-p 80:80 -p 443:443");
  });

  it("throws (with the agent output) on a non-zero exit instead of reporting a successful deploy", async () => {
    const { svc } = make({ acmeEmail: "me@x.com", bind: "public" }, { exitCode: 125, output: "docker: port is already allocated" });
    await expect(svc.ensureProxy("s1")).rejects.toThrow(/port is already allocated/);
  });

  it("refuses on a swarm-manager server (swarm ingress owns :80/:443)", async () => {
    const { svc } = make({ acmeEmail: "me@x.com", bind: "public" }, { exitCode: 0, output: "" }, { swarmManaged: 1 });
    await expect(svc.ensureProxy("s1")).rejects.toThrow(/swarm manager/);
  });

  // --- Panel-TLS (DİLİM 1): resolveFor decides panel; ensureProxy must carry it into the script ----------
  it("local server with a panel config: a domained deploy (re)writes the panel router (never drops it)", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "public", panel: { domain: "app.example.com", resolver: "le" } });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("/etc/tugra/proxy-dynamic/panel.yml");
    expect(sent[0]).toContain("docker network connect tugra-panel tugra-proxy");
    expect(sent[0]).toContain("--providers.file.directory=/dynamic");
  });

  it("non-local server (no panel in the resolved config): no panel router write, no tugra-panel connect", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "public" });
    await svc.ensureProxy("s1");
    expect(sent[0]).not.toContain("proxy-dynamic/panel.yml");
    expect(sent[0]).not.toContain("network connect tugra-panel");
    // file provider is still always mounted (so a later panel write survives) — apps unaffected
    expect(sent[0]).toContain("--providers.file.directory=/dynamic");
  });
});
