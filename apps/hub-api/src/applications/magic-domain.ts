import { randomBytes } from "node:crypto";
import { isIpv6, isPublicIp, normalizeIp } from "../common/observed-ip";

/**
 * Turn a display name into a safe DNS label: lowercase, only [a-z0-9-], no
 * runs of or edge hyphens, capped so the final `{slug}-{hash}` stays a valid
 * DNS label (≤63 chars). Empty input yields "" (callers fall back to "app").
 */
export function slugify(name: string, max = 40): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, ""); // a trailing hyphen can reappear after the length cut
}

/** Encode an IP as a DNS-safe label component: dots (v4) or colons (v6) → dashes. */
export function dashedIp(ip: string): string {
  return isIpv6(ip) ? ip.replace(/:/g, "-") : ip.replace(/\./g, "-");
}

/**
 * Build a sslip.io-style magic domain that DNS-resolves to the server's own IP,
 * giving a domainless app an instantly reachable hostname (Coolify/Dokploy parity).
 *
 * - `wildcardDomain` set (per-server) → `{slug}-{hash}.{wildcardDomain}`.
 * - else a PUBLIC IP (v4 preferred, else v6) → `{slug}-{hash}.{ipDashed}.{suffix}`.
 * - no public IP (loopback/RFC1918/CGNAT/link-local) → null. A magic domain that
 *   resolved to a private/loopback address would be unreachable AND could point the
 *   hub's own uptime/SSL probes at internal hosts (SSRF), so we refuse to build one.
 *
 * `hash` is injectable for deterministic tests; otherwise 3 random bytes (6 hex
 * chars) — enough entropy that collisions are negligible.
 */
export function magicDomain(opts: {
  name: string;
  publicIp?: string | null;
  publicIpv6?: string | null;
  wildcardDomain?: string | null;
  suffix?: string | null;
  hash?: string | null;
}): string | null {
  const slug = slugify(opts.name) || "app";
  const hash = opts.hash || randomBytes(3).toString("hex");
  const label = `${slug}-${hash}`.slice(0, 63);
  if (opts.wildcardDomain) return `${label}.${opts.wildcardDomain}`;
  const ip =
    opts.publicIp && isPublicIp(opts.publicIp)
      ? opts.publicIp
      : opts.publicIpv6 && isPublicIp(opts.publicIpv6)
        ? opts.publicIpv6
        : null;
  if (!ip) return null;
  // normalizeIp: an IPv4-mapped address becomes a clean dotted quad before dashing.
  return `${label}.${dashedIp(normalizeIp(ip))}.${opts.suffix || "sslip.io"}`;
}
