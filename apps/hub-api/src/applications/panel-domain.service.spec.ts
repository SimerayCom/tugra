import { BadRequestException, ConflictException } from "@nestjs/common";
import { PanelDomainService, PANEL_DOMAIN_STATUS_KEY, PANEL_DOMAIN_UPDATER_KEY } from "./panel-domain.service";
import { PANEL_PENDING_KEY } from "../proxy-config/panel-pending";
import { UPDATE_LOCK_KEY, UPDATE_QUEUE_KEY } from "../update/updater.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import type { RedisService } from "../redis/redis.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { AuditService } from "../audit/audit.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import type { ProxyService } from "./proxy.service";

type Opts = {
  env?: Record<string, string | undefined>;
  local?: { id: string; status: string; publicIp?: string | null } | null;
  certAfterPolls?: number; // the probe answers CERT:1 from this poll on (default 1); Infinity = never
  dbAcmeEmail?: string | null;
};

const ONLINE = { id: "s-local", status: "ONLINE", publicIp: "203.0.113.9" };

function make(o: Opts = {}) {
  const store = new Map<string, string>();
  const queue: string[] = [];
  const redis = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    del: jest.fn(async (...ks: string[]) => void ks.forEach((k) => store.delete(k))),
    firstInWindow: jest.fn(async (k: string) => {
      if (store.has(k)) return false;
      store.set(k, "1");
      return true;
    }),
    client: { lpush: jest.fn(async (_k: string, v: string) => void queue.push(v)) },
  } as unknown as RedisService;
  const server = "local" in o ? o.local : ONLINE;
  const prisma = {
    server: {
      findFirst: jest.fn().mockResolvedValue(server),
      findUnique: jest.fn().mockResolvedValue(server ? { publicIp: server.publicIp ?? null } : null),
    },
  } as unknown as PrismaService;
  const env: Record<string, string | undefined> = { WEB_PUBLIC_URL: "http://203.0.113.9", PANEL_IP_ROUTE: "1", ...(o.env ?? {}) };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  let polls = 0;
  const after = o.certAfterPolls ?? 1;
  const sendCommand = jest.fn(async (_id: string, cmd: string) => {
    if (cmd.includes("CERT:")) {
      polls += 1;
      return { exitCode: 0, output: polls >= after ? "CERT:1" : "CERT:0" };
    }
    return { exitCode: 0, output: "acme: Unable to obtain ACME certificate for domain: some detail" };
  });
  const agentWs = { sendCommand } as unknown as AgentWsServer;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const settings = {
    get: jest.fn().mockResolvedValue({ acmeEmail: o.dbAcmeEmail ?? null }),
    update: jest.fn().mockResolvedValue(undefined),
    acmeEmailFor: jest.fn().mockImplementation(async (e?: string) => (e && e.trim() ? e.trim() : (o.dbAcmeEmail ?? undefined))),
  } as unknown as InstanceSettingsService;
  const proxy = { ensureProxy: jest.fn().mockResolvedValue(undefined) } as unknown as ProxyService;
  const svc = new PanelDomainService(prisma, config, redis, agentWs, audit, settings, proxy);
  svc.timing = { certTimeout: 30, certPoll: 1, ackTimeout: 40, applyTimeout: 80, watchPoll: 1_000_000, settleTries: 1 };
  const job = () => JSON.parse(store.get(PANEL_DOMAIN_STATUS_KEY) ?? "null");
  const runner = () => (svc as unknown as { runner: Promise<void> | null }).runner;
  return { svc, store, queue, redis, sendCommand, audit, settings, proxy, job, runner };
}

