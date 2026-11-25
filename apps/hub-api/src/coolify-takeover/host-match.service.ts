import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CoolifyServerLink, HostIdentityFacts, HostMatchVerdict } from "@tugra/shared";
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

  /**
   * What the SSH probe saw of each Coolify server (the target machine's own hashed machine id and Docker engine id, and the sshd host key
   * the Coolify host's agent saw on the wire), by Coolify server uuid. The newest probe of each server wins. Facts only: ids and hashes,
   * never an address. A server nobody probed has none (unknown, never "different").
   */
  async probeFacts(agentServerId: string, uuids: readonly string[]): Promise<Map<string, HostIdentityFacts>> {
    const out = new Map<string, HostIdentityFacts>();
    if (uuids.length === 0) return out;
    const rows = await this.prisma.coolifySshTarget.findMany({
      where: { serverId: agentServerId, coolifyServerUuid: { in: [...uuids] }, probe: { not: Prisma.DbNull } },
      orderBy: { updatedAt: "desc" },
      select: { coolifyServerUuid: true, probe: true, hostKeyFp: true },
      take: 2000,
    });
    for (const r of rows) {
      if (out.has(r.coolifyServerUuid)) continue;
      const f = probeIdentity(r.probe, r.hostKeyFp);
      if (f) out.set(r.coolifyServerUuid, f);
    }
    return out;
  }

  /**
   * One verdict per Coolify server, in the order the matcher returns them (by uuid). When the Coolify host's own agent is named
   * (`localServerId`), the identity facts the SSH probes found for the other Coolify servers are fed to the ladder: the same machine id,
   * Docker engine id or host key is what turns an address guess into a certain match (and a different one into a conflict).
   */
  async verdicts(userId: string, hosts: readonly CoolifyHostInput[], opts: MatchOptions = {}): Promise<HostMatchVerdict[]> {
    if (hosts.length === 0) return [];
    if (opts.localServerId) {
      const need = hosts.filter((h) => !h.facts && !h.isLocal).map((h) => h.uuid);
      const probed = await this.probeFacts(opts.localServerId, need).catch(() => new Map<string, HostIdentityFacts>());
      if (probed.size > 0) hosts = hosts.map((h) => (probed.has(h.uuid) ? { ...h, facts: probed.get(h.uuid) } : h));
    }
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

const HEX64 = /^[0-9a-f]{64}$/;
const ENGINE = /^[A-Za-z0-9:_-]{8,128}$/;
const SSH_FP = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** The identity facts of a stored probe (a JSON column: only a fact with the shape of one is kept). Null when there is none. */
export function probeIdentity(probe: unknown, hostKeyFp: string | null): HostIdentityFacts | null {
  const p = probe && typeof probe === "object" && !Array.isArray(probe) ? (probe as Record<string, unknown>) : {};
  const f: HostIdentityFacts = {};
  const fp = typeof p.sshHostKeyFp === "string" ? p.sshHostKeyFp : hostKeyFp;
  if (typeof fp === "string" && SSH_FP.test(fp)) f.sshHostKeyFp = fp;
  if (typeof p.machineIdHash === "string" && HEX64.test(p.machineIdHash)) f.machineIdHash = p.machineIdHash;
  if (typeof p.dockerEngineId === "string" && ENGINE.test(p.dockerEngineId)) f.dockerEngineId = p.dockerEngineId;
  return Object.keys(f).length ? f : null;
}
