import { stringify as yamlStringify } from "yaml";

// Panel-TLS (DİLİM 1): the control panel's own HTTPS, served by the existing per-server Traefik
// (tugra-proxy) through a FILE provider — the same pattern Coolify/Dokploy use for their dashboards.
// This module is PURE (no Docker, no DB, no network): it validates operator input and renders the
// Traefik dynamic-config YAML that buildProxySetupScript writes atomically into PROXY_DYNAMIC_DIR.

/** Hub-owned path prefixes (single-origin split) — MUST mirror docs/install.md's routing table. */
export const PANEL_HUB_PATHS = [
  "/agent",
  "/terminal",
  "/install",
  "/webhooks",
  "/auth/oauth",
  "/auth/oidc",
] as const;
/** Hub-owned exact paths (bare hub routes, not under a prefix). */
export const PANEL_HUB_EXACT_PATHS = ["/health", "/version"] as const;

/** Dedicated Docker network for the panel: Traefik + hub + web ONLY (never the untrusted app network). */
export const PANEL_NETWORK = "tugra-panel";
export const PANEL_HUB_ALIAS = "tugra-panel-hub";
export const PANEL_WEB_ALIAS = "tugra-panel-web";

/** Host dir mounted read-only into Traefik as /dynamic; holds the file-provider configs. */
export const PROXY_DYNAMIC_DIR = "/etc/tugra/proxy-dynamic";
export const PANEL_FILE = "panel.yml";

// Traefik object names (router name == service name is allowed — separate namespaces).
const R_HUB = "tugra-panel-hub";
const R_WEB = "tugra-panel-web";
const R_REDIRECT = "tugra-panel-redirect";
const MW_HTTPS = "tugra-panel-https";
const SVC_HUB = "tugra-panel-hub";
const SVC_WEB = "tugra-panel-web";

export type PanelResolver = "le" | "le-dns";

// Traefik's lego DNS-01 providers read their token from a provider-specific env var. Map the ones we offer
// at install time so a user who pastes a Cloudflare token gets a REAL cert WHILE the record stays proxied
// (IP hidden) — the HTTP-01 default can't validate through the proxy.
const DNS_PROVIDER_ENV_KEY: Record<string, string> = { cloudflare: "CF_DNS_API_TOKEN" };

/** Build the Traefik DNS-01 provider creds ({<ENV_KEY>: token}) for a supported provider, or throw. */
export function dnsProviderEnvCreds(provider: string, token: string): Record<string, string> {
  const key = DNS_PROVIDER_ENV_KEY[(provider ?? "").trim().toLowerCase()];
  if (!key) {
    throw new Error(
      `unsupported DNS-01 provider: ${JSON.stringify(provider)} (supported: ${Object.keys(DNS_PROVIDER_ENV_KEY).join(", ")})`,
    );
  }
  if (!token || !token.trim()) throw new Error("a DNS-01 provider token is required");
  return { [key]: token.trim() };
}

// A single DNS label is 1-63 chars; the whole name ≤253. No wildcard, scheme, path, port, IP literal,
// whitespace, backtick or quote can match — so the validated value is safe to embed in a Traefik rule.
const PANEL_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Validate + normalize (lowercase) a panel domain. Throws on anything unsafe/invalid. */
export function validatePanelDomain(input: unknown): string {
  if (typeof input !== "string") throw new Error("panel domain is required");
  const d = input.trim().toLowerCase();
  if (!d) throw new Error("panel domain is required");
  if (!PANEL_DOMAIN_RE.test(d)) {
    throw new Error(`invalid panel domain: ${JSON.stringify(input)} (expected a bare hostname like app.example.com)`);
  }
  return d;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLACEHOLDER_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net", "localhost"]);

/** Validate an ACME contact email. Rejects empty/malformed + placeholder domains Let's Encrypt won't accept. */
export function validateAcmeEmail(input: unknown): string {
  if (typeof input !== "string") throw new Error("a real ACME email is required");
  const e = input.trim();
  if (!e || !EMAIL_RE.test(e)) throw new Error("a valid ACME email is required");
  const domain = e.slice(e.lastIndexOf("@") + 1).toLowerCase();
  if (
    PLACEHOLDER_EMAIL_DOMAINS.has(domain) ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".example")
  ) {
    throw new Error("a real ACME email is required (not example/test/localhost)");
  }
  return e;
}

function hubRule(domain: string): string {
  const prefixes = PANEL_HUB_PATHS.map((p) => `PathPrefix(\`${p}\`)`);
  const exact = PANEL_HUB_EXACT_PATHS.map((p) => `Path(\`${p}\`)`);
  return `Host(\`${domain}\`) && (${[...prefixes, ...exact].join(" || ")})`;
}

/**
 * Render the Traefik file-provider YAML for the panel on `domain`.
 * - Normal (TLS at Traefik): hub-paths router (priority 200) + web catch-all (100), both on `websecure`
 *   with `tls.certResolver`, plus an http→https redirect router (300).
 * - httpOnly (proxyBind "none" / Cloudflare tunnel terminates TLS): both routers on `web`, no tls, no redirect.
 * The domain is re-validated here, so nothing unvalidated reaches the rule even if called directly.
 */
export function buildPanelRouterYaml(opts: { domain: string; resolver?: PanelResolver; httpOnly?: boolean }): string {
  const domain = validatePanelDomain(opts.domain);
  const httpOnly = opts.httpOnly === true;
  const resolver: PanelResolver = opts.resolver === "le-dns" ? "le-dns" : "le";
  const entryPoints = httpOnly ? ["web"] : ["websecure"];

  const routers: Record<string, unknown> = {
    [R_HUB]: {
      rule: hubRule(domain),
      entryPoints,
      priority: 200,
      service: SVC_HUB,
      ...(httpOnly ? {} : { tls: { certResolver: resolver } }),
    },
    [R_WEB]: {
      rule: `Host(\`${domain}\`)`,
      entryPoints,
      priority: 100,
      service: SVC_WEB,
      ...(httpOnly ? {} : { tls: { certResolver: resolver } }),
    },
  };

  const http: Record<string, unknown> = {
    routers,
    services: {
      [SVC_HUB]: { loadBalancer: { passHostHeader: true, servers: [{ url: `http://${PANEL_HUB_ALIAS}:3000` }] } },
      [SVC_WEB]: { loadBalancer: { passHostHeader: true, servers: [{ url: `http://${PANEL_WEB_ALIAS}:3001` }] } },
    },
  };

  if (!httpOnly) {
    routers[R_REDIRECT] = {
      rule: `Host(\`${domain}\`)`,
      entryPoints: ["web"],
      priority: 300,
      middlewares: [MW_HTTPS],
      service: "noop@internal",
    };
    http.middlewares = { [MW_HTTPS]: { redirectScheme: { scheme: "https", permanent: true } } };
  }

  return yamlStringify({ http });
}