describe("PanelDomainService.set", () => {
  it("rejects an invalid domain / a placeholder email before touching anything", async () => {
    const { svc, proxy, store } = make();
    await expect(svc.set("u1", { domain: "http://x.com" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.set("u1", { domain: "1.2.3.4" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.set("u1", { domain: "panel.example.com", acmeEmail: "admin@example.com" })).rejects.toBeInstanceOf(BadRequestException);
    expect(proxy.ensureProxy).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("happy path: proxy first, certificate verified, THEN the updater job; the pending router is stored; audited; email optional", async () => {
    const { svc, proxy, queue, store, job, runner, audit, settings, sendCommand } = make();
    const st = await svc.set("u1", { domain: "Panel.Example.com" });
    expect(st.job.action).toBe("set");
    await runner();
    expect(proxy.ensureProxy).toHaveBeenCalledWith("s-local"); // non-force: recreates only when the config changed
    expect(JSON.parse(store.get(PANEL_PENDING_KEY) as string)).toEqual({ domain: "panel.example.com" });
    // the ACME store was probed for exactly this host (validated: safe inside the quoted pattern)
    expect(sendCommand.mock.calls[0][1]).toContain(`"main": *"panel.example.com"`);
    expect(queue).toHaveLength(1);
    const payload = JSON.parse(queue[0]);
    expect(payload).toMatchObject({ action: "panel-domain", domain: "panel.example.com", acmeEmail: "", publicIp: "" });
    expect(payload.jobId).toBe(job().jobId);
    expect(/^\d+$/.test(payload.requestedAt)).toBe(true);
    expect(job().phase).toBe("switching");
    expect(settings.update).not.toHaveBeenCalled(); // no email given, none stored
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ actor: "u1", action: "instance.panel_domain.set", target: "panel.example.com" }));
  });

  it("stores a given email in the settings (unless ACME_EMAIL is set in the env, which stays authoritative) and forwards it", async () => {
    const a = make();
    await a.svc.set("u1", { domain: "panel.example.com", acmeEmail: "ops@real-domain.io" });
    await a.runner();
    expect(a.settings.update).toHaveBeenCalledWith({ acmeEmail: "ops@real-domain.io" });
    expect(JSON.parse(a.queue[0]).acmeEmail).toBe("ops@real-domain.io");

    const b = make({ env: { ACME_EMAIL: "env@real-domain.io" } });
    await b.svc.set("u1", { domain: "panel.example.com", acmeEmail: "ops@real-domain.io" });
    await b.runner();
    expect(b.settings.update).not.toHaveBeenCalled();
    expect(JSON.parse(b.queue[0]).acmeEmail).toBe("env@real-domain.io");
  });

  it("ROLLBACK when the certificate never appears: pending dropped, proxy re-rendered, lock released, nothing queued, reason + log tail kept", async () => {
    const { svc, proxy, queue, store, job, runner, audit } = make({ certAfterPolls: Infinity });
    await svc.set("u1", { domain: "panel.example.com" });
    await runner();
    expect(queue).toHaveLength(0); // the URL was never switched: the old one kept working
    expect(store.has(PANEL_PENDING_KEY)).toBe(false);
    expect(store.has("instance:panel-domain:lock")).toBe(false);
    expect(proxy.ensureProxy).toHaveBeenCalledTimes(2); // add the new host, then re-render without it
    expect(job()).toMatchObject({ phase: "failed", code: "cert_timeout" });
    expect(job().detail).toContain("Unable to obtain ACME certificate");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.panel_domain.failed" }));
    // and the owner can simply try again
    const again = await svc.set("u1", { domain: "panel.example.com" });
    expect(again.job.phase).not.toBe("failed");
    await runner();
  });

  it("ROLLBACK when the proxy cannot be configured (e.g. port 80 taken): proxy_failed with the reason", async () => {
    const { svc, proxy, job, runner, queue } = make();
    (proxy.ensureProxy as jest.Mock).mockRejectedValueOnce(new Error("docker: port is already allocated"));
    await svc.set("u1", { domain: "panel.example.com" });
    await runner();
    expect(job()).toMatchObject({ phase: "failed", code: "proxy_failed", error: "docker: port is already allocated" });
    expect(queue).toHaveLength(0);
  });

  it("is idempotent: the host already served, or the same change already running, starts nothing new", async () => {
    const served = make({ env: { WEB_PUBLIC_URL: "https://panel.example.com" } });
    const st = await served.svc.set("u1", { domain: "panel.example.com" });
    expect(st.domain).toBe("panel.example.com");
    expect(served.proxy.ensureProxy).not.toHaveBeenCalled();

    const m = make();
    await m.svc.set("u1", { domain: "panel.example.com" });
    await m.svc.set("u1", { domain: "panel.example.com" }); // a retry / double click
    await m.runner();
    expect(m.queue).toHaveLength(1);
    await expect(m.svc.set("u1", { domain: "other.example.com" })).rejects.toBeInstanceOf(ConflictException); // a DIFFERENT change in flight
  });

  it("refuses while the local server is offline, there is no local server, or an update is running", async () => {
    await expect(make({ local: { id: "s", status: "OFFLINE" } }).svc.set("u", { domain: "panel.example.com" })).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ local: null }).svc.set("u", { domain: "panel.example.com" })).rejects.toBeInstanceOf(BadRequestException);
    const m = make();
    m.store.set(UPDATE_LOCK_KEY, "1");
    await expect(m.svc.set("u", { domain: "panel.example.com" })).rejects.toBeInstanceOf(ConflictException);
    expect(m.proxy.ensureProxy).not.toHaveBeenCalled();
  });
});

