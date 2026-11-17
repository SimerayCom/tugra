import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isIP } from "node:net";
import { PrismaService } from "../prisma/prisma.service";
import { isPublicIp, normalizeIp } from "../common/observed-ip";

/** Where the egress address came from: the operator's override, the hub's own server record, or nowhere (never guessed). */
export type EgressIpSource = "env" | "server" | "unknown";

export interface EgressIpInfo {
  /** The address a source such as Coolify sees this hub connect from, or null when it cannot be told. */
  ip: string | null;
  source: EgressIpSource;
}

const FOUND_TTL_MS = 10 * 60_000;
const UNKNOWN_TTL_MS = 60_000; // a hub that has no address yet picks one up soon after its local agent reports

/**
 * The hub's public egress IP, shown in the import wizard so the owner can put it into Coolify's Settings > Advanced > Allowed IPs.
 *
 * NO outbound probe: the product makes no IP phone-home, so no public echo service is called. The address comes from, in order:
 *   1. `IMPORT_EGRESS_IP`, the operator override (the right value for a hub behind NAT, a different egress gateway or a LAN-only
 *      Coolify, where the address the source sees is not the box's public one);
 *   2. the public address of the server record the hub runs on (`isLocal`), which the installer pins (`--public-ip`) or the first
 *      agent report observes;
 *   3. "unknown": the wizard says so instead of guessing.
 * The answer is resolved once and cached (10 minutes when known, 1 minute when unknown); a failed lookup is "unknown", never an error.
 */
@Injectable()
export class EgressIpService {
  private cache: { at: number; ttl: number; value: EgressIpInfo } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(): Promise<EgressIpInfo> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.cache.ttl) return this.cache.value;
    const value = await this.lookup();
    this.cache = { at: t, ttl: value.ip ? FOUND_TTL_MS : UNKNOWN_TTL_MS, value };
    return value;
  }

  /** The address only, for an error hint; never throws. */
  async ip(): Promise<string | null> {
    try {
      return (await this.resolve()).ip;
    } catch {
      return null;
    }
  }

  private async lookup(): Promise<EgressIpInfo> {
    const override = this.config.get<string>("IMPORT_EGRESS_IP")?.trim();
    if (override) {
      const v = normalizeIp(override);
      if (isIP(v) !== 0) return { ip: v, source: "env" };
    }
    try {
      const server = await this.prisma.server.findFirst({
        where: { isLocal: true, OR: [{ publicIp: { not: null } }, { publicIpv6: { not: null } }] },
        orderBy: { createdAt: "asc" },
        select: { publicIp: true, publicIpv6: true },
      });
      for (const candidate of [server?.publicIp, server?.publicIpv6]) {
        const v = candidate ? normalizeIp(candidate.trim()) : "";
        if (v && isPublicIp(v)) return { ip: v, source: "server" };
      }
    } catch {
      /* unknown below */
    }
    return { ip: null, source: "unknown" };
  }
}
