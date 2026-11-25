import { isIP } from "node:net";
import type { DnsLookupService } from "../dns/dns-lookup.service";
import type { NetProbe } from "../cutover/net-probe";

/**
 * The traffic row of the completeness checklist (Coolify hub takeover, lane G): has each hostname Coolify served really moved to Tugra?
 * A hostname passes only when (1) every address the public name resolves to is this Tugra server's own public address, and (2) Tugra
 * answers on that address with a valid, trusted certificate for the name. Anything else (still pointing at Coolify, a mix, an
 * unresolvable name, a default certificate, a probe that failed) is "not cut over". Read-only: DNS lookups and one TLS handshake that
 * sends no application byte; the handshake goes to the server's own stored address, never to an address a lookup returned.
 */

export interface TrafficTarget {
  ipv4: string | null;
  ipv6: string | null;
}
export interface TrafficDeps {
  dns: Pick<DnsLookupService, "resolve4" | "resolve6">;
  net: Pick<NetProbe, "sslAt">;
}

const MAX_HOSTS = 100;
const BATCH = 6;

/** Compare IPv6 loosely enough for the case difference of hex digits; v4 is exact. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function one(host: string, target: TrafficTarget, deps: TrafficDeps): Promise<boolean> {
  try {
    if (isIP(host) !== 0) return false;
    const own = [target.ipv4, target.ipv6].filter((x): x is string => !!x);
    if (own.length === 0) return false;
    const [a, aaaa] = await Promise.all([deps.dns.resolve4(host).catch(() => [] as string[]), deps.dns.resolve6(host).catch(() => [] as string[])]);
    const answers = [...a, ...aaaa];
    if (answers.length === 0 || !answers.every((ip) => own.some((o) => same(o, ip)))) return false;
    const probe = await deps.net.sslAt(target.ipv4 ?? (target.ipv6 as string), host);
    return probe.ok === true;
  } catch {
    return false;
  }
}

/** hostname -> cut over. More than 100 hostnames: the rest count as not cut over (never skipped silently as fine). */
export async function checkTraffic(hosts: readonly string[], target: TrafficTarget, deps: TrafficDeps): Promise<Record<string, boolean>> {
  const unique = [...new Set(hosts)];
  const out: Record<string, boolean> = {};
  const probed = unique.slice(0, MAX_HOSTS);
  for (const h of unique.slice(MAX_HOSTS)) out[h] = false;
  for (let i = 0; i < probed.length; i += BATCH) {
    const chunk = probed.slice(i, i + BATCH);
    const res = await Promise.all(chunk.map((h) => one(h, target, deps)));
    chunk.forEach((h, j) => (out[h] = res[j]));
  }
  return out;
}
