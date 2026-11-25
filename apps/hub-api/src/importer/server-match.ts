import { isIP } from "node:net";

/**
 * Which registered Tugra server is the same machine as a source server? Pure. Matching goes by address first (public IPv4/IPv6, then
 * any address the agent reports), then by host name. A private-range address (10.x, 192.168.x, 100.64/10, fc00::/7 ...) collides
 * across providers, so a match that rests on one is only "probable"; a public-address match is "certain". The plan carries the verdict
 * only, never the source's address.
 */

export type MatchVia = "public-ip" | "reported-ip" | "hostname";
export type MatchConfidence = "certain" | "probable";

export interface MatchCandidate {
  id: string;
  name: string;
  teamId: string;
  publicIp: string | null;
  publicIpv6: string | null;
  hostname: string | null;
  reportedIps: string[];
}

export interface TugraMatch {
  serverId: string;
  name: string;
  teamId: string;
  via: MatchVia;
  confidence: MatchConfidence;
}

/** Names a source reports for "this machine" that say nothing about the address. */
const LOCAL_NAMES = new Set(["localhost", "host.docker.internal", "gateway.docker.internal", "docker.for.mac.localhost"]);

const clean = (s: string): string => {
  let a = s.trim().toLowerCase();
  if (a.startsWith("[") && a.includes("]")) a = a.slice(1, a.indexOf("]")); // [::1]:22
  return a;
};

/** True for loopback, link-local, RFC 1918, CGNAT (100.64/10), IPv6 unique-local and link-local addresses. */
export function isPrivateAddress(raw: string): boolean {
  const a = clean(raw);
  const kind = isIP(a);
  if (kind === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 10 || p === 127 || p === 0 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127);
  }
  if (kind === 6) {
    if (a === "::1" || a === "::") return true;
    const first = parseInt(a.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/** The address a source reports, ready to compare, or null when it names no machine (empty, localhost, a docker alias). */
export function comparableAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const a = clean(raw);
  if (!a || LOCAL_NAMES.has(a) || a.endsWith(".internal") || a === "127.0.0.1" || a === "::1") return null;
  return a;
}

/**
 * Match one source address (an IP or a host name) to the registered servers. Several servers matching at the same rank is ambiguous
 * and yields no match (the user picks); a stronger rank always wins over a weaker one.
 */
export function matchTugraServer(address: string | undefined | null, servers: readonly MatchCandidate[]): TugraMatch | null {
  const a = comparableAddress(address);
  if (!a) return null;
  const isLiteral = isIP(a) !== 0;
  const rank: Array<{ s: MatchCandidate; via: MatchVia; confidence: MatchConfidence; score: number }> = [];
  for (const s of servers) {
    const eq = (x: string | null | undefined) => !!x && clean(x) === a;
    if (isLiteral) {
      const pub = !isPrivateAddress(a);
      if (eq(s.publicIp) || eq(s.publicIpv6)) rank.push({ s, via: "public-ip", confidence: pub ? "certain" : "probable", score: pub ? 4 : 2 });
      else if (s.reportedIps.some((x) => eq(x))) rank.push({ s, via: "reported-ip", confidence: pub ? "certain" : "probable", score: pub ? 3 : 1 });
    } else if (eq(s.hostname)) {
      rank.push({ s, via: "hostname", confidence: "probable", score: 2 });
    }
  }
  if (rank.length === 0) return null;
  const best = Math.max(...rank.map((r) => r.score));
  const top = rank.filter((r) => r.score === best);
  if (new Set(top.map((r) => r.s.id)).size !== 1) return null;
  const r = top[0];
  return { serverId: r.s.id, name: r.s.name, teamId: r.s.teamId, via: r.via, confidence: r.confidence };
}

/** The host part of a source's base URL (the machine its control plane runs on), lower-cased; null when it is not a URL. */
export function baseUrlHost(baseUrl: string | undefined | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
