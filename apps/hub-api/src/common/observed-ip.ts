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

/** Best reachable candidate from agent-reported interface IPs: public IPv4 > private IPv4 > any non-loopback. */
export function bestReportedIp(reportedIps: string[]): string | null {
  const usable = reportedIps.filter((ip) => ip && !isLoopbackIp(ip));
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
