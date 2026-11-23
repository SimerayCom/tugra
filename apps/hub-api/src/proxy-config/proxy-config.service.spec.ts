import { ProxyConfigService } from "./proxy-config.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { RedisService } from "../redis/redis.service";

type Opts = {
  env?: Record<string, string | undefined>;
  serverRow?: Record<string, unknown> | null;
  acmeEmail?: string;
  panelDomain?: string | null; // what settings.panelDomainFor returns
  dbPanelDomain?: string | null; // what settings.get().panelDomain returns (bootstrap)
  settingsRow?: Record<string, unknown>; // extra InstanceSettings columns (agentEndpointGrace, ipTls*)
  decrypt?: (s: string) => string;
  pending?: string | null; // the raw Redis value of the in-flight panel-domain change
};

function make(o: Opts = {}) {
  const config = { get: (k: string) => o.env?.[k] } as unknown as ConfigService;
  const prisma = { server: { findUnique: jest.fn().mockResolvedValue(o.serverRow ?? null) } } as unknown as PrismaService;
  const crypto = {
    decrypt:
      o.decrypt ??
      ((s: string) => s),
  } as unknown as CryptoService;
  const update = jest.fn().mockResolvedValue(undefined);
  const settings = {
    acmeEmailFor: jest.fn().mockResolvedValue("acmeEmail" in o ? o.acmeEmail : "ops@tugra.io"),
    panelDomainFor: jest.fn().mockResolvedValue(o.panelDomain ?? null),
    get: jest.fn().mockResolvedValue({ panelDomain: o.dbPanelDomain ?? null, ...(o.settingsRow ?? {}) }),
    update,
  } as unknown as InstanceSettingsService;
  const redis = { get: jest.fn().mockResolvedValue(o.pending ?? null) } as unknown as RedisService;
  return { svc: new ProxyConfigService(config, prisma, crypto, settings, redis), update };
}

const localHttp = { isLocal: true, certMode: "http", dnsProvider: null, dnsCredsEnc: null, proxyBind: "public" };

describe("ProxyConfigService.resolveFor — accessLog", () => {
  it("reads Server.trafficAnalytics: true => accessLog true", async () => {
    const { svc } = make({ serverRow: { ...localHttp, isLocal: false, trafficAnalytics: true } });
    expect((await svc.resolveFor("s1")).accessLog).toBe(true);
  });
  it("defaults to false when the flag is off or the server row is missing", async () => {
    expect((await make({ serverRow: { ...localHttp, trafficAnalytics: false } }).svc.resolveFor("s1")).accessLog).toBe(false);
    expect((await make({ serverRow: null }).svc.resolveFor("s1")).accessLog).toBe(false);
  });
});

describe("ProxyConfigService.resolveFor — panel decision", () => {
  it("returns a panel for a LOCAL server with a panel domain + valid email (resolver 'le')", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "app.example.com" });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toEqual({ domain: "app.example.com", resolver: "le" });
  });

  it("picks resolver 'le-dns' when the local server has le-dns with decryptable creds", async () => {
    const { svc } = make({
      serverRow: { isLocal: true, certMode: "le-dns", dnsProvider: "cloudflare", dnsCredsEnc: "enc", proxyBind: "public" },
      panelDomain: "app.example.com",
      decrypt: () => JSON.stringify({ CF_DNS_API_TOKEN: "t" }),
    });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toEqual({ domain: "app.example.com", resolver: "le-dns" });
    expect(cfg.dnsProvider).toBe("cloudflare");
  });

  it("falls back to resolver 'le' when le-dns creds are unreadable (fail-safe)", async () => {
    const { svc } = make({
      serverRow: { isLocal: true, certMode: "le-dns", dnsProvider: "cloudflare", dnsCredsEnc: "bad", proxyBind: "public" },
      panelDomain: "app.example.com",
      decrypt: () => {
        throw new Error("cannot decrypt");
      },
    });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toEqual({ domain: "app.example.com", resolver: "le" });
    expect(cfg.dnsProvider).toBeUndefined();
  });

  it("NEVER returns a panel for a non-local server", async () => {
    const { svc } = make({ serverRow: { ...localHttp, isLocal: false }, panelDomain: "app.example.com" });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toBeUndefined();
  });

  it("omits the panel when no panel domain is configured", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: null });
    expect((await svc.resolveFor("s1")).panel).toBeUndefined();
  });

  it("omits the panel when the ACME email is a placeholder (so the recreate never throws)", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "app.example.com", acmeEmail: "admin@example.com" });
    expect((await svc.resolveFor("s1")).panel).toBeUndefined();
  });

  it("always resolves bind from the server row", async () => {
    const { svc } = make({ serverRow: { ...localHttp, proxyBind: "loopback" } });
    expect((await svc.resolveFor("s1")).bind).toBe("loopback");
  });

  // DNS-01 for the panel via env (install.sh --acme-dns-cloudflare), so hub recreates keep le-dns.
  it("local server + env ACME_DNS_* (no stored creds) => le-dns panel + cloudflare creds from env", async () => {
    const { svc } = make({
      env: { ACME_DNS_PROVIDER: "cloudflare", ACME_DNS_TOKEN: "cf-tok" },
      serverRow: localHttp,
      panelDomain: "demo.tugra.io",
    });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toEqual({ domain: "demo.tugra.io", resolver: "le-dns" });
    expect(cfg.dnsProvider).toBe("cloudflare");
    expect(cfg.dnsCreds).toEqual({ CF_DNS_API_TOKEN: "cf-tok" });
  });

  it("env ACME_DNS_* is ignored for a NON-local server", async () => {
    const { svc } = make({
      env: { ACME_DNS_PROVIDER: "cloudflare", ACME_DNS_TOKEN: "cf-tok" },
      serverRow: { ...localHttp, isLocal: false },
      panelDomain: "demo.tugra.io",
    });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toBeUndefined();
    expect(cfg.dnsProvider).toBeUndefined();
  });

  it("an unsupported env DNS provider falls back to HTTP-01 (le), never breaks resolution", async () => {
    const { svc } = make({
      env: { ACME_DNS_PROVIDER: "route53", ACME_DNS_TOKEN: "x" },
      serverRow: localHttp,
      panelDomain: "demo.tugra.io",
    });
    const cfg = await svc.resolveFor("s1");
    expect(cfg.panel).toEqual({ domain: "demo.tugra.io", resolver: "le" });
    expect(cfg.dnsProvider).toBeUndefined();
  });
});

