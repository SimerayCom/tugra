import { isIP } from "node:net";
import {
  CLOUDFLARE_IP_RANGES,
  isCloudflareEdgeIp,
  isCgnatV4,
  isIpv6,
  isLoopbackIp,
  isPrivateV4,
  isPublicIp,
  isTrustedProxyPeer as isTrustedProxyPeerWith,
  normalizeIp,
  parseCidrList,
  parseForwardedToken,
  resolveClientIp,
  type ClientIpPolicy,
} from "@tugra/shared";

// The pure address helpers and the trust algorithm live in @tugra/shared (single source of truth, also used by the
// web server's forwarded-header guard). This module keeps the env-reading wrappers the hub calls.
export { isCgnatV4, isIpv6, isLoopbackIp, isPrivateV4, isPublicIp, normalizeIp, parseForwardedToken };

/** The 172.16.0.0/12 slice Docker hands its bridge networks (default bridge 172.17, user networks 172.18-31).
 *  It is a valid RFC1918 range, but an agent reporting one is almost always exposing a docker-internal address
 *  that is NOT reachable from other devices — so a real LAN IP (10.x / 192.168.x) is preferred over it. */
export function isDockerBridgeV4(ip: string): boolean {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(normalizeIp(ip));
}

/**
 * The public IP the owner's browser used to reach the panel — derived from the request URL, NOT an outbound
 * probe (trust-wedge: no IP phone-home). Returns the host only when it is a globally-routable IP literal (v4
 * or v6); a DNS name, a port-only value or a private/loopback address yields null. Used to pin the single-box
 * local server's reachable address at first-owner claim so deployed-app URLs resolve from the very first deploy.
 */
export function observedPublicIpFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname; // strips scheme + port; IPv6 stays bracketed ([2001:db8::1])
  } catch {
    return null;
  }
  const ip = normalizeIp(host.replace(/^\[|\]$/g, "")); // unwrap the IPv6 brackets URL.hostname keeps
  return isPublicIp(ip) ? ip : null;
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

/** A Cloudflare edge address (vendored ranges + HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS). When the hub sits behind
 *  Cloudflare's orange cloud without the verified CF-Connecting-IP mode, every agent connection "comes from" one of
 *  these, so it must never be recorded as a server's public IP. */
export function isCloudflareEdge(ip: string | null | undefined): boolean {
  return !!ip && isCloudflareEdgeIp(normalizeIp(ip), parseCloudflareExtraCidrs());
}

/** Best reachable candidate from agent-reported interface IPs:
 *  public IPv4 > real-LAN private IPv4 (10.x / 192.168.x) > any other IPv4 (incl. docker-bridge 172.x) > any
 *  non-loopback. The LAN-over-docker-bridge preference matters for a home/single-box server: the agent reports
 *  both its docker bridge (172.17.x) and its real LAN address (192.168.x), and only the LAN one is reachable
 *  from other devices — picking the bridge IP would make every app's URL a dead docker-internal link. */
