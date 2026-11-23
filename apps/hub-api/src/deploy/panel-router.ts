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
/** Where the IP-mode self-signed certificate lives: a sub-directory of the dynamic dir on the host (written by the proxy
 *  setup script, 0600 key) and the same files as Traefik sees them (`/dynamic` is the read-only mount). */
export const IP_TLS_HOST_DIR = `${PROXY_DYNAMIC_DIR}/iptls`;
export const IP_TLS_CERT_FILE = "/dynamic/iptls/cert.pem";
export const IP_TLS_KEY_FILE = "/dynamic/iptls/key.pem";
/** The agent path and the signed file-transfer relay the agents use: the only things kept routable on an address that is
 *  no longer the panel's (see `agentHosts` / `agentIp`). */
export const AGENT_PATHS = ["/agent", "/api/v1/agent-fs/t/"] as const;

// Traefik object names (router name == service name is allowed — separate namespaces).
const R_HUB = "tugra-panel-hub";
const R_WEB = "tugra-panel-web";
const R_REDIRECT = "tugra-panel-redirect";
const MW_HTTPS = "tugra-panel-https";
const SVC_HUB = "tugra-panel-hub";
const SVC_WEB = "tugra-panel-web";

export type PanelResolver = "le" | "le-dns";

/** The IP-mode self-signed certificate + key (PEM) the proxy serves as its default certificate on :443. */
export interface IpTlsMaterial {
  certPem: string;
  keyPem: string;
}

/** Everything the proxy needs to know about the panel (and the agent path), resolved by ProxyConfigService. */
export interface PanelProxyConfig {
  /** The host the panel is served on; null for a host-less http://<ip>/ panel. */
  domain: string | null;
  resolver?: PanelResolver;
  /** More hosts serving the WHOLE panel at the same time (the old host while a domain change is verified). */
  also?: string[];
  /** The host-less http route (plain install, or while a domain change is in flight). */
  ipRoute?: boolean;
  /** Old hosts that keep only the agent path (/agent + the transfer relay) while agents move to the new address. */
  agentHosts?: string[];
  /** The IP route keeps the agent path although the panel moved to a domain. */
  agentIp?: boolean;
  /** Serve the host-less routes on :443 with this self-signed certificate (IP mode). */
  ipTls?: IpTlsMaterial;
}

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

/**
 * The ACME contact email is OPTIONAL for the panel: Let's Encrypt only uses it for expiry notices, and asking a
 * first-time installer for one (or inventing one it would reject) is exactly the friction this avoids. Blank =>
 * undefined (the resolver is configured without an email); a value that IS given must still be a real one.
 */
export function optionalAcmeEmail(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string" && !input.trim()) return undefined;
  return validateAcmeEmail(input);
}

const PANEL_HUB_MATCHERS = [
  ...PANEL_HUB_PATHS.map((p) => `PathPrefix(\`${p}\`)`),
  ...PANEL_HUB_EXACT_PATHS.map((p) => `Path(\`${p}\`)`),
].join(" || ");

const AGENT_PATH_MATCHERS = AGENT_PATHS.map((p) => `PathPrefix(\`${p}\`)`).join(" || ");

function hubRule(domain: string): string {
  return `Host(\`${domain}\`) && (${PANEL_HUB_MATCHERS})`;
}

// Host-less "IP mode" routers (a plain install, no domain yet): the panel answers on http://<server-ip>/ with the SAME
// single-origin split as a domain install. Priorities are deliberately BELOW every other router: Traefik's default
// priority is the rule's length, so a deployed app's Host(...) router always beats these two and can never be
// shadowed by the panel catch-all (the hub paths sit one above the web catch-all, as in the domain routers).
const R_IP_HUB = "tugra-panel-ip-hub";
const R_IP_WEB = "tugra-panel-ip-web";
const R_IP_HUB_TLS = "tugra-panel-ip-hub-tls";
const R_IP_WEB_TLS = "tugra-panel-ip-web-tls";
const R_AGENT_IP = "tugra-panel-agent-ip";
const R_AGENT_IP_TLS = "tugra-panel-agent-ip-tls";
const R_AGENT_HOST = "tugra-panel-agent-host";
const IP_HUB_PRIORITY = 2;
const IP_WEB_PRIORITY = 1;

/**
 * Render the Traefik file-provider YAML for the panel.
 * - Normal (TLS at Traefik): hub-paths router (priority 200) + web catch-all (100), both on `websecure`
 *   with `tls.certResolver`, plus an http→https redirect router (300).
 * - httpOnly (proxyBind "none" / Cloudflare tunnel terminates TLS): both routers on `web`, no tls, no redirect.
 * - `also`: more panel hostnames served at the same time (the OLD host while a domain change is being verified, so
 *   the current URL keeps working); each gets its own routers (and so its own certificate).
 * - `ipRoute`: add the host-less http routers above (plain install, or while a domain change is in flight).
 * - `ipTls`: in IP mode ALSO answer the host-less routes on `websecure` with the hub's persisted self-signed certificate
 *   (Traefik's default certificate, files written next to this one), so agents reach the hub over wss on a bare IP.
 * - `agentHosts` / `agentIp`: the AGENT path only (`/agent` + the file-transfer relay) stays routable on these old hosts /
 *   on the IP while agents move to the panel's new address — the panel itself is not served there any more. Grace routing:
 *   it keeps every remote agent that is still dialling the old address connected until all have moved.
 * `domain` may be null for an IP-only panel. Every host is re-validated here, so nothing unvalidated reaches a rule
 * even if called directly.
 */