describe("ProxyConfigService.onApplicationBootstrap — env PANEL_DOMAIN -> DB sync", () => {
  it("writes the DB when PANEL_TLS=1 and PANEL_DOMAIN differs from the stored value", async () => {
    const { svc, update } = make({ env: { PANEL_TLS: "1", PANEL_DOMAIN: "app.example.com" }, dbPanelDomain: null });
    await svc.onApplicationBootstrap();
    expect(update).toHaveBeenCalledWith({ panelDomain: "app.example.com" });
  });

  it("does NOT write when the env domain already matches the DB", async () => {
    const { svc, update } = make({ env: { PANEL_TLS: "1", PANEL_DOMAIN: "app.example.com" }, dbPanelDomain: "app.example.com" });
    await svc.onApplicationBootstrap();
    expect(update).not.toHaveBeenCalled();
  });

  it("does NOT write when PANEL_TLS is unset (env leaves the DB alone)", async () => {
    const { svc, update } = make({ env: { PANEL_DOMAIN: "app.example.com" }, dbPanelDomain: null });
    await svc.onApplicationBootstrap();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("InstanceSettingsService.panelDomainFor — env-over-DB precedence", () => {
  function svc(dbDomain: string | null) {
    const prisma = {
      instanceSettings: { findUnique: jest.fn().mockResolvedValue({ id: "singleton", panelDomain: dbDomain }) },
    } as unknown as PrismaService;
    return new InstanceSettingsService(prisma, { encrypt: (s: string) => `ENC(${s})` } as never);
  }
  it("env PANEL_TLS=1 + domain wins over the DB", async () => {
    expect(await svc("db.example.com").panelDomainFor("env.example.com", "1")).toBe("env.example.com");
  });
  it("PANEL_TLS unset or 0 ignores the env domain and uses the DB", async () => {
    expect(await svc("db.example.com").panelDomainFor("env.example.com", undefined)).toBe("db.example.com");
    expect(await svc("db.example.com").panelDomainFor("env.example.com", "0")).toBe("db.example.com");
  });
  it("null DB + no env => null (bring-your-own proxy)", async () => {
    expect(await svc(null).panelDomainFor(undefined, undefined)).toBeNull();
  });
});

describe("ProxyConfigService.resolveFor — IP route, optional email, domain change in flight", () => {
  it("a plain install (PANEL_IP_ROUTE=1, no domain, no email) gets the host-less IP route", async () => {
    const { svc } = make({ serverRow: localHttp, env: { PANEL_IP_ROUTE: "1" }, acmeEmail: undefined });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: null, resolver: "le", ipRoute: true });
  });

  it("the ACME email is optional: a domain with NO email still resolves (the resolver just has no contact)", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "app.example.com", acmeEmail: undefined });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: "app.example.com", resolver: "le" });
  });

  it("a domain change in flight renders the NEW host next to the current one, and keeps the IP route", async () => {
    const { svc } = make({
      serverRow: localHttp,
      env: { PANEL_IP_ROUTE: "1" },
      pending: JSON.stringify({ domain: "new.example.com" }),
    });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: "new.example.com", resolver: "le", ipRoute: true });
    const { svc: s2 } = make({ serverRow: localHttp, panelDomain: "old.example.com", pending: JSON.stringify({ domain: "new.example.com" }) });
    expect((await s2.resolveFor("s1")).panel).toEqual({ domain: "new.example.com", resolver: "le", also: ["old.example.com"] });
  });

  it("removing the domain in flight adds the IP route next to the current host", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "old.example.com", pending: JSON.stringify({ domain: null }) });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: "old.example.com", resolver: "le", ipRoute: true });
  });

  it("an unreadable pending value is ignored; a non-local server never gets a panel", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "old.example.com", pending: "{not json" });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: "old.example.com", resolver: "le" });
    const { svc: other } = make({ serverRow: { ...localHttp, isLocal: false }, env: { PANEL_IP_ROUTE: "1" } });
    expect((await other.resolveFor("s1")).panel).toBeUndefined();
  });
});

