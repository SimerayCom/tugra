import { isIP } from "node:net";

/** A normalized IP address is IPv6 when it contains a colon. */
export function isIpv6(ip: string): boolean {
  return ip.includes(":");
}

/** A loopback address is never externally reachable. */
export function isLoopbackIp(ip: string): boolean {
  return ip.startsWith("127.") || ip === "::1" || ip.toLowerCase() === "0:0:0:0:0:0:0:1";
}

/** RFC 1918 private IPv4 ranges (LAN, still often reachable but not public). */
function isPrivateV4(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** RFC 6598 carrier-grade NAT (100.64.0.0/10) — a shared ISP address, never publicly reachable. */
function isCgnatV4(ip: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}

/** Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4) so a mapped address
 *  is judged and stored as its underlying IPv4, never as an opaque "IPv6". */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/**
 * Is this a globally-routable public address (safe to embed in a magic domain
 * that resolves back to it)? Excludes loopback, unspecified, RFC1918, CGNAT and
 * link-local for IPv4; loopback, unspecified, link-local (fe80::/10) and ULA
 * (fc00::/7) for IPv6. IPv4-mapped IPv6 is judged as its IPv4 — otherwise a mapped
 * private/link-local address (e.g. ::ffff:169.254.169.254) would slip the guard
 * and point the hub's own probes at internal/metadata hosts (SSRF).
 */
export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  const v = normalizeIp(ip);
  // Reject anything that is not a well-formed IP literal (isIP → 0). Without this, a range-based
  // exclusion alone accepts a garbage/multi-line string (e.g. one embedding a newline), which callers
  // then trust as a real address — and it could be baked into config/compose downstream.
  if (isIP(v) === 0) return false;
  if (isLoopbackIp(v)) return false;
  if (isIpv6(v)) {
    if (v === "::") return false; // unspecified
    return !/^fe[89ab][0-9a-f]:/i.test(v) && !/^f[cd][0-9a-f]{2}:/i.test(v); // link-local /10 + ULA /7
  }
  if (v === "0.0.0.0") return false; // unspecified IPv4 (resolves to localhost on connect)
  if (/^169\.254\./.test(v)) return false; // link-local IPv4
  return !isPrivateV4(v) && !isCgnatV4(v);
}

/** Best reachable candidate from agent-reported interface IPs: public IPv4 > private IPv4 > any non-loopback. */
export function bestReportedIp(reportedIps: string[]): string | null {
  // Normalize first so an IPv4-mapped address is treated (and stored) as its IPv4,
  // not misclassified as an "IPv6" and dropped into publicIpv6 unstripped.
  const usable = reportedIps.map(normalizeIp).filter((ip) => ip && isIP(ip) !== 0 && !isLoopbackIp(ip));
  return (
    usable.find((ip) => !isIpv6(ip) && !isPrivateV4(ip)) ??
    usable.find((ip) => !isIpv6(ip)) ??
    usable[0] ??
    null
  );
}

/**
 * Reconcile a server's stored public IP against the interface IPs its agent
 * reported. A good observed egress address (non-loopback) is authoritative and
 * kept; only when the observed IP is missing or loopback (e.g. the hub shares the
 * host, or dev) do we adopt the best reported interface IP. A manual override is
 * never touched. Returns the fields to update, or null for no change.
 */
export function reconcileReportedIp(
  current: { publicIp: string | null; ipSource: string },
  reportedIps: string[],
): { publicIp?: string; publicIpv6?: string; ipSource?: string } | null {
  if (current.ipSource === "manual") return null;
  // A real observed egress IP is authoritative — keep it. A previously-reported IP,
  // an empty, or a loopback address falls through so reporting can (re)fill it and
  // track interface-IP changes.
  if (current.ipSource === "observed" && current.publicIp && !isLoopbackIp(current.publicIp)) return null;
  const pick = bestReportedIp(reportedIps);
  if (!pick || pick === current.publicIp) return null;
  // Route by family, mirroring ipFields — an IPv6 candidate never lands in the
  // IPv4 publicIp column.
  return isIpv6(pick) ? { publicIpv6: pick } : { publicIp: pick, ipSource: "reported" };
}

/**
 * The reachable source IP of an inbound connection.
 *
 * Default: the raw TCP peer address (`socket.remoteAddress`) — this is the
 * connection's real origin and cannot be spoofed by the peer. X-Forwarded-For is
 * honored ONLY when the hub is explicitly told it sits behind a trusted proxy;
 * otherwise a connecting agent could forge its own IP via that header.
 *
 * With a trusted proxy we take the RIGHTMOST X-Forwarded-For entry — the peer the
 * proxy itself observed and appended. The leftmost entries are client-supplied
 * and spoofable (a proxy that appends, e.g. nginx `proxy_add_x_forwarded_for`, or
 * a CDN, would otherwise let an agent forge its own IP).
 *
 * Normalizes IPv4-mapped IPv6 (`::ffff:1.2.3.4` -> `1.2.3.4`). Returns null when
 * nothing usable is present.
 */
export function observedIp(
  remoteAddress: string | null | undefined,
  forwardedFor: string | null | undefined,
  trustProxy: boolean,
): string | null {
  let raw: string;
  if (trustProxy && forwardedFor) {
    const parts = forwardedFor.split(",");
    raw = parts[parts.length - 1]?.trim() ?? "";
  } else {
    raw = remoteAddress ?? "";
  }
  raw = raw.replace(/^::ffff:/i, "");
  return raw || null;
}
