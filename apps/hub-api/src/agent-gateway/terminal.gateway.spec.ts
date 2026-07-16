import { ForbiddenException } from "@nestjs/common";
import { TerminalGateway } from "./terminal.gateway";

function fakeWs() {
  return { readyState: 1, send: jest.fn(), close: jest.fn(), on: jest.fn() } as any;
}

function make(over: {
  validate?: jest.Mock;
  verifyAsync?: jest.Mock;
  requirePermission?: jest.Mock;
  application?: any;
  server?: any;
  isOnline?: boolean;
  terminalGranted?: boolean;
  apiEnabled?: boolean;
  apiAllowedIps?: string[];
} = {}) {
  const agentWs = {
    sendToAgent: jest.fn().mockReturnValue(true),
    isOnline: jest.fn().mockReturnValue(over.isOnline ?? true),
    isCapabilityGranted: jest.fn().mockResolvedValue(over.terminalGranted ?? true),
    setTerminalDelegate: jest.fn(),
  } as any;
  const jwt = { verifyAsync: over.verifyAsync ?? jest.fn() } as any;
  const config = { get: jest.fn().mockReturnValue("secret") } as any;
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(over.application ?? null) },
    server: { findUnique: jest.fn().mockResolvedValue(over.server ?? null) },
  } as any;
  const access = {
    requirePermission: over.requirePermission ?? jest.fn().mockResolvedValue(undefined),
  } as any;
  const apiTokens = { validate: over.validate ?? jest.fn() } as any;
  const audit = { log: jest.fn() } as any;
  const instance = {
    get: jest.fn().mockResolvedValue({ apiEnabled: over.apiEnabled ?? true, apiAllowedIps: over.apiAllowedIps ?? [] }),
  } as any;
  const gw = new TerminalGateway({} as any, agentWs, jwt, config, prisma, access, apiTokens, audit, instance);
  return { gw, agentWs, audit };
}

function req(url: string, token = "tugra.bearer, jwt-token", remoteAddress = "127.0.0.1") {
  return { url, headers: { "sec-websocket-protocol": token }, socket: { remoteAddress } } as any;
}

const connect = (gw: TerminalGateway, ws: any, r: any) => (gw as any).onConnection(ws, r);

