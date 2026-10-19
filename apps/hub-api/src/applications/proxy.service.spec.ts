import { ProxyService } from "./proxy.service";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";

function make(serverRow: Record<string, unknown>) {
  const sent: string[] = [];
  const agentWs = {
    sendCommand: jest.fn((_id: string, script: string) => {
      sent.push(script);
      return Promise.resolve({ output: "" });
    }),
  } as unknown as AgentWsServer;
  const prisma = {
    cluster: { count: jest.fn().mockResolvedValue(0) }, // not a swarm manager
    server: { findUnique: jest.fn().mockResolvedValue(serverRow) },
  } as unknown as PrismaService;
  const config = { get: jest.fn().mockReturnValue("me@x.com") } as unknown as ConfigService;
  const crypto = { decrypt: jest.fn() } as unknown as CryptoService;
  const svc = new ProxyService(config, agentWs, prisma, crypto);
  return { svc, sent };
}

// The proxy is recreated on EVERY domained deploy via ensureProxy, so it must honor the server's bind mode —
// otherwise a deploy would silently re-publish :80/:443 or fail where another web server holds them.
describe("ProxyService.ensureProxy — proxy bind (CASA-INSTALL-5)", () => {
  it("publishes :80/:443 on all interfaces by default (public) — unchanged behavior", async () => {
    const { svc, sent } = make({ certMode: "http", proxyBind: "public" });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("-p 80:80 -p 443:443");
  });

  it("publishes NO host ports for a tunnel-only (none) server, so deploys never re-open :80/:443", async () => {
    const { svc, sent } = make({ certMode: "http", proxyBind: "none" });
    await svc.ensureProxy("s1");
    expect(sent[0]).not.toMatch(/ -p \d/);
    expect(sent[0]).not.toContain("127.0.0.1:80");
  });

  it("binds :80/:443 to loopback only for a loopback server", async () => {
    const { svc, sent } = make({ certMode: "http", proxyBind: "loopback" });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("-p 127.0.0.1:80:80 -p 127.0.0.1:443:443");
    expect(sent[0]).not.toContain("-p 80:80 -p 443:443");
  });
});