describe("PanelDomainService.reconcile (driven by the panel's poll)", () => {
  async function switching(o: Opts = {}) {
    const m = make(o);
    await m.svc.set("u1", { domain: "panel.example.com" });
    await m.runner();
    return m;
  }

  it("updater applied => the NEW hub settles: stored domain, pending dropped, router re-rendered, done; only once", async () => {
    const m = await switching();
    m.store.set(PANEL_DOMAIN_UPDATER_KEY, JSON.stringify({ jobId: m.job().jobId, phase: "applied", error: null }));
    m.proxy.ensureProxy = jest.fn().mockResolvedValue(undefined);
    await m.svc.reconcile();
    await m.svc.reconcile(); // a second poll must not settle twice
    expect(m.settings.update).toHaveBeenCalledTimes(1);
    expect(m.settings.update).toHaveBeenCalledWith({ panelDomain: "panel.example.com" });
    expect(m.store.has(PANEL_PENDING_KEY)).toBe(false);
    expect(m.job().phase).toBe("done");
    expect(m.store.has("instance:panel-domain:lock")).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(m.proxy.ensureProxy).toHaveBeenCalled();
  });

  it("an update from a DIFFERENT job id is ignored (a stale status key can never finish this change)", async () => {
    const m = await switching();
    m.store.set(PANEL_DOMAIN_UPDATER_KEY, JSON.stringify({ jobId: "someone-else", phase: "applied", error: null }));
    await m.svc.reconcile();
    expect(m.job().phase).toBe("switching");
  });

  it("updater failed => rolled back with the updater's reason", async () => {
    const m = await switching();
    m.store.set(PANEL_DOMAIN_UPDATER_KEY, JSON.stringify({ jobId: m.job().jobId, phase: "failed", error: "the hub did not become healthy on the new URL; the previous URL was restored" }));
    await m.svc.reconcile();
    expect(m.job()).toMatchObject({ phase: "failed", code: "updater_failed", error: expect.stringContaining("previous URL was restored") });
    expect(m.store.has(PANEL_PENDING_KEY)).toBe(false);
    expect(m.settings.update).not.toHaveBeenCalledWith({ panelDomain: "panel.example.com" });
  });

  it("no acknowledgement in time (an updater without panel-domain support) => rolled back, with the 'update the helper' reason", async () => {
    const m = await switching();
    await new Promise((r) => setTimeout(r, 60));
    await m.svc.reconcile();
    expect(m.job()).toMatchObject({ phase: "failed", code: "updater_stale" });
    expect(m.store.has(PANEL_PENDING_KEY)).toBe(false);
  });

  it("an 'applying' updater that never finishes times out", async () => {
    const m = await switching();
    m.store.set(PANEL_DOMAIN_UPDATER_KEY, JSON.stringify({ jobId: m.job().jobId, phase: "applying", error: null }));
    await new Promise((r) => setTimeout(r, 100));
    await m.svc.reconcile();
    expect(m.job()).toMatchObject({ phase: "failed", code: "updater_failed" });
  });
});

describe("PanelDomainService.remove", () => {
  const DOMAIN_ENV = { WEB_PUBLIC_URL: "https://panel.example.com", PANEL_IP_ROUTE: "0", PANEL_TLS: "1" };

  it("puts the IP route live first, then queues the switch back to http://<ip>/ (the IP the hub knows)", async () => {
    const m = make({ env: DOMAIN_ENV });
    await m.svc.remove("u1", {});
    await m.runner();
    expect(JSON.parse(m.store.get(PANEL_PENDING_KEY) as string)).toEqual({ domain: null });
    expect(m.proxy.ensureProxy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(m.queue[0])).toMatchObject({ action: "panel-domain", domain: "", publicIp: "203.0.113.9" });
    expect(m.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.panel_domain.remove", target: "panel.example.com" }));
  });

  it("finalizing a removal clears the stored domain", async () => {
    const m = make({ env: DOMAIN_ENV });
    await m.svc.remove("u1", {});
    await m.runner();
    m.store.set(PANEL_DOMAIN_UPDATER_KEY, JSON.stringify({ jobId: m.job().jobId, phase: "applied", error: null }));
    await m.svc.reconcile();
    expect(m.settings.update).toHaveBeenCalledWith({ panelDomain: null });
  });

  it("asks for the IP when the hub does not know it, and does nothing when there is no domain", async () => {
    const noIp = make({ env: DOMAIN_ENV, local: { id: "s-local", status: "ONLINE", publicIp: null } });
    await expect(noIp.svc.remove("u1", {})).rejects.toBeInstanceOf(ConflictException);
    await noIp.svc.remove("u1", { publicIp: "198.51.100.4" });
    await noIp.runner();
    expect(JSON.parse(noIp.queue[0]).publicIp).toBe("198.51.100.4");

    const ipOnly = make();
    const st = await ipOnly.svc.remove("u1", {});
    expect(st.mode).toBe("ip");
    expect(ipOnly.queue).toHaveLength(0);
  });
});

describe("PanelDomainService.status", () => {
  it("reports ip / domain / port mode from the public URL and the IP-route flag", async () => {
    expect((await make().svc.status()).mode).toBe("ip");
    const d = await make({ env: { WEB_PUBLIC_URL: "https://panel.example.com", PANEL_IP_ROUTE: undefined } }).svc.status();
    expect(d).toMatchObject({ mode: "domain", domain: "panel.example.com", localServerOnline: true });
    expect((await make({ env: { WEB_PUBLIC_URL: "http://203.0.113.9:3001", PANEL_IP_ROUTE: undefined } }).svc.status()).mode).toBe("port");
  });
  it("is idle with no job", async () => {
    expect((await make().svc.status()).job).toMatchObject({ phase: "idle", action: null });
  });
});
