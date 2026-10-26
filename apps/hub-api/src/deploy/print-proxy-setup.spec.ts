import { renderProxySetupFromEnv } from "./print-proxy-setup";
import { buildProxySetupScript } from "./deploy-script";

describe("print-proxy-setup CLI", () => {
  it("output equals the in-process builder for the same env (single source of truth)", () => {
    const env = { PANEL_DOMAIN: "app.example.com", ACME_EMAIL: "ops@tugra.io" } as NodeJS.ProcessEnv;
    expect(renderProxySetupFromEnv(env)).toBe(
      buildProxySetupScript({ acmeEmail: "ops@tugra.io", bind: null, panel: { domain: "app.example.com", resolver: "le" } }),
    );
  });

  it("honors PANEL_CERT_RESOLVER=le-dns and PROXY_BIND", () => {
    const s = renderProxySetupFromEnv({
      PANEL_DOMAIN: "app.example.com",
      ACME_EMAIL: "ops@tugra.io",
      PANEL_CERT_RESOLVER: "le-dns",
      PROXY_BIND: "loopback",
    } as NodeJS.ProcessEnv);
    expect(s).toContain("-p 127.0.0.1:80:80");
    expect(s).toContain("panel.yml");
  });

  it("throws (=> CLI exit 2, empty stdout) on missing domain, invalid domain, or placeholder/missing email", () => {
    expect(() => renderProxySetupFromEnv({ ACME_EMAIL: "ops@tugra.io" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => renderProxySetupFromEnv({ PANEL_DOMAIN: "*.x.com", ACME_EMAIL: "ops@tugra.io" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => renderProxySetupFromEnv({ PANEL_DOMAIN: "app.example.com" } as NodeJS.ProcessEnv)).toThrow();
    expect(() =>
      renderProxySetupFromEnv({ PANEL_DOMAIN: "app.example.com", ACME_EMAIL: "admin@example.com" } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
