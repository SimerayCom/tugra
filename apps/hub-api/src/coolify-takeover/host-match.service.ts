import { Injectable } from "@nestjs/common";
import type { CoolifyServerLink, HostMatchVerdict } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { ServersService } from "../servers/servers.service";
import { matchHosts, type CoolifyHostInput, type MatchOptions, type TugraHostInput } from "./host-match";

/** The preflight's per-host verdict: what the screen shows. Verdict kinds only, no address. */
export interface PreflightMatch {
  status: HostMatchVerdict["status"];
  linkedBy: "auto" | null;
  evidence: HostMatchVerdict["candidates"][number]["evidence"];
}

/**
 * Which Tugra server is the same machine as a Coolify server (Coolify hub takeover, lane D): the I/O half around the pure
 * `matchHosts`. It loads the servers of every team the caller belongs to (so an address another team also reports counts as shared),
 * marks the ones the caller can manage (`servers:manage`: only those are ever proposed or linked), attaches the identity facts the
 * agents reported, and hands everything to the ladder. Read-only: it writes nothing.
 */
@Injectable()
export class HostMatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly servers: ServersService,
  ) {}

  /** One verdict per Coolify server, in the order the matcher returns them (by uuid). */
  async verdicts(userId: string, hosts: readonly CoolifyHostInput[], opts: MatchOptions = {}): Promise<HostMatchVerdict[]> {
    if (hosts.length === 0) return [];
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...perms.keys()];
    if (teamIds.length === 0) return matchHosts(hosts, [], opts);
    const rows = await this.prisma.server.findMany({
      where: { teamId: { in: teamIds } },
      select: { id: true, name: true, teamId: true, publicIp: true, publicIpv6: true, hostname: true, reportedIps: true },
    });
    const tugra: TugraHostInput[] = rows.map((r) => ({
      serverId: r.id,
      name: r.name,
      teamId: r.teamId,
      publicIp: r.publicIp,
      publicIpv6: r.publicIpv6,
      hostname: r.hostname,
      reportedIps: r.reportedIps,
      facts: this.servers.hostIdentityOf(r.id),
      canManage: perms.get(r.teamId)?.has("servers:manage") === true,
    }));
    return matchHosts(hosts, tugra, opts);
  }
}

/** The stored link a verdict allows: certain or probable only (a candidate set the owner must pick from is never linked for them). */
export function linkOf(v: HostMatchVerdict): CoolifyServerLink | null {
  if ((v.status !== "certain" && v.status !== "probable") || !v.tugraServerId) return null;
  const c = v.candidates.find((x) => x.serverId === v.tugraServerId);
  if (!c) return null;
  return { teamId: c.teamId, serverId: c.serverId, linkedBy: "auto", evidence: c.evidence };
}

/** The verdict as the preflight shows it (`PreflightHost.match`). */
export function preflightMatchOf(v: HostMatchVerdict): PreflightMatch {
  const c = v.candidates.find((x) => x.serverId === v.tugraServerId);
  return { status: v.status, linkedBy: linkOf(v) ? "auto" : null, evidence: c ? c.evidence : [] };
}
