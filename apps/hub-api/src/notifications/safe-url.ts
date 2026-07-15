/**
 * SSRF guard + rebind-safe transport for outbound notifications. A channel target URL/host is
 * validated at create/update (assertSafeUrl/assertSafeHost) AND again at send-time (safeSend), where
 * the host is resolved and the socket is dialed at the VALIDATED IP — so a DNS record that flips to an
 * internal/metadata address between validation and connect (rebind) cannot redirect the request. No
 * Nest imports: pure + unit-testable like webhook-verify.ts.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isSsrfSafeIp } from "../common/observed-ip";

export interface SsrfOpts {
  allowPrivate: boolean;
}

/** Thrown when a target URL/host is rejected by the SSRF guard. The service maps this to a 400. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const BLOCKED_NAMES = new Set(["localhost"]);
const BLOCKED_SUFFIXES = [".internal", ".localhost", ".local"];

/** Strip IPv6 brackets + a trailing dot and lowercase, so a host compares/resolves canonically. */
export function normHost(rawHost: string): string {
  const h = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  // Canonicalize an IPv6 literal via the WHATWG parser (compresses + folds IPv4-mapped forms) so an
  // expanded/alternate notation of a loopback/metadata/mapped address (e.g. 0:0:0:0:0:ffff:7f00:1)
  // cannot slip past the string-based classifier on the raw-host path (SMTP), where no URL parse ran.
  if (h.includes(":") && isIP(h) === 6) {
    try {
      return new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return h;
    }
  }
  return h;
}

/** Egress-target policy flag from the environment (providers are DI-less static singletons). */
export function allowPrivateTargets(): boolean {
  return process.env.NOTIFY_ALLOW_PRIVATE_TARGETS === "true";
}

/**
 * Resolve a host (or accept an IP literal) to a single SSRF-safe address. Every send re-resolves, so a
 * DNS record that flipped to a private/metadata IP after create-time validation is caught here (rebind
 * defense). Rejects if ANY resolved record is unsafe; fails closed on a resolve error.
 */
export async function resolveSafeAddress(rawHost: string, opts: SsrfOpts): Promise<string> {
  const host = normHost(rawHost);
  if (!host) throw new SsrfError("empty host");
  if (isIP(host) !== 0) {
    if (!isSsrfSafeIp(host, opts.allowPrivate)) throw new SsrfError(`blocked address: ${host}`);
    return host;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new SsrfError(`could not resolve host: ${host}`);
  }
  if (!addrs.length) throw new SsrfError(`no address for host: ${host}`);
  for (const a of addrs) {
    if (!isSsrfSafeIp(a.address, opts.allowPrivate)) throw new SsrfError("host resolves to a blocked address");
  }
  return addrs[0].address;
}

/** Validate a bare hostname (e.g. SMTP host) or IP against the SSRF policy (name blocklist + DNS). */
export async function assertSafeHost(rawHost: string, opts: SsrfOpts): Promise<void> {
  const host = normHost(rawHost);
  if (!host) throw new SsrfError("empty host");
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SsrfError(`blocked host: ${host}`);
  }
  await resolveSafeAddress(host, opts);
}

/** Validate a full URL (scheme + host) against the SSRF policy. Used at channel create/update. */
export async function assertSafeUrl(rawUrl: string, opts: SsrfOpts): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`unsupported url scheme: ${url.protocol}`);
  }
  // url.hostname strips userinfo (expected.com@169.254.169.254 → 169.254.169.254) and normalizes
  // decimal/hex/octal IPv4 shorthand (http://2130706433/) to a dotted quad the IP check will catch.
  await assertSafeHost(url.hostname, opts);
}

/**
 * SSRF-safe POST: resolve+validate the host, then dial the validated IP directly (pin) so a DNS rebind
 * between validation and connect cannot redirect the socket to an internal address; TLS SNI/cert are
 * still checked against the hostname. Redirects are NOT followed (a redirect to an internal host is a
 * classic SSRF bypass). 10s timeout; socket drained so a slow peer cannot stall the dispatch loop.
 */
export async function safeSend(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: SsrfOpts,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`unsupported url scheme: ${url.protocol}`);
  }
  const isHttps = url.protocol === "https:";
  const hostname = normHost(url.hostname);
  const addr = await resolveSafeAddress(hostname, opts);
  const mod = isHttps ? https : http;
  await new Promise<void>((resolve, reject) => {
    const req = mod.request(
      {
        host: addr, // dial the validated IP — the pin (no second DNS resolution)
        servername: isHttps && isIP(hostname) === 0 ? hostname : undefined, // TLS SNI + cert vs the name
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host }, // preserve vhost routing to the original name
        timeout: 10_000,
      },
      (res) => {
        res.resume(); // drain to free the socket
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`webhook: HTTP ${status}`)); // 3xx included → deliberately not followed
      },
    );
    req.on("timeout", () => req.destroy(new Error("webhook: timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
