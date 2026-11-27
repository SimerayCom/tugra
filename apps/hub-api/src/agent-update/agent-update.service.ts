import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Role, ServerStatus } from "@prisma/client";
import { isNewer, parseVersion } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { UpdateService } from "../update/update.service";
import type { ChannelEntry } from "../update/update-manifest";
import { planTargets } from "../bulk/bulk.service";
import { InFlightService } from "../in-flight/in-flight.service";
import type { InFlightItem } from "../in-flight/in-flight.dto";

/** One server's outcome. `sent` = signed agent_update dispatched; the new version becomes visible when
 *  the recreated agent reconnects. `skipped` carries a reason (already-current / no-digest / not-permitted /
 *  capability-not-granted); `offline` = agent not connected; `held` = a migration, takeover, cutover, move or transfer
 *  is running on that server (`inFlight` lists it; `force` overrides it for an owner or admin of the team). */
export interface AgentUpdateItem {
  serverId: string;
  status: "sent" | "offline" | "skipped" | "held";
  reason?: string;
  inFlight?: InFlightItem[];
}
export interface AgentUpdateResponse {
  /** `hub-behind` = the published release is newer than this hub: update the hub first, agents never run ahead of it. */
  status: "ok" | "unconfigured" | "error" | "hub-behind";
  total: number;
  sent: number;
  offline: number;
  skipped: number;
  /** Servers left alone because work is in flight on them. */
  held: number;
  results: AgentUpdateItem[];
}

/** The machine code of the 409 / the `held` reason when work is in flight. */
export const MIGRATION_ACTIVE = "migration-active";
/** A forced update was asked for by someone who is not an owner or admin of the server's team: the hold stands. */
export const FORCE_NOT_PERMITTED = "force-not-permitted";

type ServerRow = { id: string; teamId: string; arch: string | null; agentVersion: string | null };

/** The agents the hub has not caught up with: how many of the team-managed remote agents run an older version than the hub. */
export interface AgentFleetStatus {
  /** The hub's own release: what every agent should be on. */
  current: string;
  /** Remote servers that have an agent (enrolled, not the hub's own box). */
  total: number;
  outdated: number;
  outdatedServerIds: string[];
  /** "Apply updates automatically" is on, so the hub rolls agents out by itself once it is on the latest release. */
  autoUpdate: boolean;
  /** Servers (of the caller's teams) with work in flight: updates, manual and automatic, leave them alone until it ends. */
  held: { serverId: string; inFlight: InFlightItem[] }[];
  /** A newer release is published than the one this hub runs: the hub goes first, agents follow afterwards. */
  hubBehind: boolean;
}

type FleetRow = { id: string; teamId: string; arch: string | null; agentVersion: string | null };

/** Which agents run an older version than `hubVersion`. Unknown/unparseable agent versions are never counted (we
 *  cannot tell they are behind, and a guess must not trigger an update). Pure. */
export function outdatedAgents<T extends { agentVersion: string | null }>(servers: T[], hubVersion: string): T[] {
  return servers.filter((s) => !!parseVersion(s.agentVersion ?? "") && isNewer(hubVersion, s.agentVersion as string));
}

const EMPTY = { total: 0, sent: 0, offline: 0, skipped: 0, held: 0, results: [] as AgentUpdateItem[] };

/** uname arch (`Server.arch`, e.g. x86_64/aarch64) → docker platform arch (amd64/arm64), the key the
 *  release pipeline uses for `agentSha256`. Unknown → null → we skip (never send an unpinned update). */
export function normalizeArch(arch: string | null | undefined): string | null {
  if (!arch) return null;
  const a = arch.toLowerCase();
  if (a === "x86_64" || a === "amd64") return "amd64";
  if (a === "aarch64" || a === "arm64") return "arm64";
  return null;
}

/** Build the target agent image ref at `version`, honoring an AGENT_IMAGE registry/repo override (its tag,
 *  if any, is replaced by the target version). The `@sha256:` digest is the real integrity anchor. */
export function agentImageRef(agentImageEnv: string | undefined, version: string): string {
  const base = (agentImageEnv ?? "ghcr.io/simeraycom/tugra-agent").replace(/:[^/]+$/, "");
  return `${base}:${version}`;
}

