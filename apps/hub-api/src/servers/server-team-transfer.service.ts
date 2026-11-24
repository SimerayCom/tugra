import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { ServersService } from "./servers.service";

/**
 * Move a server to another team.
 *
 * Design (the safest correct one): a server travels ALONE. The agent connection, the seal and the identity are
 * keyed by the server id, so they are untouched and nothing is reinstalled. Every OTHER resource that is tied to
 * the old team (apps, databases, hand-made monitors, cluster membership, running moves/migrations) would end up
 * pointing across a team boundary — at a Git source, registry, secret provider, backup destination, notification
 * channel or project that the new team cannot see — so each of those BLOCKS the move with a clear list instead of
 * being silently dragged along or severed. The operator moves or removes them first (app moves between servers,
 * project/team moves are separate flows), then the server is free to change team.
 *
 * What does travel with the server: its plain settings (proxy, capabilities, tags), its history
 * (metrics/traffic/audit are keyed by server id) and its auto-created disk monitor (re-homed to the new team with
 * the old team's alert channels detached). Anything that carries the old team's SECRETS or data sinks does not: a
 * Cloudflare tunnel (holds the old team's API token) and server-wide log drains (endpoint + auth token) BLOCK the
 * move; the cloud-provider credential, the "copied from this DNS credential" marker and the copied DNS-01 token are
 * cleared and reported up front.
 */

/** How many example resources a blocker lists (the count is always exact). */
export const TRANSFER_BLOCKER_SAMPLE = 10;
/** Upper bound of one bulk request. */
export const MAX_BULK_TRANSFER = 50;

export type TransferBlockerKind = "application" | "build_server" | "database" | "monitor" | "cluster" | "app_move" | "migration" | "reboot" | "tunnel" | "log_drain" | "bulk_task";

export interface TransferBlocker {
  kind: TransferBlockerKind;
  count: number;
  /** Up to TRANSFER_BLOCKER_SAMPLE examples (id + display name). */
  items: { id: string; name: string }[];
}

export type TransferDetachKind = "cloud_credential" | "dns_credential" | "dns_secret" | "alert_channels";

export interface TransferDetach {
  kind: TransferDetachKind;
  /** Display name of the credential (absent for alert channels). */
  name?: string;
  /** Number of links dropped (alert channels only). */
  count?: number;
}

export interface TransferPlan {
  server: { id: string; name: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  blockers: TransferBlocker[];
  detaches: TransferDetach[];
  canMove: boolean;
}

export type BulkTransferStatus = "moved" | "unchanged" | "blocked" | "denied" | "failed";
export interface BulkTransferResult {
  serverId: string;
  status: BulkTransferStatus;
  blockers?: TransferBlocker[];
  message?: string;
}

/** MigrationRun statuses in which the run still owns its target server. */
const MIGRATION_RUN_LIVE = ["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING"] as const;
/** ObjectMigration statuses in which the migration still needs its target server (DRAFT/PREFLIGHTED included: they are
 *  a plan against that server). */
const OBJECT_MIGRATION_DONE = ["DONE", "FAILED"];

export const TRANSFER_BLOCKED_CODE = "server_transfer_blocked";

function blockedException(blockers: TransferBlocker[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: "this server still has resources of its current team — move or remove them first",
    code: TRANSFER_BLOCKED_CODE,
    blockers,
  });
}

/** The slice of PrismaService / a transaction client the blocker scan reads. */
type Db = Pick<
  PrismaService,
  | "application"
  | "database"
  | "monitor"
  | "cluster"
  | "appMove"
  | "migrationRun"
  | "migrationRunServerLock"
  | "objectMigration"
  | "serverReboot"
  | "serverTunnel"
  | "logDrain"
  | "bulkTask"
>;

interface Counted {
  count: number;
  items: { id: string; name: string }[];
}

