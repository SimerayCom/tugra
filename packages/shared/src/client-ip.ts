import { isIP } from "node:net";
import { CLOUDFLARE_IP_RANGES } from "./cloudflare-ips";

/**
 * Client-IP trust logic shared by the hub (which interprets the forwarding chain) and the web server (which must
 * not forward a chain it cannot vouch for). Pure: nothing here reads process.env — callers pass a policy.
 *
 * Trust model, fail closed everywhere:
 *  - Off by default: the raw TCP peer is the client and cannot be forged.
 *  - With a trusted proxy declared, X-Forwarded-For is read (rightmost entry only) ONLY when the TCP peer itself is
 *    a trusted proxy peer (non-public address, or listed in the trusted CIDRs; strict mode = listed only).
 *  - Cloudflare mode additionally trusts CF-Connecting-IP ONLY when the address the trusted proxy observed (the
 *    rightmost X-Forwarded-For entry) is a published Cloudflare edge range.
 */

interface Addr {
  version: 4 | 6;
  bits: bigint;
}

/** A normalized IP address is IPv6 when it contains a colon. */
export function isIpv6(ip: string): boolean {
  return ip.includes(":");
}

/** Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 -> 1.2.3.4) so a mapped address is judged as its IPv4. */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/** A loopback address is never externally reachable. */
export function isLoopbackIp(ip: string): boolean {
  return ip.startsWith("127.") || ip === "::1" || ip.toLowerCase() === "0:0:0:0:0:0:0:1";
}

/** RFC 1918 private IPv4 ranges. */
export function isPrivateV4(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** RFC 6598 carrier-grade NAT (100.64.0.0/10). */
export function isCgnatV4(ip: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}

/**
 * Is this a globally-routable public address? Excludes loopback, unspecified, RFC1918, CGNAT and link-local for IPv4;
 * loopback, unspecified, link-local (fe80::/10) and ULA (fc00::/7) for IPv6. IPv4-mapped IPv6 is judged as its IPv4.
 * A string that is not a well-formed IP literal is never public.
 */
export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  const v = normalizeIp(ip);
  if (isIP(v) === 0) return false;
  if (isLoopbackIp(v)) return false;
  if (isIpv6(v)) {
    if (v === "::") return false;
    return !/^fe[89ab][0-9a-f]:/i.test(v) && !/^f[cd][0-9a-f]{2}:/i.test(v);
  }
  if (v === "0.0.0.0") return false;
  if (/^169\.254\./.test(v)) return false;
  return !isPrivateV4(v) && !isCgnatV4(v);
}

function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let bits = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bits = (bits << 8n) | BigInt(n);
  }
  return bits;
}

/** Rewrite a trailing embedded IPv4 (e.g. 64:ff9b::1.2.3.4) into two hex groups so the rest is pure hex. */
function foldEmbeddedV4(ip: string): string | null {
  const dot = ip.indexOf(".");
  if (dot === -1) return ip;
  const cut = ip.lastIndexOf(":", dot);
  if (cut === -1) return null;
  const v4 = ipv4ToBig(ip.slice(cut + 1));
  if (v4 === null) return null;
  const h1 = (v4 >> 16n).toString(16);
  const h2 = (v4 & 0xffffn).toString(16);
  return `${ip.slice(0, cut + 1)}${h1}:${h2}`;
}

