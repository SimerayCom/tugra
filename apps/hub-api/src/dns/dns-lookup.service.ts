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