export function bestReportedIp(reportedIps: string[]): string | null {
  // Normalize first so an IPv4-mapped address is treated (and stored) as its IPv4,
  // not misclassified as an "IPv6" and dropped into publicIpv6 unstripped.
  const usable = reportedIps.map(normalizeIp).filter((ip) => ip && isIP(ip) !== 0 && !isLoopbackIp(ip));
  return (
    // A globally-routable IPv4 first: a CGNAT / Tailscale 100.64/10 address is "not RFC1918" but never reachable from
    // the internet, so it must not win over the host's real public interface.
    usable.find((ip) => !isIpv6(ip) && isPublicIp(ip)) ??
    usable.find((ip) => !isIpv6(ip) && !isPrivateV4(ip) && !isCgnatV4(ip)) ??
    usable.find((ip) => !isIpv6(ip) && !isPrivateV4(ip)) ??
    usable.find((ip) => !isIpv6(ip) && isPrivateV4(ip) && !isDockerBridgeV4(ip)) ??
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
  isLocal = false,
): { publicIp?: string; publicIpv6?: string; ipSource?: string } | null {
  if (current.ipSource === "manual") return null;
  // A real observed egress IP is authoritative — keep it. A previously-reported IP, an empty or a loopback
  // falls through so reporting / a manual pin can (re)fill it and track interface-IP changes. For the hub's
  // OWN single-box agent (isLocal) a stored docker-bridge address (172.16-31.x) is the agent's in-container
  // source IP — never reachable — so it is ALSO repairable; for a remote server a 172.x may be a reachable
  // same-VPC/LAN address, so it stays authoritative there.
  const bridgeRepairable = isLocal && !!current.publicIp && isDockerBridgeV4(current.publicIp);
  // A Cloudflare edge address recorded before the verified CF-Connecting-IP mode was on is never the server's own:
  // it is repairable from the reported interfaces.
  const cfRepairable = !!current.publicIp && isCloudflareEdge(current.publicIp);
  if (
    current.ipSource === "observed" &&
    current.publicIp &&
    !isLoopbackIp(current.publicIp) &&
    !bridgeRepairable &&
    !cfRepairable
  )
    return null;
  const pick = bestReportedIp(reportedIps.filter((ip) => !isCloudflareEdge(ip)));
  if (!pick || pick === current.publicIp) return null;
  // Never (re)store the hub's own docker-bridge address as a reachable IP for the local server — a
  // containerized agent whose only interface is the bridge would otherwise land back on 172.x via
  // bestReportedIp's last-resort fallback, undoing the skip and dead-linking every app URL.
  if (isLocal && isDockerBridgeV4(pick)) return null;
  // Route by family, mirroring ipFields — an IPv6 candidate never lands in the
  // IPv4 publicIp column.
  return isIpv6(pick) ? { publicIpv6: pick } : { publicIp: pick, ipSource: "reported" };
}

let cidrCacheRaw: string | undefined;
let cidrCache: string[] = [];

/** Parse HUB_TRUSTED_PROXY_CIDRS (comma list of IP/CIDR; malformed entries are dropped, never widen trust).
 *  Memoized by the raw string so the per-request hot path does not re-split. */
export function parseTrustedProxyCidrs(raw: string | undefined = process.env.HUB_TRUSTED_PROXY_CIDRS): string[] {
  if (raw === cidrCacheRaw) return cidrCache;
  cidrCacheRaw = raw;
  cidrCache = parseCidrList(raw);
  return cidrCache;
}

/** True when the operator declared a trusted proxy in front of the hub (HUB_TRUSTED_PROXY=true). Read per call. */
export function trustProxyEnabled(): boolean {
  return process.env.HUB_TRUSTED_PROXY === "true";
}

/** Opt-in strict mode (HUB_TRUSTED_PROXY_STRICT=true): only peers listed in HUB_TRUSTED_PROXY_CIDRS may speak for a
 *  client via X-Forwarded-For; a private/loopback/docker peer that is not listed is no longer trusted implicitly. */
export function strictProxyTrust(): boolean {
  return process.env.HUB_TRUSTED_PROXY_STRICT === "true";
}

/** Opt-in Cloudflare orange-cloud mode (HUB_TRUSTED_PROXY_CLOUDFLARE=true; requires HUB_TRUSTED_PROXY=true). The client
 *  is then CF-Connecting-IP, but only when the hop the trusted proxy observed is a published Cloudflare edge range. */
export function cloudflareProxyEnabled(): boolean {
  return process.env.HUB_TRUSTED_PROXY_CLOUDFLARE === "true";
}

let cfExtraRaw: string | undefined;
let cfExtra: string[] = [];

/** HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS: extra Cloudflare ranges (additive to the vendored list; malformed dropped). */
export function parseCloudflareExtraCidrs(raw: string | undefined = process.env.HUB_TRUSTED_PROXY_CLOUDFLARE_EXTRA_CIDRS): string[] {
  if (raw === cfExtraRaw) return cfExtra;
  cfExtraRaw = raw;
  cfExtra = parseCidrList(raw);
  return cfExtra;
}

/** The effective client-IP trust policy from the environment. `trustProxy` overrides HUB_TRUSTED_PROXY (callers pass
 *  trustProxyEnabled()); Cloudflare mode can never be on without it. Read per call so tests/operators see changes. */
export function currentClientIpPolicy(trustProxy: boolean = trustProxyEnabled()): ClientIpPolicy {
  return {
    trustProxy,
    strict: strictProxyTrust(),
    trustedCidrs: parseTrustedProxyCidrs(),
    cloudflare: trustProxy && cloudflareProxyEnabled(),
    cloudflareExtraCidrs: parseCloudflareExtraCidrs(),
  };
}

/** The vendored Cloudflare edge ranges plus any operator-added extras (for the boot log / diagnostics). */
export function effectiveCloudflareRanges(): string[] {
  return [...CLOUDFLARE_IP_RANGES, ...parseCloudflareExtraCidrs()];
}

/**
 * May this TCP peer speak for a client via X-Forwarded-For? Only a well-formed address that is NOT publicly
 * routable (loopback, RFC1918/docker bridge, CGNAT, link-local, ULA) or that is listed in
 * HUB_TRUSTED_PROXY_CIDRS (a remote proxy with a public egress IP; 0.0.0.0/0 + ::/0 = trust any). A direct
 * hit from the public internet therefore can never forge its own source IP, even with HUB_TRUSTED_PROXY=true.
 * With HUB_TRUSTED_PROXY_STRICT=true ONLY the HUB_TRUSTED_PROXY_CIDRS entries are trusted (a same-LAN host that
 * reaches the raw hub port can then no longer forge its source IP either).
 */
export function isTrustedProxyPeer(remote: string | null | undefined): boolean {
  return isTrustedProxyPeerWith(remote, currentClientIpPolicy());
}

/** Express `trust proxy` predicate: trust exactly ONE hop, and only when that hop is a trusted proxy peer. */
export const trustProxyFn = (addr: string, hop: number): boolean => hop === 0 && isTrustedProxyPeer(addr);

/**
 * The reachable source IP of an inbound connection.
 *
 * Default: the raw TCP peer address (`socket.remoteAddress`) — this is the
 * connection's real origin and cannot be spoofed by the peer. X-Forwarded-For is
 * honored ONLY when the hub is explicitly told it sits behind a trusted proxy
 * (HUB_TRUSTED_PROXY=true) AND the TCP peer itself is a trusted proxy address
 * (see isTrustedProxyPeer); otherwise a connecting client could forge its own IP
 * via that header — e.g. by hitting a raw published port directly.
 *
 * With a trusted proxy we take the RIGHTMOST X-Forwarded-For entry — the peer the
 * proxy itself observed and appended. The leftmost entries are client-supplied
 * and spoofable. That entry must parse as an IP; a malformed one yields null (fail closed) — never the proxy's
 * own address. With HUB_TRUSTED_PROXY_CLOUDFLARE=true and that entry inside a published Cloudflare edge range, the
 * client is `cfConnectingIp` instead (null when absent/malformed — never the edge address).
 *
 * Normalizes IPv4-mapped IPv6 (`::ffff:1.2.3.4` -> `1.2.3.4`). Returns null when
 * nothing usable is present.
 */
export function observedIp(
  remoteAddress: string | null | undefined,
  forwardedFor: string | null | undefined,
  trustProxy: boolean,
  cfConnectingIp?: string | string[] | null,
): string | null {
  return resolveClientIp(remoteAddress, forwardedFor, cfConnectingIp, currentClientIpPolicy(trustProxy));
}

/** The shape of a Node/Express request the IP helpers need (an HTTP request or a WebSocket upgrade request). */
export interface IpRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
}