function ipv6ToBig(ip0: string): bigint | null {
  const ip = foldEmbeddedV4(ip0);
  if (ip === null) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null; // no "::" -> must be full 8
  const groups = [...head, ...Array<string>(Math.max(missing, 0)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let bits = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    bits = (bits << 16n) | BigInt(parseInt(g, 16));
  }
  return bits;
}

/** Parse an IP literal into a family-tagged BigInt, or null if it isn't a valid IP. */
export function ipToBig(ip: string): Addr | null {
  const norm = normalizeIp(ip.trim());
  const v = isIP(norm);
  if (v === 4) {
    const bits = ipv4ToBig(norm);
    return bits === null ? null : { version: 4, bits };
  }
  if (v === 6) {
    const bits = ipv6ToBig(norm);
    return bits === null ? null : { version: 6, bits };
  }
  return null;
}

/** Is `entry` a valid single IP or `addr/prefix` CIDR? */
export function isValidIpOrCidr(entry: string): boolean {
  const s = entry.trim();
  if (!s) return false;
  const slash = s.indexOf("/");
  if (slash === -1) return isIP(normalizeIp(s)) !== 0;
  const v = isIP(normalizeIp(s.slice(0, slash)));
  const prefixStr = s.slice(slash + 1);
  if (v === 0 || !/^\d{1,3}$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  return prefix >= 0 && prefix <= (v === 4 ? 32 : 128);
}

/**
 * True if `clientIp` matches any allowlist entry (single IP or CIDR). A client only matches a CIDR of the SAME family;
 * a malformed entry is skipped (never matches, never throws) so a bad entry can never become a match-all.
 */
export function ipMatchesAllowlist(clientIp: string, allowlist: readonly string[]): boolean {
  const client = ipToBig(clientIp);
  if (!client) return false;
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash === -1) {
      const e = ipToBig(entry);
      if (e && e.version === client.version && e.bits === client.bits) return true;
      continue;
    }
    const net = ipToBig(entry.slice(0, slash));
    const prefixStr = entry.slice(slash + 1);
    if (!net || net.version !== client.version || !/^\d{1,3}$/.test(prefixStr)) continue;
    const size = client.version === 4 ? 32 : 128;
    const prefix = Number(prefixStr);
    if (prefix < 0 || prefix > size) continue;
    const shift = BigInt(size - prefix);
    if (client.bits >> shift === net.bits >> shift) return true;
  }
  return false;
}

/** Parse a comma list of IPs/CIDRs; malformed entries are dropped (never widen trust). */
export function parseCidrList(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e && isValidIpOrCidr(e));
}

export interface ClientIpPolicy {
  /** The operator declared a trusted proxy in front (HUB_TRUSTED_PROXY=true). */
  trustProxy: boolean;
  /** Strict: ONLY `trustedCidrs` peers may speak for a client (private peers are no longer implicitly trusted). */
  strict: boolean;
  /** Extra proxy peers (a proxy with a public egress IP), already validated. */
  trustedCidrs: readonly string[];
  /** Cloudflare orange-cloud mode: trust CF-Connecting-IP when the observed hop is a Cloudflare edge range. */
  cloudflare?: boolean;
  /** Operator-supplied additional Cloudflare ranges (additive to the vendored list), already validated. */
  cloudflareExtraCidrs?: readonly string[];
}

/**
 * May this TCP peer speak for a client via X-Forwarded-For? Only a well-formed address that is NOT publicly
 * routable (loopback, RFC1918/docker bridge, CGNAT, link-local, ULA) or that is listed in the trusted CIDRs. In strict
 * mode ONLY the listed CIDRs are trusted.
 */
export function isTrustedProxyPeer(remote: string | null | undefined, policy: ClientIpPolicy): boolean {
  if (!remote) return false;
  const addr = normalizeIp(remote);
  if (isIP(addr) === 0) return false;
  if (policy.strict) return ipMatchesAllowlist(addr, policy.trustedCidrs);
  return !isPublicIp(addr) || ipMatchesAllowlist(addr, policy.trustedCidrs);
}

/**
 * Parse one X-Forwarded-For token into a bare IP, or null when it is not an IP address. Accepts a quoted token, a
 * bracketed IPv6 (with an optional port) and an IPv4 with a port; an IPv4-mapped IPv6 is folded to its IPv4.
 * Anything else (`unknown`, a hostname, a truncated address, free text) is rejected.
 */
export function parseForwardedToken(tok: string): string | null {
  let t = tok.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(t);
  if (v6) t = v6[1] as string;
  else {
    const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(t);
    if (v4) t = v4[1] as string;
  }
  const ip = normalizeIp(t);
  return isIP(ip) !== 0 ? ip : null;
}

