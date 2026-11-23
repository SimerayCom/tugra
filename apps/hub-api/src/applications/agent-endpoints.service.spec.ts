import { Prisma } from "@prisma/client";
import { X509Certificate } from "node:crypto";
import { AgentEndpointsService } from "./agent-endpoints.service";
import { graceRoutes, parseGrace } from "../agent-gateway/hub-endpoints";
import type { PrismaService } from "../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import type { CryptoService } from "../crypto/crypto.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { ProxyService } from "./proxy.service";

type ServerRow = { id: string; name: string; status: string; hubEndpointActive: string | null; hubEndpointPrimary?: string | null; hubEndpointError: string | null; isLocal?: boolean };

interface Opts {
  env?: Record<string, string | undefined>;
  servers?: ServerRow[];
  online?: string[]; // server ids with an open socket
  supported?: string[]; // server ids whose agent advertises hub_endpoints_v1
  settings?: Record<string, unknown>;
}

const LOCAL = { id: "local", isLocal: true, proxyBind: "public" };

function make(o: Opts = {}) {
  const row: Record<string, unknown> = { ipTlsCertPem: null, ipTlsKeyEnc: null, ipTlsServedFp: null, agentEndpointGrace: null, ...(o.settings ?? {}) };
  const servers: ServerRow[] = o.servers ?? [];
  const online = new Set(o.online ?? servers.map((s) => s.id));
  const supported = new Set(o.supported ?? servers.map((s) => s.id));
  const sent: Array<{ id: string; msg: Record<string, unknown> }> = [];
  const env: Record<string, string | undefined> = { WEB_PUBLIC_URL: "http://203.0.113.7", PANEL_IP_ROUTE: "1", ...(o.env ?? {}) };

  const prisma = {
    server: {
      findMany: jest.fn(async () => servers.filter((s) => !s.isLocal && s.status !== "PENDING")),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "local") return { isLocal: true };
        const s = servers.find((x) => x.id === where.id);
        return s ? { isLocal: false } : null;
      }),
      findFirst: jest.fn(async () => LOCAL),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = servers.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
      }),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    instanceSettings: {
      updateMany: jest.fn(async ({ where, data }: { where: { ipTlsCertPem: null }; data: Record<string, unknown> }) => {
        if (row.ipTlsCertPem !== where.ipTlsCertPem) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;
  const settings = {
    get: jest.fn(async () => ({ ...row })),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) row[k] = v === Prisma.DbNull ? null : v;
      return { ...row };
    }),
  } as unknown as InstanceSettingsService;
  const crypto = { encrypt: (s: string) => `enc:${Buffer.from(s).toString("base64")}`, decrypt: (s: string) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString() } as unknown as CryptoService;
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const agentWs = {
    setHubEndpointsHooks: jest.fn(),
    agentSupports: jest.fn((id: string, feature: string) => online.has(id) && supported.has(id) && feature === "hub_endpoints_v1"),
    isOnline: jest.fn((id: string) => online.has(id)),
    sendToAgent: jest.fn((id: string, msg: Record<string, unknown>) => (online.has(id) ? (sent.push({ id, msg }), true) : false)),
  } as unknown as AgentWsServer;
  const proxy = { ensureProxy: jest.fn().mockResolvedValue(undefined) } as unknown as ProxyService;
  const svc = new AgentEndpointsService(prisma, config, settings, crypto, agentWs, proxy);
  svc.timing = { sweep: 1_000_000, moveWait: 40, movePoll: 5, switchStale: 60 * 60_000 };
  return { svc, row, servers, sent, env, prisma, settings, agentWs, proxy, online };
}

const srv = (id: string, active: string | null = null, extra: Partial<ServerRow> = {}): ServerRow => ({ id, name: `srv-${id}`, status: "ONLINE", hubEndpointActive: active, hubEndpointError: null, ...extra });
const listOf = (m: { sent: Array<{ id: string; msg: Record<string, unknown> }> }, i = -1) => JSON.parse(m.sent.at(i)!.msg.endpointsJson as string);