describe("TerminalGateway", () => {
  it("rejects an unauthenticated connection (1008)", async () => {
    const { gw, agentWs } = make({ verifyAsync: jest.fn().mockRejectedValue(new Error("bad")) });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("accepts a valid JWT and starts a host terminal", async () => {
    const { gw, agentWs, audit } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    expect(ws.close).not.toHaveBeenCalled();
    expect(agentWs.sendToAgent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "term_start", target: "" }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "terminal.open", target: "s1" }),
    );
  });

  it("accepts a personal access token", async () => {
    const { gw, agentWs } = make({
      validate: jest.fn().mockResolvedValue({ userId: "u1" }),
      server: { id: "s1", teamId: "t1" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1", "tugra.bearer, tugra_pat_abc"));
    expect(agentWs.sendToAgent).toHaveBeenCalled();
  });

  it("rejects a PAT terminal when the API is disabled (kill-switch reaches the WS path)", async () => {
    const { gw, agentWs } = make({
      validate: jest.fn().mockResolvedValue({ userId: "u1" }),
      server: { id: "s1", teamId: "t1" },
      apiEnabled: false,
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1", "tugra.bearer, tugra_pat_abc"));
    expect(ws.close).toHaveBeenCalledWith(1008, "unauthorized");
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("rejects a PAT terminal from a source IP outside the allowlist", async () => {
    const { gw, agentWs } = make({
      validate: jest.fn().mockResolvedValue({ userId: "u1" }),
      server: { id: "s1", teamId: "t1" },
      apiAllowedIps: ["10.0.0.0/8"],
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1", "tugra.bearer, tugra_pat_abc", "203.0.113.7"));
    expect(ws.close).toHaveBeenCalledWith(1008, "unauthorized");
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("allows a PAT terminal from an allowlisted source IP", async () => {
    const { gw, agentWs } = make({
      validate: jest.fn().mockResolvedValue({ userId: "u1" }),
      server: { id: "s1", teamId: "t1" },
      apiAllowedIps: ["203.0.113.0/24"],
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1", "tugra.bearer, tugra_pat_abc", "203.0.113.7"));
    expect(agentWs.sendToAgent).toHaveBeenCalled();
  });

  it("does NOT gate a session JWT terminal (only PATs)", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
      apiEnabled: false, // API disabled — but a JWT session must still work
      apiAllowedIps: ["10.0.0.0/8"],
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1", "tugra.bearer, jwt-token", "203.0.113.7"));
    expect(agentWs.sendToAgent).toHaveBeenCalled();
  });

  it("starts a container terminal targeting tugra_<appId>", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      application: { id: "app1", teamId: "t1", serverId: "s1", source: "IMAGE" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?app=app1"));
    expect(agentWs.sendToAgent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "term_start", target: "tugra_app1" }),
    );
  });

  it("forbids a user without WRITE role (1008)", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    expect(ws.close).toHaveBeenCalledWith(1008, "forbidden");
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("opens a compose container terminal targeting the chosen service container", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      application: { id: "app1", teamId: "t1", serverId: "s1", source: "COMPOSE" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?app=app1&container=tugra_app1-web-1"));
    expect(agentWs.sendToAgent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "term_start", target: "tugra_app1-web-1" }),
    );
  });

  it("rejects a compose terminal without a container (1008)", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      application: { id: "app1", teamId: "t1", serverId: "s1", source: "COMPOSE" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?app=app1"));
    expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining("container"));
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("rejects a compose terminal targeting a foreign container (1008)", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      application: { id: "app1", teamId: "t1", serverId: "s1", source: "COMPOSE" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?app=app1&container=tugra_other-db-1"));
    expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining("container"));
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("closes when the agent is offline (1011)", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
      isOnline: false,
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    expect(ws.close).toHaveBeenCalledWith(1011, "agent offline");
    expect(agentWs.sendToAgent).not.toHaveBeenCalled();
  });

  it("relays agent term_output to the right web socket and closes on term_exit", async () => {
    const { gw } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    const sessionId = (gw as any).agentWs.sendToAgent.mock.calls[0][1].sessionId;

    gw.handleAgentTerminal("s1", { type: "term_output", sessionId, data: "aGk=" });
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "term_output", sessionId, data: "aGk=" }));

    gw.handleAgentTerminal("s1", { type: "term_exit", sessionId, exitCode: 0 });
    expect(ws.close).toHaveBeenCalledWith(1000, "exited");
    expect((gw as any).sessions.size).toBe(0);
  });

  it("closes all sessions on agent disconnect", async () => {
    const { gw } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    gw.handleServerDisconnect("s1");
    expect(ws.close).toHaveBeenCalledWith(1011, "agent disconnected");
    expect((gw as any).sessions.size).toBe(0);
    expect((gw as any).byServer.size).toBe(0);
  });

  it("accepts a short-lived term_ticket JWT (subprotocol)", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "term_ticket" }),
      server: { id: "s1", teamId: "t1" },
    });
    const ws = fakeWs();
    await connect(gw, ws, req("/terminal?server=s1"));
    expect(ws.close).not.toHaveBeenCalled();
    expect(agentWs.sendToAgent).toHaveBeenCalled();
  });

  it("falls back to the tg_access cookie when the subprotocol carries no token", async () => {
    const { gw, agentWs } = make({
      verifyAsync: jest.fn().mockResolvedValue({ sub: "u1", type: "access" }),
      server: { id: "s1", teamId: "t1" },
    });
    const ws = fakeWs();
    // No subprotocol header, but a same-origin browser upgrade carries the httpOnly cookie.
    await connect(gw, ws, {
      url: "/terminal?server=s1",
      headers: { cookie: "tg_access=jwt-from-cookie" },
    } as any);
    expect(agentWs.sendToAgent).toHaveBeenCalled();
  });

  describe("originAllowed", () => {
    function gw(webUrl = "http://localhost:3001") {
      const config = { get: jest.fn().mockReturnValue(webUrl) } as any;
      return new TerminalGateway({} as any, {} as any, {} as any, config, {} as any, {} as any, {} as any, {} as any, {} as any);
    }
    const check = (g: TerminalGateway, origin?: string) =>
      (g as any).originAllowed({ headers: origin ? { origin } : {} });

    it("allows a request with no Origin header (CLI/agent, subprotocol-authed)", () => {
      expect(check(gw())).toBe(true);
    });
    it("allows the SPA origin", () => {
      expect(check(gw("http://localhost:3001"), "http://localhost:3001")).toBe(true);
    });
    it("blocks a different origin (incl. same-site sibling subdomains)", () => {
      const g = gw("http://localhost:3001");
      expect(check(g, "http://evil.localhost:3001")).toBe(false);
      expect(check(g, "https://app.attacker.com")).toBe(false);
    });
    it("blocks a malformed Origin", () => {
      expect(check(gw(), "not-a-url")).toBe(false);
    });
  });
});