/** The rightmost X-Forwarded-For entry as an IP (the address the nearest trusted proxy itself observed), or null. */
export function rightmostForwardedIp(forwardedFor: string): string | null {
  const parts = forwardedFor.split(",");
  return parseForwardedToken(parts[parts.length - 1] ?? "");
}

/** Is this address inside a published Cloudflare edge range (or an operator-added extra range)? */
export function isCloudflareEdgeIp(ip: string, extraCidrs: readonly string[] = []): boolean {
  return ipMatchesAllowlist(ip, CLOUDFLARE_IP_RANGES) || (extraCidrs.length > 0 && ipMatchesAllowlist(ip, extraCidrs));
}

/**
 * Parse a CF-Connecting-IP value. Cloudflare sends exactly one bare IP, so anything else (a list, several header
 * lines joined by a comma, a port, brackets, whitespace inside, free text) is rejected, and so is a non-public
 * address: a real Internet client is never loopback/private/ULA/link-local/CGNAT/unspecified.
 */
export function parseCfConnectingIp(value: string | string[] | undefined | null): string | null {
  if (typeof value !== "string") return null; // absent, or repeated header lines (an array) -> fail closed
  const t = value.trim();
  if (!t || /[\s,\[\]"]/.test(t)) return null;
  const ip = normalizeIp(t);
  if (isIP(ip) === 0 || !isPublicIp(ip)) return null;
  return ip;
}

/**
 * The reachable source IP of an inbound connection. See the module comment for the trust model.
 *
 * Default / no usable proxy: the raw TCP peer. Trusted proxy + trusted peer: the rightmost X-Forwarded-For entry
 * (must parse as an IP, else null: never the proxy's own address). With Cloudflare mode, when that observed hop is a
 * Cloudflare edge range the client is CF-Connecting-IP (null when absent/malformed: never the edge address).
 * Returns null when nothing usable is present.
 */
export function resolveClientIp(
  remoteAddress: string | null | undefined,
  forwardedFor: string | null | undefined,
  cfConnectingIp: string | string[] | null | undefined,
  policy: ClientIpPolicy,
): string | null {
  if (policy.trustProxy && forwardedFor && isTrustedProxyPeer(remoteAddress, policy)) {
    const edge = rightmostForwardedIp(forwardedFor);
    if (edge === null) return null;
    if (policy.cloudflare && isCloudflareEdgeIp(edge, policy.cloudflareExtraCidrs ?? [])) {
      return parseCfConnectingIp(cfConnectingIp);
    }
    return edge;
  }
  const raw = (remoteAddress ?? "").replace(/^::ffff:/i, "");
  return raw || null;
}

export interface ForwardedChain {
  /** The single X-Forwarded-For value to forward upstream (replaces whatever the client sent). */
  forwardedFor: string;
  /** Forward CF-Connecting-IP as received (true) or delete it (false). */
  keepCfConnectingIp: boolean;
}

/**
 * What a middle hop (the web server in front of the hub) may vouch for. It never forwards a chain it cannot
 * trust: when the TCP peer is a trusted proxy peer and sent a well-formed X-Forwarded-For, the rightmost entry (what
 * that proxy observed) becomes the only entry; every other peer is replaced by its own socket address, and a
 * client-supplied CF-Connecting-IP is dropped. A malformed chain from a trusted peer becomes `unknown`, which the
 * hub refuses (fail closed) instead of silently recording the proxy's address.
 */
export function sanitizeForwardedChain(
  peer: string | null | undefined,
  forwardedFor: string | null | undefined,
  policy: ClientIpPolicy,
): ForwardedChain {
  const p = peer ? normalizeIp(peer) : "";
  if (isIP(p) === 0) return { forwardedFor: "unknown", keepCfConnectingIp: false };
  if (policy.trustProxy && forwardedFor && isTrustedProxyPeer(p, policy)) {
    return { forwardedFor: rightmostForwardedIp(forwardedFor) ?? "unknown", keepCfConnectingIp: true };
  }
  return { forwardedFor: p, keepCfConnectingIp: false };
}
