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

  it("DNS-01 (ACME_DNS_*) => le-dns resolver + token in a 0600 env-file, never in argv; panel uses le-dns", () => {
    const s = renderProxySetupFromEnv({
      PANEL_DOMAIN: "panel.acme.com",
      ACME_EMAIL: "ops@tugra.io",
      ACME_DNS_PROVIDER: "cloudflare",
      ACME_DNS_TOKEN: "s3cr3t-cf-token",
    } as NodeJS.ProcessEnv);
    expect(s).toContain("--certificatesresolvers.le-dns.acme.dnschallenge.provider='cloudflare'");
    expect(s).toContain("--env-file /etc/tugra/proxy/dns.env");
    expect(s).not.toContain("s3cr3t-cf-token"); // token only inside the base64 env-file blob, never bare in argv
    expect(s).not.toContain("-e CF_DNS_API_TOKEN");
    // the panel router references le-dns (which the script now defines)
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/proxy-dynamic\/\.panel\.yml\.tmp/);
    expect(Buffer.from(m![1], "base64").toString()).toContain("certResolver: le-dns");
  });

  it("without ACME_DNS_* the panel stays on the HTTP-01 resolver le", () => {
    const s = renderProxySetupFromEnv({ PANEL_DOMAIN: "panel.acme.com", ACME_EMAIL: "ops@tugra.io" } as NodeJS.ProcessEnv);
    expect(s).not.toContain("le-dns");
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