/**
 * The client IP of an HTTP request or WebSocket upgrade, honoring HUB_TRUSTED_PROXY (+ _STRICT/_CIDRS/_CLOUDFLARE).
 * Single entry point for the PAT allowlist guard, the terminal gateway and the agent gateway, so they can never
 * disagree on which header wins.
 */
export function requestClientIp(req: IpRequestLike | null | undefined): string | null {
  const h = req?.headers;
  const fwd = h?.["x-forwarded-for"];
  const cf = h?.["cf-connecting-ip"];
  return observedIp(req?.socket?.remoteAddress, Array.isArray(fwd) ? fwd[0] : fwd, trustProxyEnabled(), cf);
}

/**
 * Express middleware for Cloudflare mode: Express derives `req.ip` (throttling buckets, request logs) from
 * X-Forwarded-For alone, which behind Cloudflare is the Cloudflare edge. When the observed hop is a verified
 * Cloudflare edge, rewrite X-Forwarded-For to the verified CF-Connecting-IP; when it is a Cloudflare edge with no
 * usable CF-Connecting-IP, rewrite it to `unknown` (req.ip then has no address: fail closed, never the edge IP).
 * Does nothing for any other request, so a non-Cloudflare client keeps its own address.
 */
export function cloudflareClientIpMiddleware(
  req: IpRequestLike & { headers: Record<string, string | string[] | undefined> },
  _res: unknown,
  next: () => void,
): void {
  const fwd = req.headers["x-forwarded-for"];
  const xff = Array.isArray(fwd) ? fwd[0] : fwd;
  const policy = currentClientIpPolicy();
  if (policy.cloudflare && xff && isTrustedProxyPeerWith(req.socket?.remoteAddress, policy)) {
    const ip = resolveClientIp(req.socket?.remoteAddress, xff, req.headers["cf-connecting-ip"], policy);
    const edge = parseForwardedToken(xff.split(",").pop() ?? "");
    if (edge && ip !== edge) req.headers["x-forwarded-for"] = ip ?? "unknown";
  }
  next();
}
