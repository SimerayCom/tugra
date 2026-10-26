import { parse as yamlParse } from "yaml";
import {
  buildPanelRouterYaml,
  validatePanelDomain,
  validateAcmeEmail,
  PANEL_HUB_PATHS,
  PANEL_HUB_EXACT_PATHS,
  PANEL_HUB_ALIAS,
  PANEL_WEB_ALIAS,
} from "./panel-router";

describe("panel-router", () => {
  describe("buildPanelRouterYaml (TLS)", () => {
    const doc = () => yamlParse(buildPanelRouterYaml({ domain: "app.example.com", resolver: "le" }));

    it("hub router: all hub prefixes + exact health/version paths, priority 200, websecure, hub service", () => {
      const r = doc().http.routers["tugra-panel-hub"];
      for (const p of PANEL_HUB_PATHS) expect(r.rule).toContain(`PathPrefix(\`${p}\`)`);
      for (const p of PANEL_HUB_EXACT_PATHS) expect(r.rule).toContain(`Path(\`${p}\`)`);
      expect(r.rule).toContain("Host(`app.example.com`)");
      expect(r.priority).toBe(200);
      expect(r.entryPoints).toEqual(["websecure"]);
      expect(r.service).toBe("tugra-panel-hub");
    });

    it("web catch-all: Host-only, priority 100 (below hub), websecure, web service", () => {
      const routers = doc().http.routers;
      expect(routers["tugra-panel-web"].rule).toBe("Host(`app.example.com`)");
      expect(routers["tugra-panel-web"].priority).toBe(100);
      expect(routers["tugra-panel-web"].priority).toBeLessThan(routers["tugra-panel-hub"].priority);
      expect(routers["tugra-panel-web"].entryPoints).toEqual(["websecure"]);
      expect(routers["tugra-panel-web"].service).toBe("tugra-panel-web");
    });

    it("services point at the unique panel-network aliases on 3000/3001 with passHostHeader", () => {
      const svc = doc().http.services;
      expect(svc["tugra-panel-hub"].loadBalancer.servers[0].url).toBe(`http://${PANEL_HUB_ALIAS}:3000`);
      expect(svc["tugra-panel-web"].loadBalancer.servers[0].url).toBe(`http://${PANEL_WEB_ALIAS}:3001`);
      expect(svc["tugra-panel-hub"].loadBalancer.passHostHeader).toBe(true);
    });

    it("resolver le vs le-dns sets tls.certResolver on both TLS routers", () => {
      const le = yamlParse(buildPanelRouterYaml({ domain: "app.example.com", resolver: "le" })).http.routers;
      expect(le["tugra-panel-hub"].tls.certResolver).toBe("le");
      expect(le["tugra-panel-web"].tls.certResolver).toBe("le");
      const dns = yamlParse(buildPanelRouterYaml({ domain: "app.example.com", resolver: "le-dns" })).http.routers;
      expect(dns["tugra-panel-hub"].tls.certResolver).toBe("le-dns");
      expect(dns["tugra-panel-web"].tls.certResolver).toBe("le-dns");
    });

    it("http->https redirect router on entryPoint web only, permanent redirectScheme", () => {
      const d = doc();
      const redirect = d.http.routers["tugra-panel-redirect"];
      expect(redirect.entryPoints).toEqual(["web"]);
      expect(redirect.rule).toBe("Host(`app.example.com`)");
      expect(redirect.middlewares).toEqual(["tugra-panel-https"]);
      expect(d.http.middlewares["tugra-panel-https"].redirectScheme).toEqual({ scheme: "https", permanent: true });
    });

    it("YAML round-trips (valid structure/indentation)", () => {
      const d = doc();
      expect(d.http.routers).toBeDefined();
      expect(d.http.services).toBeDefined();
      expect(Object.keys(d.http.routers)).toEqual(
        expect.arrayContaining(["tugra-panel-hub", "tugra-panel-web", "tugra-panel-redirect"]),
      );
    });
  });

  describe("buildPanelRouterYaml (httpOnly / Cloudflare tunnel)", () => {
    const doc = () => yamlParse(buildPanelRouterYaml({ domain: "app.example.com", httpOnly: true }));

    it("routers on entryPoint web, no tls block, no redirect router, no middlewares", () => {
      const d = doc();
      expect(d.http.routers["tugra-panel-hub"].entryPoints).toEqual(["web"]);
      expect(d.http.routers["tugra-panel-hub"].tls).toBeUndefined();
      expect(d.http.routers["tugra-panel-web"].tls).toBeUndefined();
      expect(d.http.routers["tugra-panel-redirect"]).toBeUndefined();
      expect(d.http.middlewares).toBeUndefined();
    });
  });

  describe("validatePanelDomain", () => {
    it("accepts a normal domain and normalizes uppercase", () => {
      expect(validatePanelDomain("App.Example.COM")).toBe("app.example.com");
      expect(validatePanelDomain("  hub.my-co.io ")).toBe("hub.my-co.io");
    });

    it.each([
      ["wildcard", "*.example.com"],
      ["scheme", "https://app.example.com"],
      ["path", "app.example.com/panel"],
      ["port", "app.example.com:443"],
      ["ipv4", "37.27.205.247"],
      ["whitespace", "app .example.com"],
      ["backtick", "a`)||Host(`evil.com"],
      ["quote", 'app".example.com'],
      ["empty", ""],
      ["single-label", "localhost"],
      ["too-long", "a".repeat(250) + ".example.com"],
    ])("rejects %s", (_label, bad) => {
      expect(() => validatePanelDomain(bad)).toThrow();
    });

    it("a hostile injection string never yields a rule — it throws", () => {
      for (const bad of ["a`) || Host(`evil", "a.com\nhttp:", "a.com;rm -rf /"]) {
        expect(() => validatePanelDomain(bad)).toThrow();
        expect(() => buildPanelRouterYaml({ domain: bad, resolver: "le" })).toThrow();
      }
    });
  });

  describe("validateAcmeEmail", () => {
    it("accepts a real address", () => {
      expect(validateAcmeEmail("ops@tugra.io")).toBe("ops@tugra.io");
      expect(validateAcmeEmail("  admin@my-co.com ")).toBe("admin@my-co.com");
    });

    it.each(["", "not-an-email", "x@localhost", "admin@example.com", "a@example.org", "a@example.net", "a@foo.test", "a@foo.invalid"])(
      "rejects %s",
      (bad) => {
        expect(() => validateAcmeEmail(bad)).toThrow();
      },
    );
  });

  it("PANEL_HUB_PATHS matches the single-origin routing table in docs/install.md", () => {
    // Pinned here so a drift between code and docs is caught (docs-links spec cross-checks the doc side).
    expect([...PANEL_HUB_PATHS]).toEqual(["/agent", "/terminal", "/install", "/webhooks", "/auth/oauth", "/auth/oidc"]);
    expect([...PANEL_HUB_EXACT_PATHS]).toEqual(["/health", "/version"]);
  });
});
