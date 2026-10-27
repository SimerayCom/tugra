import { BadRequestException, ConflictException } from "@nestjs/common";
import { PanelTlsService } from "./panel-tls.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { AuditService } from "../audit/audit.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import type { ProxyConfigService, ResolvedProxyConfig } from "../proxy-config/proxy-config.service";
import type { ProxyService } from "./proxy.service";

type Opts = {
  env?: Record<string, string | undefined>;
  local?: { id: string; status: string } | null;
  panelDomain?: string | null;
  acmeEmail?: string;
  cfg?: ResolvedProxyConfig;
  probe?: { output: string; exitCode: number };
};

function make(o: Opts = {}) {
  const prisma = { server: { findFirst: jest.fn().mockResolvedValue(o.local ?? null) } } as unknown as PrismaService;
  const config = { get: (k: string) => (o.env ?? {})[k] } as unknown as ConfigService;
  const agentWs = {
    sendCommand: jest.fn().mockResolvedValue(o.probe ?? { output: "true\nRF:1", exitCode: 0 }),
  } as unknown as AgentWsServer;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const settings = {
    panelDomainFor: jest.fn().mockResolvedValue(o.panelDomain ?? null),
    acmeEmailFor: jest.fn().mockResolvedValue("acmeEmail" in o ? o.acmeEmail : "ops@tugra.io"),
  } as unknown as InstanceSettingsService;
  const proxyConfig = { resolveFor: jest.fn().mockResolvedValue(o.cfg ?? {}) } as unknown as ProxyConfigService;
  const proxy = { ensureProxy: jest.fn().mockResolvedValue(undefined) } as unknown as ProxyService;
  const svc = new PanelTlsService(prisma, config, agentWs, audit, settings, proxyConfig, proxy);
  return { svc, proxy, audit, agentWs };
}

const ENV = { WEB_PUBLIC_URL: "https://demo.tugra.io" };
const LOCAL_ONLINE = { id: "s-local", status: "ONLINE" };

describe("PanelTlsService.status", () => {
  it("reports enabled + domain + originMatches when the panel domain equals the WEB_PUBLIC_URL host", async () => {
    const { svc } = make({
      env: ENV,
      panelDomain: "demo.tugra.io",
      local: LOCAL_ONLINE,
      cfg: { panel: { domain: "demo.tugra.io", resolver: "le" } },
    });
    const s = await svc.status();
    expect(s.enabled).toBe(true);
    expect(s.domain).toBe("demo.tugra.io");
    expect(s.originHost).toBe("demo.tugra.io");
    expect(s.originMatches).toBe(true);
    expect(s.resolver).toBe("le");
  });

  it("acmeEmailOk is false for a placeholder email", async () => {
    const { svc } = make({ env: ENV, panelDomain: "demo.tugra.io", acmeEmail: "admin@example.com", local: LOCAL_ONLINE });
    expect((await svc.status()).acmeEmailOk).toBe(false);
  });

  it("probes proxyRunning + routerPresent on an ONLINE local server", async () => {
    const { svc, agentWs } = make({
      env: ENV,
      panelDomain: "demo.tugra.io",
      local: LOCAL_ONLINE,
      probe: { output: "true\nRF:1\n", exitCode: 0 },
    });
    const s = await svc.status();
    expect(agentWs.sendCommand).toHaveBeenCalled();
    expect(s.proxyRunning).toBe(true);
    expect(s.routerPresent).toBe(true);
    expect(s.localServerOnline).toBe(true);
  });

  it("does NOT probe when the local server is offline (and never throws)", async () => {
    const { svc, agentWs } = make({ env: ENV, panelDomain: "demo.tugra.io", local: { id: "s", status: "OFFLINE" } });
    const s = await svc.status();
    expect(agentWs.sendCommand).not.toHaveBeenCalled();
    expect(s.proxyRunning).toBe(false);
    expect(s.routerPresent).toBe(false);
    expect(s.localServerOnline).toBe(false);
  });

  it("exposes only the documented fields (no secrets)", async () => {
    const { svc } = make({ env: ENV, panelDomain: "demo.tugra.io", local: LOCAL_ONLINE });
    expect(Object.keys(await svc.status()).sort()).toEqual(
      [
        "acmeEmailOk",
        "domain",
        "enabled",
        "localServerId",
        "localServerOnline",
        "originHost",
        "originMatches",
        "proxyRunning",
        "resolver",
        "routerPresent",
      ].sort(),
    );
  });
});

describe("PanelTlsService.apply", () => {
  it("recreates the proxy (ensureProxy) + audits when ONLINE with a resolved panel", async () => {
    const { svc, proxy, audit } = make({
      env: ENV,
      panelDomain: "demo.tugra.io",
      local: LOCAL_ONLINE,
      cfg: { panel: { domain: "demo.tugra.io", resolver: "le" } },
    });
    await svc.apply("owner-1");
    expect(proxy.ensureProxy).toHaveBeenCalledWith("s-local");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.panel_tls.apply", actor: "owner-1" }));
  });

  it("400 when there is no local server", async () => {
    const { svc } = make({ env: ENV, local: null });
    await expect(svc.apply("o")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("409 when the local server is offline", async () => {
    const { svc, proxy } = make({ env: ENV, local: { id: "s", status: "OFFLINE" }, cfg: { panel: { domain: "d", resolver: "le" } } });
    await expect(svc.apply("o")).rejects.toBeInstanceOf(ConflictException);
    expect(proxy.ensureProxy).not.toHaveBeenCalled();
  });

  it("400 when panel TLS is not configured (resolver returns no panel)", async () => {
    const { svc, proxy } = make({ env: ENV, panelDomain: null, local: LOCAL_ONLINE, cfg: {} });
    await expect(svc.apply("o")).rejects.toBeInstanceOf(BadRequestException);
    expect(proxy.ensureProxy).not.toHaveBeenCalled();
  });
});