export function buildPanelRouterYaml(opts: Omit<PanelProxyConfig, "ipTls"> & { httpOnly?: boolean; ipTls?: boolean | IpTlsMaterial }): string {
  const domains: string[] = [];
  for (const d of [opts.domain, ...(opts.also ?? [])]) {
    if (d === null || d === undefined) continue;
    const v = validatePanelDomain(d);
    if (!domains.includes(v)) domains.push(v);
  }
  const ipRoute = opts.ipRoute === true;
  const agentHosts: string[] = [];
  for (const h of opts.agentHosts ?? []) {
    const v = validatePanelDomain(h);
    if (!agentHosts.includes(v) && !domains.includes(v)) agentHosts.push(v); // a host the panel is served on already has the agent path
  }
  const agentIp = opts.agentIp === true && !ipRoute; // the full IP route already includes the agent path
  if (domains.length === 0 && !ipRoute && agentHosts.length === 0 && !agentIp) throw new Error("panel router needs a domain or the IP route");
  const httpOnly = opts.httpOnly === true;
  const ipTls = !!opts.ipTls && !httpOnly;
  const resolver: PanelResolver = opts.resolver === "le-dns" ? "le-dns" : "le";
  const entryPoints = httpOnly ? ["web"] : ["websecure"];

  const routers: Record<string, unknown> = {};
  domains.forEach((domain, i) => {
    const sfx = i === 0 ? "" : `-${i + 1}`;
    routers[`${R_HUB}${sfx}`] = {
      rule: hubRule(domain),
      entryPoints,
      priority: 200,
      service: SVC_HUB,
      ...(httpOnly ? {} : { tls: { certResolver: resolver } }),
    };
    routers[`${R_WEB}${sfx}`] = {
      rule: `Host(\`${domain}\`)`,
      entryPoints,
      priority: 100,
      service: SVC_WEB,
      ...(httpOnly ? {} : { tls: { certResolver: resolver } }),
    };
    if (!httpOnly) {
      routers[`${R_REDIRECT}${sfx}`] = {
        rule: `Host(\`${domain}\`)`,
        entryPoints: ["web"],
        priority: 300,
        middlewares: [MW_HTTPS],
        service: "noop@internal",
      };
    }
  });
  if (ipRoute) {
    routers[R_IP_HUB] = { rule: `(${PANEL_HUB_MATCHERS})`, entryPoints: ["web"], priority: IP_HUB_PRIORITY, service: SVC_HUB };
    routers[R_IP_WEB] = { rule: "PathPrefix(`/`)", entryPoints: ["web"], priority: IP_WEB_PRIORITY, service: SVC_WEB };
    if (ipTls) {
      // Same routes on :443. No Host(): a bare IP has no SNI, so Traefik answers with its DEFAULT certificate (below).
      routers[R_IP_HUB_TLS] = { rule: `(${PANEL_HUB_MATCHERS})`, entryPoints: ["websecure"], priority: IP_HUB_PRIORITY, service: SVC_HUB, tls: {} };
      routers[R_IP_WEB_TLS] = { rule: "PathPrefix(`/`)", entryPoints: ["websecure"], priority: IP_WEB_PRIORITY, service: SVC_WEB, tls: {} };
    }
  }
  if (agentIp) {
    routers[R_AGENT_IP] = { rule: AGENT_PATH_MATCHERS, entryPoints: ["web"], priority: IP_HUB_PRIORITY, service: SVC_HUB };
    if (ipTls) routers[R_AGENT_IP_TLS] = { rule: AGENT_PATH_MATCHERS, entryPoints: ["websecure"], priority: IP_HUB_PRIORITY, service: SVC_HUB, tls: {} };
  }
  agentHosts.forEach((host, i) => {
    routers[`${R_AGENT_HOST}-${i + 1}`] = {
      rule: `Host(\`${host}\`) && (${AGENT_PATH_MATCHERS})`,
      entryPoints,
      priority: 200,
      service: SVC_HUB,
      ...(httpOnly ? {} : { tls: { certResolver: resolver } }),
    };
  });

  const http: Record<string, unknown> = {
    routers,
    services: {
      [SVC_HUB]: { loadBalancer: { passHostHeader: true, servers: [{ url: `http://${PANEL_HUB_ALIAS}:3000` }] } },
      [SVC_WEB]: { loadBalancer: { passHostHeader: true, servers: [{ url: `http://${PANEL_WEB_ALIAS}:3001` }] } },
    },
  };
  if (domains.length > 0 && !httpOnly) {
    http.middlewares = { [MW_HTTPS]: { redirectScheme: { scheme: "https", permanent: true } } };
  }

  const doc: Record<string, unknown> = { http };
  if (ipTls && (ipRoute || agentIp)) {
    // The persisted self-signed certificate is the default for every TLS router without its own (the host-less ones):
    // stable across restarts, unlike Traefik's regenerating built-in default, so its fingerprint can be pinned.
    doc.tls = { stores: { default: { defaultCertificate: { certFile: IP_TLS_CERT_FILE, keyFile: IP_TLS_KEY_FILE } } } };
  }
  return yamlStringify(doc);
}
