/** A normalized IP address is IPv6 when it contains a colon. */
export function isIpv6(ip: string): boolean {
  return ip.includes(":");
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
