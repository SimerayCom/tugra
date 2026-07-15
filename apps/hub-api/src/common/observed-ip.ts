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
export function isPrivateV4(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** RFC 6598 carrier-grade NAT (100.64.0.0/10) — a shared ISP address, never publicly reachable. */
export function isCgnatV4(ip: string): boolean {
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

/**
 * SSRF: addresses that are NEVER a legitimate outbound target, regardless of any policy toggle.
 * Loopback, unspecified (0.0.0.0/8, ::), IPv4 link-local incl. 169.254.169.254 cloud metadata,
 * broadcast, multicast (v4 224/4, v6 ff00::/8), IPv6 link-local (fe80::/10), NAT64 (64:ff9b::/96),
 * IPv4-compatible IPv6 (::a.b.c.d). A non-literal string fails closed (blocked). `normalizeIp` folds
 * ::ffff: mapped forms to their IPv4 so ::ffff:169.254.169.254 is judged as its v4 and blocked.
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  const v = normalizeIp(ip);
  if (isIP(v) === 0) return true; // not a well-formed literal → fail closed
  if (isLoopbackIp(v)) return true;
  if (isIpv6(v)) {
    // Anything in ::/96 that survived normalizeIp — IPv4-compatible (::a.b.c.d / ::7f00:1), the hex form
    // of a mapped address (::ffff:7f00:1), unspecified (::) — is never legitimate global unicast.
    // (Callers canonicalize IPv6 literals first, so an EXPANDED mapped form is folded to this shape.)
    if (v.startsWith("::")) return true;
    // AWS IPv6 instance-metadata (fd00:ec2::254) is a ULA carve-out; block its /32 regardless of the
    // private-targets toggle so "metadata is always blocked" holds for IPv6 too. fd00/ec2 are non-zero
    // groups so they always render literally at the start, in any zero-compression notation.
    if (/^fd00:0*ec2:/i.test(v)) return true;
    if (/^ff[0-9a-f]{2}:/i.test(v)) return true; // multicast ff00::/8
    if (/^fe[89ab][0-9a-f]:/i.test(v)) return true; // link-local fe80::/10
    if (/^64:ff9b:/i.test(v)) return true; // NAT64 well-known prefix
    return false;
  }
  if (v === "0.0.0.0" || /^0\./.test(v)) return true; // unspecified 0.0.0.0/8
  if (v === "255.255.255.255") return true; // limited broadcast
  if (/^169\.254\./.test(v)) return true; // link-local incl. 169.254.169.254 metadata
  if (/^(22[4-9]|23\d)\./.test(v)) return true; // multicast 224.0.0.0/4
  return false;
}

/** LAN-routable private ranges that a policy toggle MAY loosen: RFC1918, CGNAT (v4), ULA (v6). */
export function isPrivateNetworkIp(ip: string): boolean {
  const v = normalizeIp(ip);
  if (isIP(v) === 0) return false;
  if (isIpv6(v)) return /^f[cd][0-9a-f]{2}:/i.test(v); // ULA fc00::/7
  return isPrivateV4(v) || isCgnatV4(v);
}

/**
 * Final SSRF gate for an outbound-notification target IP. Metadata/loopback/link-local are ALWAYS
 * blocked; private LAN ranges are blocked unless `allowPrivate` (NOTIFY_ALLOW_PRIVATE_TARGETS) is set,
 * so a self-hoster can point a webhook at an internal ntfy/gotify while cloud-metadata theft stays shut.
 */
export function isSsrfSafeIp(ip: string, allowPrivate: boolean): boolean {
  if (isAlwaysBlockedIp(ip)) return false;
  if (!allowPrivate && isPrivateNetworkIp(ip)) return false;
  return true;
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
