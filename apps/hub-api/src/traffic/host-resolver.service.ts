import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** The application a request host belongs to (null appId never appears here — unmatched hosts are absent). */
export interface ResolvedHost {
  appId: string;
  teamId: string;
}

const CACHE_TTL_MS = 30_000;

/** Canonical form of a host for both the stored aliases and an incoming Host header: lowercased, port
 *  stripped (IPv6 literals in brackets handled), trailing dot removed. Returns "" for an unusable value. */
export function normalizeHost(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end > 0 ? h.slice(0, end + 1) : h;
  } else {
    h = h.replace(/:\d*$/, "");
  }
  return h.replace(/\.+$/, "");
}

/**
 * Maps a reporting server's request hosts to the application that owns them. The candidate set is built
 * from the apps ON THAT SERVER ONLY — a primary domain carries no cross-app uniqueness, so scoping by the
 * reporting serverId is what stops a host owned by another team (on another server) from being attributed
 * to the wrong app. Hosts that resolve to nothing are simply absent from the map (stored as unmatched).
 */
@Injectable()
export class HostResolverService {
  private readonly cache = new Map<string, { at: number; map: Map<string, ResolvedHost> }>();

  constructor(private readonly prisma: PrismaService) {}

  /** host → owner for one server. Short TTL cache (no explicit invalidation — a new alias is picked up within
   *  the TTL, and an unmatched host is still stored, so nothing is lost). */
  async forServer(serverId: string): Promise<Map<string, ResolvedHost>> {
    const hit = this.cache.get(serverId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map;

    const [apps, serviceDomains] = await Promise.all([
      this.prisma.application.findMany({
        where: { serverId },
        orderBy: { id: "asc" },
        select: { id: true, teamId: true, domain: true, extraDomains: true, domainRedirect: true },
      }),
      this.prisma.appServiceDomain.findMany({
        where: { application: { serverId } },
        select: { hostname: true, applicationId: true },
      }),
    ]);
    const teamOf = new Map(apps.map((a) => [a.id, a.teamId]));
    const map = new Map<string, ResolvedHost>();
    // First writer wins, so the order below is the precedence: every primary domain, then aliases/redirect
    // twins, then per-service compose hostnames (the only globally-unique ones).
    const add = (host: unknown, appId: string, teamId: string) => {
      const h = normalizeHost(host);
      if (h && !map.has(h)) map.set(h, { appId, teamId });
    };
    for (const a of apps) add(a.domain, a.id, a.teamId);
    for (const a of apps) {
      const primary = normalizeHost(a.domain);
      if (a.domainRedirect != null && primary) {
        const base = primary.replace(/^www\./, "");
        add(base, a.id, a.teamId);
        add(`www.${base}`, a.id, a.teamId);
      }
      for (const x of a.extraDomains ?? []) add(x, a.id, a.teamId);
    }
    for (const sd of serviceDomains) {
      const teamId = teamOf.get(sd.applicationId);
      if (teamId) add(sd.hostname, sd.applicationId, teamId);
    }
    this.cache.set(serverId, { at: Date.now(), map });
    return map;
  }

  /** Resolve one (already-normalized or raw) host against a server's map; null = unmatched. */
  resolve(map: Map<string, ResolvedHost>, host: string): ResolvedHost | null {
    return map.get(normalizeHost(host)) ?? null;
  }
}
