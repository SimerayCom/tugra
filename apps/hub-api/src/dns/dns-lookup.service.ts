import { Injectable } from "@nestjs/common";
import { promises as dns } from "node:dns";

/**
 * A thin, injectable wrapper over the system resolver so DnsAutomationService.verify can do a real public-DNS
 * lookup while staying trivially mockable in tests. Each method resolves to the record values, or an empty
 * array when the name does not resolve for that type (ENOTFOUND/ENODATA) — a missing record is "not yet
 * propagated", never an exception the caller has to special-case.
 */
@Injectable()
export class DnsLookupService {
  async resolve4(hostname: string): Promise<string[]> {
    return this.safe(() => dns.resolve4(hostname));
  }

  async resolve6(hostname: string): Promise<string[]> {
    return this.safe(() => dns.resolve6(hostname));
  }

  async resolveCname(hostname: string): Promise<string[]> {
    return this.safe(() => dns.resolveCname(hostname));
  }

  /** A/AAAA answers with their TTL as the (caching) system resolver reports it. NOTE the TTL decays in the cache —
   *  use {@link resolveAuthoritative} when the real configured TTL matters. */
  async resolveWithTtl(hostname: string, type: "A" | "AAAA"): Promise<Array<{ address: string; ttl: number }>> {
    return this.safeRows(() => (type === "A" ? dns.resolve4(hostname, { ttl: true }) : dns.resolve6(hostname, { ttl: true })));
  }

  /**
   * The record set and its configured TTL asked straight of the zone's authoritative nameservers: walk the labels
   * upward with resolveNs until an NS set is found (no public-suffix list), resolve the NS names, then query a
   * resolver pointed at them. ttl is null when nothing answered.
   */
  async resolveAuthoritative(hostname: string, type: "A" | "AAAA"): Promise<{ addresses: string[]; ttl: number | null; ns: string[] }> {
    const labels = hostname.split(".");
    let ns: string[] = [];
    for (let i = 0; i <= labels.length - 2 && ns.length === 0; i++) {
      ns = await this.safe(() => dns.resolveNs(labels.slice(i).join(".")));
    }
    if (ns.length === 0) return { addresses: [], ttl: null, ns: [] };
    const ips: string[] = [];
    for (const n of ns.slice(0, 4)) ips.push(...(await this.safe(() => dns.resolve4(n))));
    if (ips.length === 0) return { addresses: [], ttl: null, ns };
    const r = this.makeResolver(ips.slice(0, 4));
    const rows = await this.safeRows(() => (type === "A" ? r.resolve4(hostname, { ttl: true }) : r.resolve6(hostname, { ttl: true })));
    return { addresses: rows.map((x) => x.address), ttl: rows.length ? Math.min(...rows.map((x) => x.ttl)) : null, ns };
  }

  /** What the three big public resolvers answer for the name (A or AAAA). */
  async resolvePublic(hostname: string, type: "A" | "AAAA"): Promise<Record<"1.1.1.1" | "8.8.8.8" | "9.9.9.9", string[]>> {
    const out = { "1.1.1.1": [] as string[], "8.8.8.8": [] as string[], "9.9.9.9": [] as string[] };
    for (const ip of Object.keys(out) as Array<keyof typeof out>) {
      const r = this.makeResolver([ip]);
      // A resolver that times out counts as "has not seen the record yet" (the caller retries), never an exception.
      out[ip] = await this.safe(() => (type === "A" ? r.resolve4(hostname) : r.resolve6(hostname))).catch(() => []);
    }
    return out;
  }

  /** Test seam: a Resolver pointed at the given servers. */
  protected makeResolver(servers: string[]): Pick<dns.Resolver, "resolve4" | "resolve6"> {
    const r = new dns.Resolver({ timeout: 4000, tries: 2 });
    r.setServers(servers);
    return r;
  }

  private async safeRows(fn: () => Promise<Array<{ address: string; ttl: number }>>): Promise<Array<{ address: string; ttl: number }>> {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
      throw e;
    }
  }

  private async safe(fn: () => Promise<string[]>): Promise<string[]> {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
      throw e;
    }
  }
}