describe("IP-mode certificate", () => {
  it("is generated ONCE (the key encrypted at rest) and the same one is returned afterwards", async () => {
    const { svc, row } = make();
    const a = await svc.ensureIpTls();
    const b = await svc.ensureIpTls();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(row.ipTlsKeyEnc)).toMatch(/^enc:/);
    expect(String(row.ipTlsKeyEnc)).not.toContain("PRIVATE KEY"); // not the plaintext PEM
    expect(new X509Certificate(a.certPem).subjectAltName).toBe("IP Address:203.0.113.7"); // the IP the hub is reached on
    expect(a.keyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("two concurrent first uses end with ONE certificate (the loser adopts the winner's)", async () => {
    const { svc } = make();
    const [x, y] = await Promise.all([svc.ensureIpTls(), svc.ensureIpTls()]);
    expect(x.fingerprint).toBe(y.fingerprint);
  });

  it("is never replaced implicitly: a changed public IP keeps the pinned certificate", async () => {
    const m = make();
    const first = await m.svc.ensureIpTls();
    m.env.WEB_PUBLIC_URL = "http://198.51.100.9";
    expect((await m.svc.ensureIpTls()).fingerprint).toBe(first.fingerprint);
  });
});

describe("IP transport (what the add-server command may hand out)", () => {
  it("only IP mode (PANEL_IP_ROUTE=1 + a bare-IP URL without a port) has an IP address", () => {
    expect(make().svc.ipModeAddress()).toBe("203.0.113.7");
    expect(make({ env: { PANEL_IP_ROUTE: "0" } }).svc.ipModeAddress()).toBeNull();
    expect(make({ env: { WEB_PUBLIC_URL: "https://panel.example.com" } }).svc.ipModeAddress()).toBeNull();
    expect(make({ env: { WEB_PUBLIC_URL: "http://203.0.113.7:3001" } }).svc.ipModeAddress()).toBeNull();
  });

  it("is withheld until the proxy was actually configured with THIS certificate", async () => {
    const m = make();
    expect(await m.svc.installTransport()).toBeNull(); // no certificate yet
    const c = await m.svc.ensureIpTls();
    expect(await m.svc.installTransport()).toBeNull(); // generated but not served: a dead address is never handed out
    await m.settings.update({ ipTlsServedFp: c.fingerprint });
    const t = await m.svc.installTransport();
    expect(t).toMatchObject({ ip: "203.0.113.7", hubUrl: "wss://203.0.113.7/agent", pin: c.fingerprint, origin: "https://203.0.113.7" });
    expect(t!.spkiPin).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    await m.settings.update({ ipTlsServedFp: "sha256:" + "00".repeat(32) }); // a different certificate was served
    expect(await m.svc.installTransport()).toBeNull();
  });

  it("a request for another host never gets the IP transport", async () => {
    const m = make();
    const c = await m.svc.ensureIpTls();
    await m.settings.update({ ipTlsServedFp: c.fingerprint });
    expect(await m.svc.installTransport("http://198.51.100.9")).toBeNull();
    expect(await m.svc.installTransport("http://203.0.113.7")).not.toBeNull();
  });

  it("syncIpTls configures the local proxy (certificate + routers) and only then marks the certificate as served", async () => {
    const m = make();
    await m.svc.syncIpTls();
    expect(m.proxy.ensureProxy).toHaveBeenCalledWith("local");
    const c = await m.svc.ensureIpTls();
    expect(m.row.ipTlsServedFp).toBe(c.fingerprint);
    // a failing proxy setup never marks it served
    const f = make();
    (f.proxy.ensureProxy as jest.Mock).mockRejectedValue(new Error("port 443 taken"));
    await expect(f.svc.syncIpTls()).rejects.toThrow("port 443 taken");
    expect(f.row.ipTlsServedFp).toBeNull();
  });

  it("syncIpTls does nothing outside IP mode (no grace)", async () => {
    const m = make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://panel.example.com" } });
    await m.svc.syncIpTls();
    expect(m.proxy.ensureProxy).not.toHaveBeenCalled();
    expect(m.row.ipTlsCertPem).toBeNull();
  });
});

describe("the list agents hold", () => {
  it("a domain instance: [wss://<domain>/agent]; an http / port-mode instance: nothing to push", async () => {
    expect(await make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://panel.example.com" } }).svc.currentList()).toEqual([{ url: "wss://panel.example.com/agent" }]);
    expect(await make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "http://203.0.113.7:3001" } }).svc.currentList()).toBeNull();
    expect(await make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "http://panel.example.com" } }).svc.currentList()).toBeNull(); // plain http: no wss to point at
  });

  it("an IP instance: the pinned wss://<ip>/agent, once served", async () => {
    const m = make();
    expect(await m.svc.currentList()).toBeNull(); // not served yet
    const c = await m.svc.ensureIpTls();
    await m.settings.update({ ipTlsServedFp: c.fingerprint });
    expect(await m.svc.currentList()).toEqual([{ url: "wss://203.0.113.7/agent", pin: c.fingerprint }]);
  });

  it("during a grace the list is [new address, ...old addresses], whatever the env says", async () => {
    const m = make({
      env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://old.example.com" },
      settings: { agentEndpointGrace: { v: 1, startedAt: Date.now(), expiresAt: Date.now() + 1e6, primary: { url: "wss://new.example.com/agent" }, fallbacks: [{ url: "wss://old.example.com/agent" }] } },
    });
    expect((await m.svc.currentList())!.map((e) => e.url)).toEqual(["wss://new.example.com/agent", "wss://old.example.com/agent"]);
  });
});

