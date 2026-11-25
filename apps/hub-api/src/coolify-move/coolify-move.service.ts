import { Injectable, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import {
  moveOffPhaseIsActive,
  moveOffStageOf,
  moveOffSteps,
  COOLIFY_SSH_TERMINAL_STATES,
  type CampaignView,
  type CleanupView,
  type CoolifyHostGrantView,
  type CoolifySshRunView,
  type MoveOffCampaignRow,
  type MoveOffGrantState,
  type MoveOffHub,
  type MoveOffMoves,
  type MoveOffServerRow,
  type MoveOffStatusView,
  type ProjectMovePhase,
  type ProjectMoveView,
  type TakeoverView,
} from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { CoolifyTakeoverService, type InventorySummary } from "../coolify-takeover/coolify-takeover.service";
import { CoolifyHostGrantService } from "../coolify-takeover/coolify-host-grant.service";
import { HostMatchService, linkOf } from "../coolify-takeover/host-match.service";
import { CoolifySshInstallService } from "../coolify-takeover/coolify-ssh-install.service";
import { CoolifyInPlaceService } from "../coolify-inplace/coolify-inplace.service";
import { MigrationCampaignsService } from "../migration-campaigns/migration-campaigns.service";
import { CoolifyCleanupService } from "../coolify-cleanup/coolify-cleanup.service";
import { ProjectMovesService } from "../project-moves/project-moves.service";

const READ_ROLES: Role[] = [Role.OWNER, Role.ADMIN];
/** How far back the rollups look. The team has a handful of Coolify hosts and a few hundred moves at most. */
const MOVE_SCAN = 500;
const CAMPAIGN_SCAN = 50;

/** One target of an install run as a status tool shows it: names, states and fixed codes. The probe's host identifiers are left out. */
export interface SshTargetStatus {
  name: string;
  state: string;
  code: string | null;
  tugraServerId: string | null;
  manualCommand: boolean;
  canRemove: boolean;
}
export interface SshInstallStatus {
  runId: string;
  finished: boolean;
  expiresAt: string;
  targets: SshTargetStatus[];
}

/** The install run view reduced to what a status read needs. The full view carries probe facts (hashed host ids, fingerprints) a status never needs. */
export function slimSshRun(v: CoolifySshRunView): SshInstallStatus {
  return {
    runId: v.runId,
    finished: v.finished,
    expiresAt: v.expiresAt,
    targets: v.targets.map((t) => ({ name: t.name, state: t.state, code: t.code, tugraServerId: t.tugraServerId, manualCommand: t.manualCommand, canRemove: t.canRemove })),
  };
}

function linkedServerIds(links: unknown, teamId: string): string[] {
  if (!links || typeof links !== "object" || Array.isArray(links)) return [];
  const out: string[] = [];
  for (const l of Object.values(links as Record<string, unknown>)) {
    const o = l as { teamId?: unknown; serverId?: unknown } | null;
    if (o && o.teamId === teamId && typeof o.serverId === "string") out.push(o.serverId);
  }
  return out;
}

/** Coolify server ids that carry a stored link into this team. */
function linkedCoolifyIds(links: unknown, teamId: string): string[] {
  if (!links || typeof links !== "object" || Array.isArray(links)) return [];
  return Object.entries(links as Record<string, unknown>)
    .filter(([, l]) => (l as { teamId?: unknown } | null)?.teamId === teamId && typeof (l as { serverId?: unknown }).serverId === "string")
    .map(([k]) => k);
}

function grantState(g: { revokedAt: Date | null; expiresAt: Date } | undefined, now: Date): MoveOffGrantState {
  if (!g) return "none";
  if (g.revokedAt) return "revoked";
  return g.expiresAt.getTime() > now.getTime() ? "active" : "expired";
}

function sshCounts(states: string[]): Omit<NonNullable<MoveOffHub["ssh"]>, "runId"> {
  const online = states.filter((s) => s === "ONLINE").length;
  const failed = states.filter((s) => s === "FAILED").length;
  const skipped = states.filter((s) => s.startsWith("SKIPPED") || s === "REMOVED").length;
  const finished = states.every((s) => (COOLIFY_SSH_TERMINAL_STATES as readonly string[]).includes(s));
  return { finished, online, failed, skipped, pending: states.length - online - failed - skipped, total: states.length };
}

/**
 * Read-only progress and status of the move off Coolify. Every method is a read, secret-free, and limited to a team owner or admin (the
 * services it calls check again). The REST route, the MCP tools and the CLI all go through here, so they can never disagree.
 */
@Injectable()
export class CoolifyMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly takeover: CoolifyTakeoverService,
    private readonly grants: CoolifyHostGrantService,
    private readonly ssh: CoolifySshInstallService,
    private readonly inplace: CoolifyInPlaceService,
    private readonly campaigns: MigrationCampaignsService,
    private readonly cleanup: CoolifyCleanupService,
    private readonly moves: ProjectMovesService,
    private readonly hostMatch: HostMatchService,
  ) {}

  /** Where every server of the team stands on the four steps. Stored data only; nothing is run on any server. */
  async status(userId: string, teamId: string, now: Date = new Date()): Promise<MoveOffStatusView> {
    await this.access.requireRole(userId, teamId, READ_ROLES);
    const [servers, inventories, takeovers, cleanups, campaignRows, moveRows] = await Promise.all([
      this.prisma.server.findMany({ where: { teamId }, select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
      this.prisma.coolifyInventory.findMany({ where: { teamId }, select: { serverId: true, readAt: true, counts: true, serverLinks: true, snapshot: true }, orderBy: { createdAt: "asc" } }),
      this.prisma.coolifyTakeover.findMany({ where: { teamId }, select: { serverId: true, status: true }, orderBy: { createdAt: "desc" }, distinct: ["serverId"] }),
      this.prisma.coolifyCleanup.findMany({ where: { teamId }, select: { serverId: true, status: true }, orderBy: { createdAt: "desc" }, distinct: ["serverId"] }),
      this.prisma.migrationCampaign.findMany({ where: { teamId }, select: { id: true, label: true, status: true, plan: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: CAMPAIGN_SCAN }),
      this.prisma.projectMove.findMany({ where: { teamId }, select: { phase: true }, orderBy: { createdAt: "desc" }, take: MOVE_SCAN }),
    ]);

    const hubIds = new Set(inventories.map((i) => i.serverId));
    const known = new Set<string>([...hubIds, ...takeovers.map((t) => t.serverId), ...cleanups.map((c) => c.serverId)]);
    for (const inv of inventories) for (const id of linkedServerIds(inv.serverLinks, teamId)) known.add(id);
    // Servers added by hand were never linked by the checklist: match the Coolify servers to them by address, read-only (nothing is stored).
    const unlinked = new Map<string, number | null>();
    for (const inv of inventories) {
      const m = await this.matchInventory(userId, teamId, inv);
      for (const id of m.matched) known.add(id);
      unlinked.set(inv.serverId, m.unlinked);
    }
    const takeoverOf = new Map(takeovers.map((t) => [t.serverId, t.status]));
    const cleanupOf = new Map(cleanups.map((c) => [c.serverId, c.status]));

    const rows: MoveOffServerRow[] = servers.map((s) => {
      const base = {
        serverId: s.id,
        name: s.name,
        agentOnline: s.status === "ONLINE",
        coolify: known.has(s.id),
        isCoolifyHub: hubIds.has(s.id),
        takeover: (takeoverOf.get(s.id) ?? "none") as MoveOffServerRow["takeover"],
        cleanup: (cleanupOf.get(s.id) ?? "none") as MoveOffServerRow["cleanup"],
      };
      return { ...base, stage: moveOffStageOf(base) };
    });

    const phases = moveRows.map((m) => m.phase);
    const projectMoves: MoveOffMoves = {
      total: phases.length,
      active: phases.filter(moveOffPhaseIsActive).length,
      completed: phases.filter((p) => p === "COMPLETED").length,
      failed: phases.filter((p) => p === "FAILED" || p === "ROLLED_BACK").length,
      latestPhase: (phases[0] as ProjectMovePhase | undefined) ?? null,
    };
    const campaignsOut: MoveOffCampaignRow[] = campaignRows.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status as MoveOffCampaignRow["status"],
      runs: Array.isArray(c.plan) ? c.plan.length : 0,
      createdAt: c.createdAt.toISOString(),
    }));

    const hub = await this.hubOf(teamId, inventories, rows, unlinked, now);
    return { teamId, hub, servers: rows, campaigns: campaignsOut, projectMoves, steps: moveOffSteps(rows, projectMoves, hub?.readAt ?? null) };
  }

  /**
   * The Tugra servers of this team that are the same machine as a Coolify server of one read, by the evidence ladder (certain or probable
   * only, the same rule the checklist links by), plus how many of Coolify's own servers are neither linked nor matched. Null unlinked =
   * no read yet, so nothing to say. The Coolify host row is this machine and never counted.
   */
  private async matchInventory(
    userId: string,
    teamId: string,
    inv: { serverId: string; serverLinks: unknown; snapshot: unknown },
  ): Promise<{ matched: string[]; unlinked: number | null }> {
    const snap = inv.snapshot as { v?: unknown; servers?: unknown } | null;
    if (!snap || snap.v !== 1 || !Array.isArray(snap.servers)) return { matched: [], unlinked: null };
    const linked = new Set(linkedCoolifyIds(inv.serverLinks, teamId));
    const open = (snap.servers as Array<{ id?: unknown; ip?: unknown; isLocal?: unknown }>).filter((s) => typeof s.id === "string" && s.isLocal !== true && !linked.has(s.id));
    if (open.length === 0) return { matched: [], unlinked: 0 };
    const verdicts = await this.hostMatch.verdicts(
      userId,
      open.map((s) => ({ uuid: s.id as string, address: typeof s.ip === "string" ? s.ip : null, isLocal: false })),
      { localServerId: inv.serverId },
    );
    const matched: string[] = [];
    for (const v of verdicts) {
      const l = linkOf(v);
      if (l && l.teamId === teamId) matched.push(l.serverId);
    }
    return { matched, unlinked: open.length - matched.length };
  }

  private async hubOf(
    teamId: string,
    inventories: Array<{ serverId: string; readAt: Date | null; counts: unknown }>,
    rows: MoveOffServerRow[],
    unlinked: ReadonlyMap<string, number | null>,
    now: Date,
  ): Promise<MoveOffHub | null> {
    // The newest read wins when a team connected more than one Coolify host.
    const inv = [...inventories].sort((a, b) => (b.readAt?.getTime() ?? 0) - (a.readAt?.getTime() ?? 0))[0];
    if (!inv) return null;
    const name = rows.find((r) => r.serverId === inv.serverId)?.name ?? "";
    const counts = inv.counts as { servers?: unknown } | null;
    const [grant, lastSsh] = await Promise.all([
      this.prisma.coolifyHostGrant.findFirst({ where: { teamId, serverId: inv.serverId, kind: "secrets" }, orderBy: { createdAt: "desc" }, select: { revokedAt: true, expiresAt: true } }),
      this.prisma.coolifyHostGrant.findFirst({ where: { teamId, serverId: inv.serverId, kind: "ssh", runId: { not: null } }, orderBy: { createdAt: "desc" }, select: { runId: true } }),
    ]);
    const state = grantState(grant ?? undefined, now);
    let ssh: MoveOffHub["ssh"] = null;
    if (lastSsh?.runId) {
      const targets = await this.prisma.coolifySshTarget.findMany({ where: { teamId, serverId: inv.serverId, runId: lastSsh.runId }, select: { state: true } });
      ssh = { runId: lastSsh.runId, ...sshCounts(targets.map((t) => t.state)) };
    }
    return {
      serverId: inv.serverId,
      name,
      readAt: inv.readAt ? inv.readAt.toISOString() : null,
      knownServers: typeof counts?.servers === "number" ? counts.servers : null,
      unlinkedServers: unlinked.get(inv.serverId) ?? null,
      secrets: state,
      secretsExpiresAt: state === "active" && grant ? grant.expiresAt.toISOString() : null,
      ssh,
    };
  }

  // ---- status reads for the MCP tools and the CLI (each delegates, so the same role checks and views apply) ------------------

  private async teamOfServer(serverId: string): Promise<string> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { teamId: true } });
    if (!s) throw new NotFoundException("server-not-found");
    return s.teamId;
  }

  /** Inventory counts, the consent state and the in-place takeovers of one server. No inventory body, no values. */
  async takeoverStatus(userId: string, serverId: string): Promise<{ serverId: string; inventory: InventorySummary | null; secretsGrants: CoolifyHostGrantView[]; takeovers: TakeoverView[] }> {
    const teamId = await this.teamOfServer(serverId);
    const [inventories, grants, takeovers] = await Promise.all([this.takeover.list(userId, teamId), this.grants.list(userId, teamId), this.inplace.list(userId, serverId)]);
    return {
      serverId,
      inventory: inventories.find((i) => i.serverId === serverId) ?? null,
      secretsGrants: grants.filter((g) => g.serverId === serverId && g.kind === "secrets"),
      takeovers,
    };
  }

  async campaignStatus(userId: string, teamId: string, id?: string): Promise<{ campaigns: CampaignView[] } | { campaign: CampaignView }> {
    if (id) return { campaign: await this.campaigns.get(userId, id) };
    return { campaigns: await this.campaigns.list(userId, teamId) };
  }

  async cleanupStatus(userId: string, serverId: string): Promise<{ serverId: string; cleanup: CleanupView | null }> {
    return { serverId, cleanup: await this.cleanup.latest(userId, serverId) };
  }

  async sshInstallStatus(userId: string, serverId: string, runId?: string): Promise<{ serverId: string; run: SshInstallStatus | null }> {
    const v = runId ? await this.ssh.getRun(userId, serverId, runId) : await this.ssh.latestRun(userId, serverId);
    return { serverId, run: v ? slimSshRun(v) : null };
  }

  async projectMoveStatus(userId: string, projectId: string, moveId?: string): Promise<{ moves: ProjectMoveView[] } | { move: ProjectMoveView }> {
    if (moveId) {
      const move = await this.moves.get(userId, moveId);
      // A move id of another project answers as unknown, so an id cannot be used to read around the project check.
      if (move.projectId !== projectId) throw new NotFoundException("move-not-found");
      return { move };
    }
    return { moves: await this.moves.list(userId, projectId) };
  }
}
