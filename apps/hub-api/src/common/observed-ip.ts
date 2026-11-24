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

/** Where a stored server address came from. `reported` = one of the host's own network interfaces. */
export type IpSource = "manual" | "reported" | "metadata" | "observed";

/** What the hub currently stores for a server's addresses. `ipv6Source` falls back to `ipSource` for rows written
 *  before the families were tracked separately. */
export interface HostIpState {
  publicIp: string | null;
  ipSource: string;
  publicIpv6?: string | null;
  ipv6Source?: string;
}

/** The columns to write for a reconcile. A family only appears when it changes. */
export interface HostIpUpdate {
  publicIp?: string;
  ipSource?: string;
  publicIpv6?: string;
  ipv6Source?: string;
}

interface IpCandidate {
  ip: string;
  source: Exclude<IpSource, "manual">;
}

/**
 * How trustworthy a stored/candidate address is (higher wins):
 *   5 public address on a host network interface      (the machine says so itself)
 *   4 public address from the cloud metadata service  (link-local, asked on the instance; covers NAT'd clouds)
 *   3 public address the hub observed on the connection
 *   2 non-public address the hub observed (a LAN/VPC peer, kept so home and same-VPC installs work)
 *   1 non-public interface address (last-resort LAN fallback)
 *   0 nothing usable (empty, loopback, a Cloudflare edge, or the local server's own docker bridge)
 * Manual pins are handled before ranking and are never overridden.
 */
function ipRank(source: string, ip: string | null | undefined, isLocal: boolean): number {
  if (!ip || isLoopbackIp(ip) || isCloudflareEdge(ip)) return 0;
  if (isLocal && !isIpv6(ip) && isDockerBridgeV4(ip)) return 0;
  const pub = isPublicIp(ip);
  if (source === "reported") return pub ? 5 : 1;
  if (source === "metadata") return pub ? 4 : 1;
  return pub ? 3 : 2; // "observed" and any legacy value
}

/** The best candidate for one family, or null when the stored value should stay. A candidate replaces the stored
 *  address when it outranks it, or when it is the same kind of source reporting a changed address (a dynamic IP, a
 *  re-numbered interface) — but never while the stored address is still among that source's current answers, so a
 *  host with several addresses does not flip between them. */
function pickFamily(
  cur: { ip: string | null; source: string },
  cands: IpCandidate[],
  isLocal: boolean,
): IpCandidate | null {
  const curRank = ipRank(cur.source, cur.ip, isLocal);
  let best: IpCandidate | null = null;
  let bestRank = 0;
  for (const c of cands) {
    const r = ipRank(c.source, c.ip, isLocal);
    if (r > bestRank) {
      best = c;
      bestRank = r;
    }
  }
  if (!best) return null;
  if (best.ip === cur.ip) return bestRank > curRank ? best : null; // same address, better provenance
  if (bestRank > curRank) return best;
  const sameKind = cur.source === best.source || (best.source === "observed" && !["reported", "metadata"].includes(cur.source));
  if (sameKind && curRank > 0 && !cands.some((c) => c.source === best!.source && c.ip === cur.ip)) return best;
  return null;
}

function apply(update: HostIpUpdate, pick: IpCandidate | null): void {
  if (!pick) return;
  if (isIpv6(pick.ip)) {
    update.publicIpv6 = pick.ip;
    update.ipv6Source = pick.source;
  } else {
    update.publicIp = pick.ip;
    update.ipSource = pick.source;
  }
}

/**
 * Reconcile a server's stored public addresses against what its agent reported, one family at a time (IPv4 and
 * IPv6 are independent: a host with a global IPv6 and an IPv4 gets both). Order of trust, best first: a public
 * address on the host's own interfaces, the cloud metadata service's answer (`metadataIps`), the address the hub
 * observed; a non-public LAN address is only a last resort. A manual pin (per family) is never touched.
 * Returns the columns to update, or null for no change.
 */
export function reconcileReportedIp(
  current: HostIpState,
  reportedIps: string[],
  isLocal = false,
  metadataIps: string[] = [],
): HostIpUpdate | null {
  const v6Source = current.ipv6Source ?? current.ipSource;
  const usable = (list: string[]) =>
    // Normalize first so an IPv4-mapped address is treated (and stored) as its IPv4. A Cloudflare edge address is never
    // a server's own, and the local server's docker-bridge address is never reachable.
    list
      .map(normalizeIp)
      .filter((ip) => ip && isIP(ip) !== 0 && !isLoopbackIp(ip) && !isCloudflareEdge(ip))
      .filter((ip) => !(isLocal && !isIpv6(ip) && isDockerBridgeV4(ip)));
  const iface = usable(reportedIps);
  const meta = usable(metadataIps).filter((ip) => isPublicIp(ip));

  const update: HostIpUpdate = {};
  if (current.ipSource !== "manual") {
    const v4 = iface.filter((ip) => !isIpv6(ip));
    const best4 = bestReportedIp(v4);
    // Every public interface address is a candidate (best first) so a stored one that is still present is kept.
    const ifaceCands: IpCandidate[] = best4
      ? [best4, ...v4.filter((ip) => ip !== best4 && isPublicIp(ip))].map((ip) => ({ ip, source: "reported" as const }))
      : [];
    const metaCands = meta.filter((ip) => !isIpv6(ip)).map((ip) => ({ ip, source: "metadata" as const }));
    apply(update, pickFamily({ ip: current.publicIp, source: current.ipSource }, [...ifaceCands, ...metaCands], isLocal));
  }
  if (v6Source !== "manual") {
    // Only a globally-routable IPv6 is a "public IPv6"; a ULA stays visible in the all-addresses list instead.
    const ifaceCands = iface.filter((ip) => isIpv6(ip) && isPublicIp(ip)).map((ip) => ({ ip, source: "reported" as const }));
    const metaCands = meta.filter((ip) => isIpv6(ip)).map((ip) => ({ ip, source: "metadata" as const }));
    apply(update, pickFamily({ ip: current.publicIpv6 ?? null, source: v6Source }, [...ifaceCands, ...metaCands], isLocal));
  }
  return Object.keys(update).length ? update : null;
}

/**
 * The same rules for the address the hub itself observed on the agent's connection (auth/enroll). It ranks below
 * the host's own interface and the cloud metadata, so a reconnect through a NAT/VPN never clobbers a better answer,
 * and below nothing else. Loopback, a Cloudflare edge and (local server) the docker bridge are never recorded.
 */
export function reconcileObservedIp(
  current: HostIpState,
  observed: string | null | undefined,
  isLocal = false,
): HostIpUpdate | null {
  if (!observed) return null;
  const ip = normalizeIp(observed);
  if (isIP(ip) === 0) return null;
  const v6 = isIpv6(ip);
  const cur = v6
    ? { ip: current.publicIpv6 ?? null, source: current.ipv6Source ?? current.ipSource }
    : { ip: current.publicIp, source: current.ipSource };
  if (cur.source === "manual") return null;
  const update: HostIpUpdate = {};
  apply(update, pickFamily(cur, [{ ip, source: "observed" }], isLocal));
  return Object.keys(update).length ? update : null;
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