@Injectable()
export class ServerTeamTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: TeamAccessService,
    private readonly servers: ServersService,
  ) {}

  // ---- authorization ---------------------------------------------------------

  private async isInstanceOwner(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    return u?.isInstanceOwner === true;
  }

  /** The caller may act on the SOURCE side: servers:manage in the server's team, or instance owner. */
  private async requireSourceAuthority(userId: string, teamId: string, owner: boolean): Promise<void> {
    if (!owner) await this.access.requirePermission(userId, teamId, "servers:manage");
  }

  /** The caller may place a server into the destination team: servers:manage there, or instance owner. A destination
   *  the caller has no rights in answers 403 whether or not it exists (no team-id probing for non-owners). */
  private async requireTargetAuthority(userId: string, toTeamId: string, owner: boolean): Promise<{ id: string; name: string }> {
    if (!owner) await this.access.requirePermission(userId, toTeamId, "servers:manage");
    const team = await this.prisma.team.findUnique({ where: { id: toTeamId }, select: { id: true, name: true } });
    if (!team) throw new NotFoundException("team not found");
    return team;
  }

  /** Teams this server may move to (excludes its current team). */
  async listTargets(userId: string, serverId: string): Promise<{ id: string; name: string }[]> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, teamId: true } });
    if (!server) throw new NotFoundException("server not found");
    const owner = await this.isInstanceOwner(userId);
    await this.requireSourceAuthority(userId, server.teamId, owner);
    let ids: string[] | undefined; // undefined = every team (instance owner)
    if (!owner) {
      const perms = await this.access.permissionsByTeam(userId);
      ids = [...perms.entries()].filter(([, p]) => p.has("servers:manage")).map(([t]) => t);
    }
    const teams = await this.prisma.team.findMany({
      where: { id: { not: server.teamId, ...(ids ? { in: ids } : {}) } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return teams;
  }

  // ---- preview ---------------------------------------------------------------

  /** What a move would do: the blockers (resources of the current team on this server) and the links that get dropped. */
  async preview(userId: string, serverId: string, toTeamId: string): Promise<TransferPlan> {
    const { plan } = await this.plan(userId, serverId, toTeamId);
    return plan;
  }

  private async plan(userId: string, serverId: string, toTeamId: string) {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, name: true, teamId: true, clusterId: true, swarmRole: true, cloudCredentialId: true, dnsCredentialId: true, dnsCredsEnc: true },
    });
    if (!server) throw new NotFoundException("server not found");
    const owner = await this.isInstanceOwner(userId);
    await this.requireSourceAuthority(userId, server.teamId, owner);
    const to = await this.requireTargetAuthority(userId, toTeamId, owner);
    if (server.teamId === toTeamId) throw new BadRequestException("the server is already in this team");
    const from = await this.prisma.team.findUnique({ where: { id: server.teamId }, select: { id: true, name: true } });
    const blockers = await this.collectBlockers(this.prisma, server);
    const detaches = await this.collectDetaches(server);
    const plan: TransferPlan = {
      server: { id: server.id, name: server.name },
      from: from ?? { id: server.teamId, name: server.teamId },
      to,
      blockers,
      detaches,
      canMove: blockers.length === 0,
    };
    return { plan, server };
  }

  // ---- execute ---------------------------------------------------------------

  async transfer(userId: string, serverId: string, toTeamId: string): Promise<{ serverId: string; fromTeamId: string; toTeamId: string }> {
    const { plan, server } = await this.plan(userId, serverId, toTeamId);
    if (plan.blockers.length) throw blockedException(plan.blockers);

    try {
      await this.prisma.$transaction(
        async (tx) => {
          // Re-scan inside the transaction: a resource created since the preview must still block the move.
          const blockers = await this.collectBlockers(tx as unknown as Db, server);
          if (blockers.length) throw blockedException(blockers);
          // Guarded on the team we validated against, so two racing moves cannot both pass.
          const res = await tx.server.updateMany({
            where: { id: serverId, teamId: server.teamId },
            data: {
              teamId: toTeamId,
              clusterId: null,
              cloudCredentialId: null,
              dnsCredentialId: null,
              // The copied DNS-01 token is the old team's secret: wipe it (and the wildcard-cert policy that needs it).
              ...(server.dnsCredsEnc ? { dnsCredsEnc: null, dnsProvider: null, certMode: "http" } : {}),
            },
          });
          if (res.count !== 1) throw new ConflictException("the server changed while it was being moved — try again");
          // The auto disk monitor follows its server. The old team's alert channels cannot follow it.
          const autos = await tx.monitor.findMany({ where: { serverId, auto: true }, select: { id: true } });
          if (autos.length) {
            await tx.monitorChannel.deleteMany({ where: { monitorId: { in: autos.map((m) => m.id) } } });
            await tx.monitor.updateMany({ where: { serverId, auto: true }, data: { teamId: toTeamId } });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      // A serialization conflict means something wrote to this server's resources at the same moment.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") {
        throw new ConflictException("the server is busy — try again");
      }
      throw e;
    }

    await this.audit.log({
      actor: userId,
      action: "server.team.change",
      target: serverId,
      meta: {
        fromTeamId: server.teamId,
        toTeamId,
        ...(plan.detaches.length ? { detached: plan.detaches.map((d) => d.kind) } : {}),
      },
    });
    this.servers.emitTeamChanged(serverId);
    return { serverId, fromTeamId: server.teamId, toTeamId };
  }

  /** Many servers into one team. Each server is its own transaction: one blocked server never holds back the rest. A
   *  server the caller cannot see answers exactly like one that does not exist ("denied"). */
  async transferBulk(userId: string, serverIds: string[], toTeamId: string): Promise<{ moved: number; results: BulkTransferResult[] }> {
    const ids = [...new Set(serverIds)];
    if (ids.length === 0) throw new BadRequestException("provide at least one server");
    if (ids.length > MAX_BULK_TRANSFER) throw new BadRequestException(`at most ${MAX_BULK_TRANSFER} servers per request`);
    // Fail fast (and once) on the destination: no rights there means nothing can move.
    const owner = await this.isInstanceOwner(userId);
    await this.requireTargetAuthority(userId, toTeamId, owner);

    const results: BulkTransferResult[] = [];
    for (const serverId of ids) {
      try {
        await this.transfer(userId, serverId, toTeamId);
        results.push({ serverId, status: "moved" });
      } catch (e) {
        if (e instanceof ConflictException && (e.getResponse() as { code?: string }).code === TRANSFER_BLOCKED_CODE) {
          results.push({ serverId, status: "blocked", blockers: (e.getResponse() as { blockers: TransferBlocker[] }).blockers });
        } else if (e instanceof NotFoundException || e instanceof ForbiddenException) {
          results.push({ serverId, status: "denied" });
        } else if (e instanceof BadRequestException) {
          results.push({ serverId, status: "unchanged", message: e.message });
        } else {
          results.push({ serverId, status: "failed", message: e instanceof Error ? e.message : "failed" });
        }
      }
    }
    return { moved: results.filter((r) => r.status === "moved").length, results };
  }

  // ---- scans -----------------------------------------------------------------

  private async count(
    model: { count(a: { where: object }): Promise<number>; findMany(a: { where: object; select: { id: true; name?: true }; take: number }): Promise<{ id: string; name?: string }[]> },
    where: object,
    named = true,
  ): Promise<Counted> {
    const [count, rows] = await Promise.all([
      model.count({ where }),
      model.findMany({ where, select: named ? { id: true, name: true } : { id: true }, take: TRANSFER_BLOCKER_SAMPLE }),
    ]);
    return { count, items: rows.map((r) => ({ id: r.id, name: r.name ?? r.id })) };
  }

  /** Everything that ties this server to a resource of its current team (or to a running operation). Empty = free to move. */
  async collectBlockers(db: Db, server: { id: string; clusterId: string | null; swarmRole?: unknown }): Promise<TransferBlocker[]> {
    const id = server.id;
    const out: TransferBlocker[] = [];
    const push = (kind: TransferBlockerKind, c: Counted) => {
      if (c.count > 0) out.push({ kind, count: c.count, items: c.items });
    };

    // Apps running here (or hard-pinned here as the node of a swarm service) …
    const onServer = { OR: [{ serverId: id }, { constraintServerId: id }] };
    push("application", await this.count(db.application as never, onServer));
    // … and apps elsewhere that BUILD here (their build host would leave their team).
    push("build_server", await this.count(db.application as never, { buildServerId: id, NOT: onServer }));
    push("database", await this.count(db.database as never, { serverId: id }));
    // Hand-made monitors are the team's (they carry its alert channels); the auto disk monitor travels instead.
    push("monitor", await this.count(db.monitor as never, { serverId: id, auto: false }));

    if (server.clusterId) {
      const cluster = await db.cluster.findUnique({ where: { id: server.clusterId }, select: { id: true, name: true } });
      push("cluster", { count: 1, items: [{ id: server.clusterId, name: cluster?.name ?? server.clusterId }] });
    }

    // Same predicate the delete guard uses: a live move, or archived data a finished/failed move left on this server.
    push(
      "app_move",
      await this.count(
        db.appMove as never,
        {
          OR: [
            { phase: { notIn: APP_MOVE_TERMINAL }, OR: [{ sourceServerId: id }, { targetServerId: id }] },
            { phase: "COMPLETED", sourceServerId: id, sourcePurgedAt: null, archiveUntil: { not: null } },
            { phase: { in: ["ROLLED_BACK", "FAILED"] }, targetServerId: id, targetPurgedAt: null },
          ],
        },
        false,
      ),
    );

    const [runs, locks, objectMigrations] = await Promise.all([
      this.count(db.migrationRun as never, { targetServerId: id, status: { in: [...MIGRATION_RUN_LIVE] } }, false),
      db.migrationRunServerLock.count({ where: { serverId: id } }),
      this.count(db.objectMigration as never, { targetServerId: id, status: { notIn: OBJECT_MIGRATION_DONE } }, false),
    ]);
    const migrationCount = runs.count + locks + objectMigrations.count;
    if (migrationCount > 0) push("migration", { count: migrationCount, items: [...runs.items, ...objectMigrations.items] });

    push("reboot", await this.count(db.serverReboot as never, { serverId: id, state: { not: "DONE" } }, false));

    // A Cloudflare tunnel holds the old team's API token + tunnel token and a DNS record in its zone: release it first.
    push("tunnel", await this.count(db.serverTunnel as never, { serverId: id }, false));
    // Server-wide log drains (appId null) ship this host's logs to the old team's endpoint with its auth token.
    // (App-scoped drains belong to apps, which already block.)
    push("log_drain", await this.count(db.logDrain as never, { serverId: id, appId: null }));
    // Legacy importer tasks still queued/running here could create old-team apps or databases after the move.
    push("bulk_task", await this.count(db.bulkTask as never, { serverId: id, status: { in: ["PENDING", "RUNNING"] }, kind: { not: "command" } }, false));
    return out;
  }

  private async collectDetaches(server: {
    id: string;
    cloudCredentialId: string | null;
    dnsCredentialId: string | null;
    dnsCredsEnc?: string | null;
  }): Promise<TransferDetach[]> {
    const out: TransferDetach[] = [];
    if (server.cloudCredentialId) {
      const c = await this.prisma.cloudCredential.findUnique({ where: { id: server.cloudCredentialId }, select: { name: true } });
      out.push({ kind: "cloud_credential", ...(c ? { name: c.name } : {}) });
    }
    if (server.dnsCredentialId) {
      const c = await this.prisma.dnsCredential.findUnique({ where: { id: server.dnsCredentialId }, select: { name: true } });
      out.push({ kind: "dns_credential", ...(c ? { name: c.name } : {}) });
    }
    if (server.dnsCredsEnc) out.push({ kind: "dns_secret" });
    const channelLinks = await this.prisma.monitorChannel.count({ where: { monitor: { serverId: server.id, auto: true } } });
    if (channelLinks > 0) out.push({ kind: "alert_channels", count: channelLinks });
    return out;
  }
}
