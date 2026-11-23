/**
 * Tiny CLI: prints the Traefik proxy-setup script (with the panel router) to stdout so install.sh can pipe
 * it to `sh`. No Nest, no DB, no network. This keeps ALL Traefik flags single-sourced in buildProxySetupScript
 * (TypeScript) — install.sh never duplicates them in bash. Invalid input => message on stderr + exit 2 with
 * EMPTY stdout, so a `| sh` of an empty stream runs nothing.
 *
 * Compiled to dist/deploy/print-proxy-setup.js; invoked as:
 *   node dist/deploy/print-proxy-setup.js   (env: PANEL_DOMAIN?, PANEL_IP_ROUTE?, ACME_EMAIL?, PROXY_BIND?; a domain, the
 *   IP route or both). PANEL_IP_ROUTE=1 serves the panel host-less on http://<ip>/ (a plain install).
 */
import { buildProxySetupScript } from "./deploy-script";
import { validatePanelDomain, optionalAcmeEmail, dnsProviderEnvCreds, type PanelResolver } from "./panel-router";

/** Pure: render the script from an env-like record, or throw on invalid input. Testable without a subprocess. */
export function renderProxySetupFromEnv(env: NodeJS.ProcessEnv): string {
  const rawDomain = (env.PANEL_DOMAIN ?? "").trim();
  const ipRoute = (env.PANEL_IP_ROUTE ?? "").trim() === "1";
  if (!rawDomain && !ipRoute) throw new Error("PANEL_DOMAIN (or PANEL_IP_ROUTE=1) is required");
  const domain = rawDomain ? validatePanelDomain(rawDomain) : null; // fail fast with a clear message before building
  const acmeEmail = optionalAcmeEmail(env.ACME_EMAIL ?? ""); // optional, but a given one must be real (also enforced in the builder)

  // DNS-01 (optional): when a provider + token are set, use the le-dns resolver (real cert while proxied,
  // IP hidden). The resolver is derived from whether we actually have creds — never le-dns without them,
  // so the panel router can't reference a resolver the script didn't define.
  const dnsProvider = (env.ACME_DNS_PROVIDER ?? "").trim() || undefined;
  const dnsToken = (env.ACME_DNS_TOKEN ?? "").trim() || undefined;
  const dnsCreds = dnsProvider && dnsToken ? dnsProviderEnvCreds(dnsProvider, dnsToken) : undefined;
  const resolver: PanelResolver = dnsCreds ? "le-dns" : "le";

  return buildProxySetupScript({
    acmeEmail: acmeEmail ?? null,
    bind: env.PROXY_BIND ?? null,
    dnsProvider: dnsCreds ? dnsProvider : undefined,
    dnsCreds,
    panel: { domain, resolver, ...(ipRoute ? { ipRoute: true } : {}) },
    // install.sh pipes this to `sh` as an explicit operator setup/apply — always (re)create the proxy, the same
    // force semantics as ProxyService (panel-TLS apply) and ProxyOpsService (Start/Restart). Omitting it would
    // let the reconcile gate skip an "up to date" proxy, silently changing the installer's always-apply behaviour.
    force: true,
  });
}

function main(): void {
  try {
    process.stdout.write(renderProxySetupFromEnv(process.env) + "\n");
  } catch (e) {
    process.stderr.write(`print-proxy-setup: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

// Only run as a script, never when imported by a spec.
if (require.main === module) main();