describe("pushing and bookkeeping", () => {
  const domainEnv = { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://panel.example.com" };

  it("sends a signed-frame request (type, serverId, strictly increasing rev, the exact JSON) only to remote agents that understand it", async () => {
    const m = make({ env: domainEnv, servers: [srv("a"), srv("b"), srv("c"), srv("d")], online: ["a", "b", "d"], supported: ["a", "d"] });
    expect(await m.svc.pushAll()).toBe(2); // b is too old, c is offline
    expect(m.sent.map((s) => s.id)).toEqual(["a", "d"]);
    const [x, y] = m.sent.map((s) => s.msg);
    expect(x).toMatchObject({ type: "hub_endpoints", serverId: "a", endpointsJson: '[{"url":"wss://panel.example.com/agent"}]' });
    expect(y!.serverId).toBe("d");
    expect(y!.rev as number).toBeGreaterThan(x!.rev as number);
  });

  it("pushes nothing when the instance has no address to offer, and never to the local server", async () => {
    const none = make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "http://203.0.113.7:3001" }, servers: [srv("a")] });
    expect(await none.svc.pushAll()).toBe(0);
    const m = make({ env: domainEnv, servers: [srv("a")] });
    expect(await m.svc.pushTo("local")).toBe(false);
    expect(await m.svc.pushTo("ghost")).toBe(false);
    expect(m.sent).toHaveLength(0);
  });

  it("registers its hooks on boot, pushes on connect, and for the local server syncs the IP certificate instead", async () => {
    const m = make({ env: domainEnv, servers: [srv("a")] });
    m.svc.onApplicationBootstrap();
    m.svc.onModuleDestroy();
    const hooks = (m.agentWs.setHubEndpointsHooks as jest.Mock).mock.calls[0][0];
    hooks.onConnect("a");
    await new Promise((r) => setImmediate(r));
    expect(m.sent).toHaveLength(1);
    const ip = make({ servers: [srv("a")] });
    ip.svc.onApplicationBootstrap();
    ip.svc.onModuleDestroy();
    (ip.agentWs.setHubEndpointsHooks as jest.Mock).mock.calls[0][0].onConnect("local");
    await new Promise((r) => setImmediate(r));
    expect(ip.proxy.ensureProxy).toHaveBeenCalledWith("local");
    expect(ip.sent).toHaveLength(0);
  });

  it("stores what the agent reports: its active endpoint, list revision, and why it refused a list", async () => {
    const m = make({ env: domainEnv, servers: [srv("a")] });
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: 1731672000123, active: "wss://x/agent", primary: "wss://y/agent", accepted: true });
    expect(m.servers[0]).toMatchObject({ hubEndpointActive: "wss://x/agent", hubEndpointPrimary: "wss://y/agent", hubEndpointError: null });
    expect((m.servers[0] as unknown as { hubEndpointRev: bigint }).hubEndpointRev).toBe(1731672000123n);
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: 1, active: "wss://x/agent", primary: "wss://y/agent", accepted: false, error: "invalid signature" });
    expect(m.servers[0]!.hubEndpointError).toBe("invalid signature");
  });

  it("an agent refusing a list as older than the rev it holds (hub clock jumped / restored behind) raises the counter and gets the list again, once", async () => {
    const m = make({ env: domainEnv, servers: [srv("a")] });
    const held = Date.now() + 90 * 24 * 3600_000; // an earlier list pushed while the hub clock ran ahead
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: held, active: "wss://x/agent", primary: "wss://x/agent", accepted: false, error: "hub endpoint list is older than the one already accepted" });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.msg.rev as number).toBeGreaterThan(held);
    // the same report again (no new information) must not loop
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: held, active: "wss://x/agent", primary: "wss://x/agent", accepted: false, error: "malformed list" });
    expect(m.sent).toHaveLength(1);
    // and a successful report never triggers a push
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: held * 2, active: "wss://x/agent", primary: "wss://x/agent", accepted: true });
    expect(m.sent).toHaveLength(1);
  });

  it("bounds and sanitises a hostile report (oversized strings, junk rev)", async () => {
    const m = make({ env: domainEnv, servers: [srv("a")] });
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: Number.NaN, active: "x".repeat(5000), primary: 7 as unknown as string, accepted: false });
    expect(m.servers[0]!.hubEndpointActive).toHaveLength(300);
    expect(m.servers[0]!.hubEndpointPrimary).toBeNull();
    expect((m.servers[0] as unknown as { hubEndpointRev: bigint | null }).hubEndpointRev).toBeNull();
    expect(m.servers[0]!.hubEndpointError).toBe("refused");
  });
});