describe("ProxyConfigService.resolveFor — agent grace + IP certificate", () => {
  const IP_ENV = { PANEL_IP_ROUTE: "1" };
  const now = Date.now();
  const grace = (over: Record<string, unknown> = {}) => ({
    v: 1,
    startedAt: now - 1000,
    expiresAt: now + 3600_000,
    primary: { url: "wss://new.example.com/agent" },
    fallbacks: [{ url: "wss://old.example.com/agent" }, { url: "wss://203.0.113.7/agent", pin: "sha256:" + "ab".repeat(32) }],
    ...over,
  });
  const cert = { ipTlsCertPem: "CERT-PEM", ipTlsKeyEnc: "KEY-PEM" };

  it("IP mode with a persisted certificate: the host-less routes carry it (key decrypted); without one they stay http-only", async () => {
    const { svc } = make({ serverRow: localHttp, env: IP_ENV, acmeEmail: undefined, settingsRow: cert });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: null, resolver: "le", ipRoute: true, ipTls: { certPem: "CERT-PEM", keyPem: "KEY-PEM" } });
    const bare = make({ serverRow: localHttp, env: IP_ENV, acmeEmail: undefined });
    expect((await bare.svc.resolveFor("s1")).panel).toEqual({ domain: null, resolver: "le", ipRoute: true });
  });

  it("an unreadable key never fails a recreate: the certificate is simply left out", async () => {
    const { svc } = make({ serverRow: localHttp, env: IP_ENV, acmeEmail: undefined, settingsRow: cert, decrypt: () => { throw new Error("bad key"); } });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: null, resolver: "le", ipRoute: true });
  });

  it("after the panel moved to a domain, the old host AND the IP keep the AGENT path while the grace is active", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "new.example.com", settingsRow: { ...cert, agentEndpointGrace: grace() } });
    expect((await svc.resolveFor("s1")).panel).toEqual({
      domain: "new.example.com",
      resolver: "le",
      agentHosts: ["old.example.com"],
      agentIp: true,
      ipTls: { certPem: "CERT-PEM", keyPem: "KEY-PEM" },
    });
  });

  it("an expired or released grace renders nothing extra (the old routes are dropped)", async () => {
    for (const g of [grace({ expiresAt: now - 1 }), grace({ confirmedAt: now - 5 })]) {
      const { svc } = make({ serverRow: localHttp, panelDomain: "new.example.com", settingsRow: { ...cert, agentEndpointGrace: g } });
      expect((await svc.resolveFor("s1")).panel).toEqual({ domain: "new.example.com", resolver: "le" });
    }
  });

  it("a malformed grace column is ignored, never thrown", async () => {
    const { svc } = make({ serverRow: localHttp, panelDomain: "new.example.com", settingsRow: { agentEndpointGrace: { v: 9 } } });
    expect((await svc.resolveFor("s1")).panel).toEqual({ domain: "new.example.com", resolver: "le" });
  });

  it("going back to the IP: the old DOMAIN keeps the agent path; the IP route is the panel's own (no duplicate agent-ip route)", async () => {
    const g = grace({ primary: { url: "wss://203.0.113.7/agent", pin: "sha256:" + "ab".repeat(32) }, fallbacks: [{ url: "wss://old.example.com/agent" }] });
    const { svc } = make({ serverRow: localHttp, env: IP_ENV, acmeEmail: undefined, settingsRow: { ...cert, agentEndpointGrace: g } });
    expect((await svc.resolveFor("s1")).panel).toEqual({
      domain: null,
      resolver: "le",
      ipRoute: true,
      agentHosts: ["old.example.com"],
      ipTls: { certPem: "CERT-PEM", keyPem: "KEY-PEM" },
    });
  });

  it("a domain change in flight: the grace host that is already served as `also` is not rendered twice", async () => {
    const { svc } = make({
      serverRow: localHttp,
      panelDomain: "old.example.com",
      pending: JSON.stringify({ domain: "new.example.com" }),
      settingsRow: { agentEndpointGrace: grace({ pendingSwitch: true }) },
    });
    const panel = (await svc.resolveFor("s1")).panel!;
    expect(panel.domain).toBe("new.example.com");
    expect(panel.also).toEqual(["old.example.com"]);
    expect(panel.agentHosts).toBeUndefined();
  });

  it("only the LOCAL server gets any of it", async () => {
    const { svc } = make({ serverRow: { ...localHttp, isLocal: false }, env: IP_ENV, settingsRow: { ...cert, agentEndpointGrace: grace() } });
    expect((await svc.resolveFor("s1")).panel).toBeUndefined();
  });
});
