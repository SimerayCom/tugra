/**
 * Tiny CLI: prints the Traefik proxy-setup script (with the panel router) to stdout so install.sh can pipe
 * it to `sh`. No Nest, no DB, no network. This keeps ALL Traefik flags single-sourced in buildProxySetupScript
 * (TypeScript) — install.sh never duplicates them in bash. Invalid input => message on stderr + exit 2 with
 * EMPTY stdout, so a `| sh` of an empty stream runs nothing.
 *
 * Compiled to dist/deploy/print-proxy-setup.js; invoked as:
 *   node dist/deploy/print-proxy-setup.js   (env: PANEL_DOMAIN, ACME_EMAIL, PANEL_CERT_RESOLVER?, PROXY_BIND?)
 */
import { buildProxySetupScript } from "./deploy-script";
import { validatePanelDomain, validateAcmeEmail, dnsProviderEnvCreds, type PanelResolver } from "./panel-router";

/** Pure: render the script from an env-like record, or throw on invalid input. Testable without a subprocess. */
export function renderProxySetupFromEnv(env: NodeJS.ProcessEnv): string {
  const domain = (env.PANEL_DOMAIN ?? "").trim();
  if (!domain) throw new Error("PANEL_DOMAIN is required");
  validatePanelDomain(domain); // fail fast with a clear message before building
  validateAcmeEmail(env.ACME_EMAIL ?? ""); // panel path requires a real email (also enforced in the builder)

  // DNS-01 (optional): when a provider + token are set, use the le-dns resolver (real cert while proxied,
  // IP hidden). The resolver is derived from whether we actually have creds — never le-dns without them,
  // so the panel router can't reference a resolver the script didn't define.
  const dnsProvider = (env.ACME_DNS_PROVIDER ?? "").trim() || undefined;
  const dnsToken = (env.ACME_DNS_TOKEN ?? "").trim() || undefined;
  const dnsCreds = dnsProvider && dnsToken ? dnsProviderEnvCreds(dnsProvider, dnsToken) : undefined;
  const resolver: PanelResolver = dnsCreds ? "le-dns" : "le";

  return buildProxySetupScript({
    acmeEmail: env.ACME_EMAIL ?? null,
    bind: env.PROXY_BIND ?? null,
    dnsProvider: dnsCreds ? dnsProvider : undefined,
    dnsCreds,
    panel: { domain, resolver },
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