describe("moving the agents (grace)", () => {
  const OLD = "wss://old.example.com/agent";
  const NEW = "wss://new.example.com/agent";
  const oldEnv = { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://old.example.com" };

  it("plans: the new address first, every current address behind it; an IP target creates the certificate", async () => {
    const m = make({ env: oldEnv });
    expect(await m.svc.planMove({ kind: "domain", domain: "new.example.com" })).toEqual({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    const ip = await m.svc.planMove({ kind: "ip", ip: "203.0.113.7" });
    expect(ip.primary.url).toBe("wss://203.0.113.7/agent");
    expect(ip.primary.pin).toBe((await m.svc.ensureIpTls()).fingerprint);
    expect(ip.fallbacks).toEqual([{ url: OLD }]);
    // from a port-mode hub there is no current address to keep: the agents keep their own install-time URL
    const port = make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "http://203.0.113.7:3001" } });
    expect((await port.svc.planMove({ kind: "domain", domain: "new.example.com" })).fallbacks).toEqual([]);
  });

  it("IP mode: the IP route stays a fallback even though its TLS was never confirmed served (it is what the agents dial)", async () => {
    const m = make({ servers: [srv("a")] }); // PANEL_IP_ROUTE=1, http://203.0.113.7, ipTlsServedFp null
    expect(await m.svc.currentList()).toBeNull();
    const plan = await m.svc.planMove({ kind: "domain", domain: "new.example.com" });
    expect(plan.primary.url).toBe(NEW);
    expect(plan.fallbacks).toEqual([{ url: "wss://203.0.113.7/agent", pin: (await m.svc.ensureIpTls()).fingerprint }]);
    await m.svc.beginMove(plan);
    expect(graceRoutes(parseGrace(m.row.agentEndpointGrace), Date.now()).ip).toBe(true);
  });

  it("with no remote agent there is nothing to keep routable: no grace is created", async () => {
    const m = make({ env: oldEnv, servers: [] });
    expect(await m.svc.beginMove({ primary: { url: NEW }, fallbacks: [{ url: OLD }] })).toEqual({ total: 0, moved: 0 });
    expect(m.row.agentEndpointGrace).toBeNull();
    expect(m.proxy.ensureProxy).not.toHaveBeenCalled();
  });

  it("begin: persists the grace FIRST (so the routes survive anything), renders the proxy, pushes the new list to every connected agent", async () => {
    const m = make({ env: oldEnv, servers: [srv("a"), srv("b")] });
    const order: string[] = [];
    (m.settings.update as jest.Mock).mockImplementationOnce(async (p: Record<string, unknown>) => (order.push("persist"), void (m.row.agentEndpointGrace = p.agentEndpointGrace)));
    (m.proxy.ensureProxy as jest.Mock).mockImplementationOnce(async () => void order.push("proxy"));
    m.agentWs.sendToAgent = jest.fn((id: string, msg: Record<string, unknown>) => (order.push(`push:${id}`), m.sent.push({ id, msg }), true));
    const res = await m.svc.beginMove({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    expect(order.slice(0, 4)).toEqual(["persist", "proxy", "push:a", "push:b"]);
    const g = parseGrace(m.row.agentEndpointGrace)!;
    expect(g.pendingSwitch).toBe(true);
    expect(g.primary.url).toBe(NEW);
    expect(g.fallbacks.map((f) => f.url)).toEqual([OLD]);
    expect(g.expiresAt - g.startedAt).toBeLessThanOrEqual(7 * 24 * 3600_000);
    expect(listOf(m).map((e: { url: string }) => e.url)).toEqual([NEW, OLD]);
    expect(res.total).toBe(2);
  });

  it("begin waits (briefly) for agents that CAN move, never for offline or old ones", async () => {
    const m = make({ env: oldEnv, servers: [srv("a"), srv("b"), srv("c")], online: ["a", "b"], supported: ["a"] });
    const t0 = Date.now();
    // a answers on its second poll; b is too old, c is offline
    setTimeout(() => void (m.servers[0]!.hubEndpointActive = NEW), 15);
    const res = await m.svc.beginMove({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    expect(res).toEqual({ total: 3, moved: 1 });
    expect(Date.now() - t0).toBeLessThan(40 + 200);
  });

  it("begin gives up waiting at the deadline: a straggler never blocks the change (the grace protects it)", async () => {
    const m = make({ env: oldEnv, servers: [srv("a")] });
    const res = await m.svc.beginMove({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    expect(res).toEqual({ total: 1, moved: 0 });
    expect(m.row.agentEndpointGrace).not.toBeNull();
  });

  it("while the panel switch is pending the grace is NEVER ended by 'everyone moved' (the hub's own address is still the old one)", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", NEW)] });
    await m.svc.beginMove({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    m.sent.length = 0;
    await m.svc.sweep();
    expect(m.row.agentEndpointGrace).not.toBeNull();
    expect(m.sent).toHaveLength(0); // and no list that would drag the agents back to the old address
  });

  it("markSwitched lets the grace end; once EVERY agent reports the new address it ends: routes dropped, list without the old address pushed", async () => {
    const m = make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://new.example.com" }, servers: [srv("a", OLD), srv("b", NEW)] });
    m.row.agentEndpointGrace = { v: 1, startedAt: Date.now(), expiresAt: Date.now() + 1e6, primary: { url: NEW }, fallbacks: [{ url: OLD }], pendingSwitch: true };
    await m.svc.markSwitched();
    expect(parseGrace(m.row.agentEndpointGrace)!.pendingSwitch).toBeUndefined();
    await m.svc.sweep(); // a has not moved yet
    expect(m.row.agentEndpointGrace).not.toBeNull();
    m.servers[0]!.hubEndpointActive = NEW;
    (m.proxy.ensureProxy as jest.Mock).mockClear();
    m.sent.length = 0;
    await m.svc.onState("a", { type: "hub_endpoint_state", rev: 1, active: NEW, primary: NEW, accepted: true }); // the agent's report drives it
    expect(m.row.agentEndpointGrace).toBeNull();
    expect(m.proxy.ensureProxy).toHaveBeenCalledWith("local"); // the old host / IP route are re-rendered away
    expect(listOf(m).map((e: { url: string }) => e.url)).toEqual([NEW]);
  });

  it("an offline agent holds the grace open; it ends at the 7-day limit regardless", async () => {
    const m = make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://new.example.com" }, servers: [srv("a", NEW), srv("off", OLD)], online: ["a"] });
    m.row.agentEndpointGrace = { v: 1, startedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, primary: { url: NEW }, fallbacks: [{ url: OLD }] };
    await m.svc.sweep();
    expect(m.row.agentEndpointGrace).not.toBeNull();
    (m.row.agentEndpointGrace as { expiresAt: number }).expiresAt = Date.now() - 1;
    await m.svc.sweep();
    expect(m.row.agentEndpointGrace).toBeNull();
  });

  it("the owner can stop waiting: release ends it now", async () => {
    const m = make({ env: { PANEL_IP_ROUTE: "0", WEB_PUBLIC_URL: "https://new.example.com" }, servers: [srv("off", OLD)], online: [] });
    m.row.agentEndpointGrace = { v: 1, startedAt: Date.now() - 1000, expiresAt: Date.now() + 1e6, primary: { url: NEW }, fallbacks: [{ url: OLD }] };
    await m.svc.release();
    expect(m.row.agentEndpointGrace).toBeNull();
    expect(m.proxy.ensureProxy).toHaveBeenCalled();
  });

  it("a switch that never finished is abandoned after an hour, so a dead job cannot hold routes open for ever", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", OLD)] });
    m.row.agentEndpointGrace = { v: 1, startedAt: Date.now() - 2 * 3600_000, expiresAt: Date.now() + 1e6, primary: { url: NEW }, fallbacks: [{ url: OLD }], pendingSwitch: true };
    await m.svc.sweep();
    expect(m.row.agentEndpointGrace).toBeNull();
  });

  it("cancel (the change failed before the switch): the grace is dropped and the CURRENT list goes back out so agents return", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", NEW)] });
    await m.svc.beginMove({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    m.sent.length = 0;
    await m.svc.cancelMove();
    expect(m.row.agentEndpointGrace).toBeNull();
    expect(listOf(m).map((e: { url: string }) => e.url)).toEqual([OLD]);
    await m.svc.cancelMove(); // idempotent
  });

  it("an expired grace writes down the agents it leaves behind (the list is gone once the grace is)", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", NEW), srv("b", OLD)], supported: ["a"] });
    m.row.agentEndpointGrace = { v: 1, startedAt: Date.now() - 8 * 24 * 3600_000, expiresAt: Date.now() - 1000, primary: { url: NEW }, fallbacks: [{ url: OLD }] };
    await m.svc.sweep();
    expect(m.row.agentEndpointGrace).toBeNull();
    const create = (m.prisma as unknown as { auditLog: { create: jest.Mock } }).auditLog.create;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({ actor: "system", action: "instance.panel_domain.agents_left_behind", target: NEW });
    expect(create.mock.calls[0][0].data.meta.servers).toEqual([{ id: "b", name: "srv-b", reason: "old_agent" }]);
  });

  it("cancel leaves a grace it did not open alone (a failure before moveAgents must not strand an earlier change's stragglers)", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", OLD)] });
    const earlier = { v: 1, startedAt: Date.now(), expiresAt: Date.now() + 1e6, primary: { url: NEW }, fallbacks: [{ url: OLD }] };
    m.row.agentEndpointGrace = earlier;
    m.sent.length = 0;
    await m.svc.cancelMove();
    expect(m.row.agentEndpointGrace).toEqual(earlier);
    expect(m.sent).toHaveLength(0);
  });

  it("cancel restores the earlier, still-open grace that this change replaced", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", OLD)] });
    const earlier = { v: 1, startedAt: Date.now(), expiresAt: Date.now() + 1e6, primary: { url: NEW }, fallbacks: [{ url: OLD }] };
    m.row.agentEndpointGrace = earlier;
    await m.svc.beginMove({ primary: { url: "wss://third.example.com/agent" }, fallbacks: [{ url: NEW }, { url: OLD }] });
    const during = parseGrace(m.row.agentEndpointGrace)!;
    expect(during.pendingSwitch).toBe(true);
    expect(during.previous?.primary.url).toBe(NEW);
    m.sent.length = 0;
    await m.svc.cancelMove();
    expect(parseGrace(m.row.agentEndpointGrace)).toMatchObject({ primary: { url: NEW }, fallbacks: [{ url: OLD }] });
    expect(parseGrace(m.row.agentEndpointGrace)!.pendingSwitch).toBeUndefined();
    expect(listOf(m).map((e: { url: string }) => e.url)).toEqual([NEW, OLD]); // agents get the earlier list back
  });

  it("status: moved / total and each straggler with why; null when nothing is being waited on", async () => {
    const m = make({ env: oldEnv, servers: [srv("a", NEW), srv("b", OLD), srv("c", OLD), srv("d")], online: ["a", "b", "d"], supported: ["a", "b"] });
    expect(await m.svc.status()).toBeNull();
    m.row.agentEndpointGrace = { v: 1, startedAt: Date.now(), expiresAt: Date.now() + 1e6, primary: { url: NEW }, fallbacks: [{ url: OLD }], pendingSwitch: true };
    const st = await m.svc.status();
    expect(st).toMatchObject({ primaryUrl: NEW, total: 4, moved: 1, switching: true });
    expect(st!.pending.map((p) => [p.name, p.reason])).toEqual([["srv-b", "waiting"], ["srv-c", "offline"], ["srv-d", "old_agent"]]);
  });
});
