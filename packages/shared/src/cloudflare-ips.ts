/**
 * Cloudflare's published edge address ranges (the networks its orange-cloud proxy connects to an origin from).
 * Vendored PUBLIC DATA, not code: the hub trusts `CF-Connecting-IP` only when the hop that delivered the request is
 * inside one of these ranges (HUB_TRUSTED_PROXY_CLOUDFLARE). Refresh with `node scripts/refresh-cloudflare-ips.mjs`
 * (see docs/security.md); the script rewrites everything between the markers below and nothing else.
 */

// BEGIN GENERATED (scripts/refresh-cloudflare-ips.mjs)
export const CLOUDFLARE_IPS_SOURCE_V4 = "https://www.cloudflare.com/ips-v4";
export const CLOUDFLARE_IPS_SOURCE_V6 = "https://www.cloudflare.com/ips-v6";
export const CLOUDFLARE_IPS_FETCHED_AT = "2026-11-16";

export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];
// END GENERATED

/** Every vendored Cloudflare edge range (IPv4 + IPv6). */
export const CLOUDFLARE_IP_RANGES: readonly string[] = [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES];