@Injectable()
export class AgentUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly update: UpdateService,
    private readonly config: ConfigService,
    private readonly inFlight: InFlightService,
  ) {}

  /**
   * Update a single server. Requires the caller's `servers:manage` on that team (throws 403 otherwise). While work is in flight on the
   * server the answer is 409 `migration-active` with the list; `force` goes ahead anyway, for an owner or admin of the team only (403 for
   * anyone else), and is audited with the list.
   */
  async updateOne(userId: string, serverId: string, force = false): Promise<AgentUpdateResponse> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, teamId: true, arch: true, agentVersion: true },
    });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");

    const held = await this.inFlight.listForServers([serverId]);
    if (held.length > 0) {
      if (!force) throw new ConflictException({ statusCode: 409, message: "work is in flight on this server: a migration, takeover, cutover, move or transfer is running", code: MIGRATION_ACTIVE, inFlight: held });
      if (!(await this.isTeamAdmin(userId, server.teamId))) throw new ForbiddenException("only an owner or admin of the team can update through a running migration");
    }

    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, ...EMPTY };
    const results = [await this.applyServer(server, verified.entry, userId)];
    if (held.length > 0) await this.auditForce(userId, results, new Map([[serverId, held]]));
    return this.summarize(results);
  }

  /**
   * Update many servers. Not-permitted targets are skipped (not a 403) — bulk semantics. Servers with work in flight are left alone and
   * reported as `held` with the list; the rest are updated. `force` includes the held ones in teams where the caller is owner or admin
   * (audited per server); elsewhere they stay held.
   */
  async updateFleet(userId: string, serverIds: string[], force = false): Promise<AgentUpdateResponse> {
    const servers = (await this.prisma.server.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, teamId: true, arch: true, agentVersion: true },
    })) as ServerRow[];
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const planned = planTargets(serverIds, servers, permsByTeam, "servers:manage");

    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, ...EMPTY };

    const byId = new Map(servers.map((s) => [s.id, s]));
    const busy = InFlightService.byServer(await this.inFlight.list(), serverIds);
    const adminOf = force && busy.size > 0 ? await this.adminTeams(userId) : new Set<string>();
    const results: AgentUpdateItem[] = [];
    const overridden = new Map<string, InFlightItem[]>();
    for (const p of planned) {
      const server = byId.get(p.serverId);
      if (!p.run || !server) {
        results.push({ serverId: p.serverId, status: "skipped", reason: "not-permitted" });
        continue;
      }
      const held = busy.get(server.id);
      if (held) {
        if (!(force && adminOf.has(server.teamId))) {
          results.push({ serverId: server.id, status: "held", reason: force ? FORCE_NOT_PERMITTED : MIGRATION_ACTIVE, inFlight: held });
          continue;
        }
        overridden.set(server.id, held);
      }
      results.push(await this.applyServer(server, verified.entry, userId));
    }
    await this.auditForce(userId, results, overridden);
    return this.summarize(results);
  }

  /**
   * The remote agents (enrolled, not the hub's own box) of every team the caller manages that run an older version
   * than the hub: the "3/24 agents are on an older version" notice. Reads only the DB + the running version — no
   * manifest fetch, so the panel can poll it freely. Servers of teams the caller cannot manage are never counted.
   */
  async fleetStatus(userId: string): Promise<AgentFleetStatus> {
    const { current, autoUpdate, updateAvailable } = await this.update.getStatus();
    const servers = await this.managedAgents(userId);
    const outdated = outdatedAgents(servers, current);
    const busy = InFlightService.byServer(await this.inFlight.list(), servers.map((s) => s.id));
    const held = [...busy].map(([serverId, inFlight]) => ({ serverId, inFlight }));
    return { current, total: servers.length, outdated: outdated.length, outdatedServerIds: outdated.map((s) => s.id), autoUpdate, held, hubBehind: updateAvailable === true };
  }

  /** One click: update every outdated agent the caller manages to the hub's release (same signed, digest-pinned path
   *  as the single update). Refuses while the hub itself is behind the published release. Servers with work in flight are
   *  held (reported, not updated) unless `force` and the caller is owner or admin of their team. */
  async updateOutdated(userId: string, force = false): Promise<AgentUpdateResponse> {
    const { current } = await this.update.getStatus();
    const outdated = outdatedAgents(await this.managedAgents(userId), current);
    if (outdated.length === 0) return this.summarize([]);
    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, ...EMPTY };
    if (isNewer(verified.entry.version, current)) return { status: "hub-behind", ...EMPTY };
    const busy = InFlightService.byServer(await this.inFlight.list(), outdated.map((s) => s.id));
    const adminOf = force && busy.size > 0 ? await this.adminTeams(userId) : new Set<string>();
    const results: AgentUpdateItem[] = [];
    const overridden = new Map<string, InFlightItem[]>();
    for (const s of outdated) {
      const held = busy.get(s.id);
      if (held) {
        if (!(force && adminOf.has(s.teamId))) {
          results.push({ serverId: s.id, status: "held", reason: force ? FORCE_NOT_PERMITTED : MIGRATION_ACTIVE, inFlight: held });
          continue;
        }
        overridden.set(s.id, held);
      }
      results.push(await this.applyServer(s, verified.entry, userId));
    }
    await this.auditForce(userId, results, overridden);
    return this.summarize(results);
  }

  /** Remote servers with an enrolled agent in teams where the user holds servers:manage. */
  private async managedAgents(userId: string): Promise<FleetRow[]> {
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...perms.entries()].filter(([, p]) => p.has("servers:manage")).map(([id]) => id);
    if (teamIds.length === 0) return [];
    return (await this.prisma.server.findMany({
      where: { teamId: { in: teamIds }, isLocal: false, status: { not: ServerStatus.PENDING } },
      select: { id: true, teamId: true, arch: true, agentVersion: true },
    })) as FleetRow[];
  }

  /** The hub updating an agent by itself (auto-rollout): no user, audited as the system actor. */
  async applyAuto(server: ServerRow, entry: ChannelEntry): Promise<AgentUpdateItem> {
    return this.applyServer(server, entry, "auto-update");
  }

  private async applyServer(server: ServerRow, entry: ChannelEntry, userId: string): Promise<AgentUpdateItem> {
    const arch = normalizeArch(server.arch);
    const sha256 = arch ? entry.agentSha256?.[arch] : undefined;
    if (!sha256) return { serverId: server.id, status: "skipped", reason: "no-digest-for-arch" };

    // Never-downgrade / no-op. A parseable current version that isn't older than the target → skip.
    // Null/garbage agentVersion → proceed (can't confirm it's current; re-pulling the same digest is safe).
    if (parseVersion(server.agentVersion ?? "") && !isNewer(entry.version, server.agentVersion as string)) {
      return { serverId: server.id, status: "skipped", reason: "already-current" };
    }

    const image = agentImageRef(this.config.get<string>("AGENT_IMAGE"), entry.version);
    const sent = await this.agentWs.sendAgentUpdate(server.id, entry.version, image, sha256);
    if (!sent) {
      // sendAgentUpdate is false when offline OR the deploy capability isn't granted — distinguish for ops.
      return this.agentWs.isOnline(server.id)
        ? { serverId: server.id, status: "skipped", reason: "capability-not-granted" }
        : { serverId: server.id, status: "offline" };
    }
    await this.audit.log({
      actor: userId,
      action: "agent.update.request",
      target: server.id,
      meta: { from: server.agentVersion, to: entry.version, image, sha256 },
    });
    return { serverId: server.id, status: "sent" };
  }

  /** Teams where the user is owner or admin: the ones whose members may update through a running migration. */
  private async adminTeams(userId: string): Promise<Set<string>> {
    const roles = await this.access.roleByTeam(userId);
    return new Set([...roles].filter(([, r]) => r === Role.OWNER || r === Role.ADMIN).map(([id]) => id));
  }

  private async isTeamAdmin(userId: string, teamId: string): Promise<boolean> {
    const r = await this.access.teamRole(userId, teamId);
    return r === Role.OWNER || r === Role.ADMIN;
  }

  /** One audit row per forced update that actually went out, with what was running on that server. */
  private async auditForce(userId: string, results: AgentUpdateItem[], overridden: Map<string, InFlightItem[]>): Promise<void> {
    for (const r of results) {
      const items = overridden.get(r.serverId);
      if (r.status !== "sent" || !items?.length) continue;
      await this.audit.log({
        actor: userId,
        action: "agent.update.force",
        target: r.serverId,
        meta: { inFlight: items.slice(0, 20).map(({ kind, id, label }) => ({ kind, id, label })), count: items.length },
      });
    }
  }

  private summarize(results: AgentUpdateItem[]): AgentUpdateResponse {
    return {
      status: "ok",
      total: results.length,
      sent: results.filter((r) => r.status === "sent").length,
      offline: results.filter((r) => r.status === "offline").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      held: results.filter((r) => r.status === "held").length,
      results,
    };
  }
}
