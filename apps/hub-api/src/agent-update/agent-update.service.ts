import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ServerStatus } from "@prisma/client";
import { isNewer, parseVersion } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { UpdateService } from "../update/update.service";
import type { ChannelEntry } from "../update/update-manifest";
import { planTargets } from "../bulk/bulk.service";

/** One server's outcome. `sent` = signed agent_update dispatched; the new version becomes visible when
 *  the recreated agent reconnects. `skipped` carries a reason (already-current / no-digest / not-permitted /
 *  capability-not-granted); `offline` = agent not connected. */
export interface AgentUpdateItem {
  serverId: string;
  status: "sent" | "offline" | "skipped";
  reason?: string;
}
export interface AgentUpdateResponse {
  /** `hub-behind` = the published release is newer than this hub: update the hub first, agents never run ahead of it. */
  status: "ok" | "unconfigured" | "error" | "hub-behind";
  total: number;
  sent: number;
  offline: number;
  skipped: number;
  results: AgentUpdateItem[];
}

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
  /** A newer release is published than the one this hub runs: the hub goes first, agents follow afterwards. */
  hubBehind: boolean;
}

type FleetRow = { id: string; teamId: string; arch: string | null; agentVersion: string | null };

/** Which agents run an older version than `hubVersion`. Unknown/unparseable agent versions are never counted (we
 *  cannot tell they are behind, and a guess must not trigger an update). Pure. */
export function outdatedAgents<T extends { agentVersion: string | null }>(servers: T[], hubVersion: string): T[] {
  return servers.filter((s) => !!parseVersion(s.agentVersion ?? "") && isNewer(hubVersion, s.agentVersion as string));
}

const EMPTY = { total: 0, sent: 0, offline: 0, skipped: 0, results: [] as AgentUpdateItem[] };

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
  ) {}

  /** Update a single server. Requires the caller's `servers:manage` on that team (throws 403 otherwise). */
  async updateOne(userId: string, serverId: string): Promise<AgentUpdateResponse> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, teamId: true, arch: true, agentVersion: true },
    });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");

    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, ...EMPTY };
    const results = [await this.applyServer(server, verified.entry, userId)];
    return this.summarize(results);
  }

  /** Update many servers. Not-permitted targets are skipped (not a 403) — bulk semantics. */
  async updateFleet(userId: string, serverIds: string[]): Promise<AgentUpdateResponse> {
    const servers = (await this.prisma.server.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, teamId: true, arch: true, agentVersion: true },
    })) as ServerRow[];
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const planned = planTargets(serverIds, servers, permsByTeam, "servers:manage");

    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, ...EMPTY };

    const byId = new Map(servers.map((s) => [s.id, s]));
    const results: AgentUpdateItem[] = [];
    for (const p of planned) {
      const server = byId.get(p.serverId);
      if (!p.run || !server) {
        results.push({ serverId: p.serverId, status: "skipped", reason: "not-permitted" });
        continue;
      }
      results.push(await this.applyServer(server, verified.entry, userId));
    }
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
    return { current, total: servers.length, outdated: outdated.length, outdatedServerIds: outdated.map((s) => s.id), autoUpdate, hubBehind: updateAvailable === true };
  }

  /** One click: update every outdated agent the caller manages to the hub's release (same signed, digest-pinned path
   *  as the single update). Refuses while the hub itself is behind the published release. */
  async updateOutdated(userId: string): Promise<AgentUpdateResponse> {
    const { current } = await this.update.getStatus();
    const outdated = outdatedAgents(await this.managedAgents(userId), current);
    if (outdated.length === 0) return this.summarize([]);
    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, ...EMPTY };
    if (isNewer(verified.entry.version, current)) return { status: "hub-behind", ...EMPTY };
    const results: AgentUpdateItem[] = [];
    for (const s of outdated) results.push(await this.applyServer(s, verified.entry, userId));
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

  private summarize(results: AgentUpdateItem[]): AgentUpdateResponse {
    return {
      status: "ok",
      total: results.length,
      sent: results.filter((r) => r.status === "sent").length,
      offline: results.filter((r) => r.status === "offline").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    };
  }
}
