import { ProxyConfigService } from "./proxy-config.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";

type Opts = {
  env?: Record<string, string | undefined>;
  serverRow?: Record<string, unknown> | null;
  acmeEmail?: string;
  panelDomain?: string | null; // what settings.panelDomainFor returns
  dbPanelDomain?: string | null; // what settings.get().panelDomain returns (bootstrap)
  decrypt?: (s: string) => string;
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
    get: jest.fn().mockResolvedValue({ panelDomain: o.dbPanelDomain ?? null }),
    update,
  } as unknown as InstanceSettingsService;
  return { svc: new ProxyConfigService(config, prisma, crypto, settings), update };
}

const localHttp = { isLocal: true, certMode: "http", dnsProvider: null, dnsCredsEnc: null, proxyBind: "public" };

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
    return new InstanceSettingsService(prisma);
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
