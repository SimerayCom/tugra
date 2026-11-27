import { Injectable } from "@nestjs/common";
import type { VolumeTransferState } from "@prisma/client";
import { APP_MOVE_ACTIVE_PHASES } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TERMINAL_RUN_STATUSES } from "../migration-runs/core/run-contract";
import type { InFlightItem } from "./in-flight.dto";
import { InFlightRegistry } from "./in-flight.registry";

/** Takeover states in which the hub or the agent is acting on the box, or Tugra's proxy owns the ports but Coolify's certificates are not replaced yet. PLANNED (nothing started), VERIFIED (settled) and the ended ones are not in flight. */
export const TAKEOVER_ACTIVE = ["TESTING", "SWAPPING", "SWAPPED", "GIVING_BACK"];
/** A cleanup that is checking or removing. The cleanup service treats a row untouched for this long as abandoned. */
export const CLEANUP_ACTIVE = ["CHECKING", "CLEANING"];
export const CLEANUP_STALE_MS = 15 * 60_000;
/** A flip run beats its heartbeat every few seconds; the cutover service calls a run dead after 90 s. */
export const CUTOVER_ALIVE_MS = 90_000;
export const PROJECT_MOVE_ACTIVE = ["QUEUED", "PRECHECK", "MOVING", "VERIFYING", "CUTOVER", "ROLLING_BACK"];
/** A streamed volume copy that has begun and is not finished (PENDING has not started). */
export const VOLUME_TRANSFER_ACTIVE: VolumeTransferState[] = ["COPYING", "COPIED", "APPLYING"];
export const OBJECT_MIGRATION_ACTIVE = ["SEEDING", "FINALIZING", "VERIFYING"];
/** Import tasks that are queued or running. AWAITING_CUTOVER (staged, waiting for the owner's cutover step) is not running. */
export const IMPORT_TASK_ACTIVE = ["PENDING", "RUNNING"] as const;
/** Deploys waiting for the app's running deploy (QUEUED) and the ones running. */
export const DEPLOYMENT_ACTIVE = ["QUEUED", "RUNNING"] as const;
/** Backups, restores and drills write RUNNING when they start (PENDING is never written by a runner). */
export const RUN_ACTIVE = ["RUNNING"] as const;
export const ROLLOUT_ACTIVE = ["RUNNING", "ROLLING_BACK"] as const;
/** A rollout target the rollout still has to act on (a deploy not started, a deploy running, a revert). HALTED rollouts wait for the operator and change nothing. */
export const ROLLOUT_TARGET_ACTIVE = ["PENDING", "DEPLOYING", "REVERTING"] as const;
/** SCHEDULED reboots are for later and not counted; the rest have started. */
export const REBOOT_ACTIVE = ["STARTING", "REBOOTING", "WAITING_AGENT", "VERIFYING"];
/** Swarm statuses the swarm service uses as a busy marker while it forms, joins a node, removes a node or tears the swarm down. */
export const SWARM_BUSY = ["FORMING", "JOINING", "DISSOLVING"] as const;
export const AGENT_UPDATE_ACTION = "agent.update.request";

/**
 * Rows that say RUNNING but are older than this are leftovers of a crash (the runners' own reapers use the same idea, 2x their timeouts):
 * they would hold every update forever, so they are not counted.
 */
export const ORPHAN_MS = {
  /** backups, restores, restore drills, hub backups: the longest runner timeout is 1 h */
  runner: 2 * 3_600_000,
  /** a point-in-time restore may replay for hours (the PITR service itself waits 14 h before it calls one orphaned) */
  pitr: 14 * 3_600_000,
  deployment: 6 * 3_600_000,
  reboot: 6 * 3_600_000,
  swarm: 2 * 3_600_000,
  import: 24 * 3_600_000,
  bulk: 3_600_000,
  /** an agent update the hub sent, until the agent comes back on the new version (the rollout service waits 10 min) */
  agentUpdate: 10 * 60_000,
} as const;

const iso = (d: Date | null | undefined, fallback: Date): string => (d ?? fallback).toISOString();
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const uniq = (xs: (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];
const ago = (now: number, ms: number): Date => new Date(now - ms);

/**
 * "What is running right now that an update must not interrupt", hub-wide and per server. One read over every source:
 * migration runs, Coolify takeovers, DNS cutovers, project and app moves, volume and object transfers, Coolify cleanups, import applies,
 * deployments, backups (database, base, volume, hub), restores, PITR restores and restore drills, staged rollouts, agent updates that have not
 * settled, swarm operations, server patches, reboots and fleet commands. Only work that has started or is queued to start now counts; anything
 * scheduled for later does not. Read-only: it never changes a row. A row that belongs to a bigger item already in the list (a takeover or a
 * volume transfer or an import a migration run carries, an app move a project move carries) is not listed twice.
 */
@Injectable()
export class InFlightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: InFlightRegistry,
  ) {}

  /** Everything in flight on the hub, oldest first. */
  async list(): Promise<InFlightItem[]> {
    const now = Date.now();
    const p = this.prisma;
    const [runs, takeovers, cleanups, cutovers, projectMoves, appMoves, transfers, objects] = await Promise.all([
      p.migrationRun.findMany({
        where: { dryRun: false, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
        select: {
          id: true,
          teamId: true,
          status: true,
          targetServerId: true,
          serverMap: true,
          agentServerId: true,
          sourceKind: true,
          sourceHost: true,
          opId: true,
          opHistory: true,
          startedAt: true,
          createdAt: true,
          steps: { select: { status: true } },
        },
      }),
      p.coolifyTakeover.findMany({ where: { status: { in: TAKEOVER_ACTIVE } }, select: { id: true, teamId: true, serverId: true, runId: true, createdAt: true } }),
      p.coolifyCleanup.findMany({ where: { status: { in: CLEANUP_ACTIVE }, updatedAt: { gt: ago(now, CLEANUP_STALE_MS) } }, select: { id: true, teamId: true, serverId: true, createdAt: true } }),
      p.cutoverRun.findMany({ where: { status: "running", activeKey: { not: null }, heartbeatAt: { gt: ago(now, CUTOVER_ALIVE_MS) } }, select: { id: true, opId: true, startedAt: true } }),
      p.projectMove.findMany({ where: { phase: { in: PROJECT_MOVE_ACTIVE } }, select: { id: true, teamId: true, sourceServerId: true, targetServerId: true, items: true, startedAt: true, createdAt: true } }),
      p.appMove.findMany({ where: { phase: { in: [...APP_MOVE_ACTIVE_PHASES] } }, select: { id: true, teamId: true, appName: true, sourceServerId: true, targetServerId: true, startedAt: true, createdAt: true } }),
      p.migrationVolumeTransfer.findMany({ where: { state: { in: VOLUME_TRANSFER_ACTIVE } }, select: { id: true, opId: true, itemRef: true, targetServerId: true, startedAt: true, createdAt: true } }),
      p.objectMigration.findMany({ where: { status: { in: OBJECT_MIGRATION_ACTIVE } }, select: { id: true, teamId: true, name: true, targetServerId: true, createdAt: true } }),
    ]);
    const [imports, deployments, dbBackups, baseBackups, volBackups, hubBackups, restores, drills, rollouts, agentRequests, clusters, reboots, bulkOps] = await Promise.all([
      p.bulkOperation.findMany({
        where: { kind: "import", createdAt: { gt: ago(now, ORPHAN_MS.import) }, tasks: { some: { status: { in: [...IMPORT_TASK_ACTIVE] } } } },
        select: { id: true, meta: true, createdAt: true, tasks: { where: { status: { in: [...IMPORT_TASK_ACTIVE] } }, select: { serverId: true } } },
      }),
      p.deployment.findMany({
        where: { status: { in: [...DEPLOYMENT_ACTIVE] }, createdAt: { gt: ago(now, ORPHAN_MS.deployment) } },
        select: { id: true, runServerId: true, startedAt: true, createdAt: true, application: { select: { name: true, serverId: true, buildServerId: true, teamId: true } } },
      }),
      p.backup.findMany({ where: { status: { in: [...RUN_ACTIVE] }, createdAt: { gt: ago(now, ORPHAN_MS.runner) } }, select: { id: true, createdAt: true, database: { select: { name: true, serverId: true, teamId: true } } } }),
      p.baseBackup.findMany({ where: { status: { in: [...RUN_ACTIVE] }, createdAt: { gt: ago(now, ORPHAN_MS.runner) } }, select: { id: true, createdAt: true, database: { select: { name: true, serverId: true, teamId: true } } } }),
      p.volumeBackup.findMany({ where: { status: { in: [...RUN_ACTIVE] }, createdAt: { gt: ago(now, ORPHAN_MS.runner) } }, select: { id: true, createdAt: true, volumeName: true, app: { select: { name: true, serverId: true, teamId: true } } } }),
      p.hubBackup.findMany({ where: { status: { in: [...RUN_ACTIVE] }, createdAt: { gt: ago(now, ORPHAN_MS.runner) } }, select: { id: true, createdAt: true } }),
      p.restore.findMany({
        where: { status: { in: [...RUN_ACTIVE] }, createdAt: { gt: ago(now, ORPHAN_MS.pitr) } },
        select: { id: true, kind: true, createdAt: true, targetDatabaseId: true, database: { select: { name: true, serverId: true, teamId: true } } },
      }),
      p.hubBackupDrill.findMany({ where: { status: "RUNNING", createdAt: { gt: ago(now, ORPHAN_MS.runner) } }, select: { id: true, createdAt: true } }),
      p.rollout.findMany({
        where: { status: { in: [...ROLLOUT_ACTIVE] } },
        select: { id: true, teamId: true, name: true, createdAt: true, targets: { where: { active: true, status: { in: [...ROLLOUT_TARGET_ACTIVE] } }, select: { serverId: true } } },
      }),
      p.auditLog.findMany({ where: { action: AGENT_UPDATE_ACTION, createdAt: { gt: ago(now, ORPHAN_MS.agentUpdate) } }, select: { id: true, target: true, createdAt: true, meta: true } }),
      p.cluster.findMany({ where: { swarmStatus: { in: [...SWARM_BUSY] }, updatedAt: { gt: ago(now, ORPHAN_MS.swarm) } }, select: { id: true, name: true, teamId: true, updatedAt: true, servers: { select: { id: true } } } }),
      p.serverReboot.findMany({ where: { state: { in: REBOOT_ACTIVE }, createdAt: { gt: ago(now, ORPHAN_MS.reboot) } }, select: { id: true, serverId: true, startedAt: true, createdAt: true } }),
      p.bulkOperation.findMany({
        where: { kind: "command", createdAt: { gt: ago(now, ORPHAN_MS.bulk) }, tasks: { some: { status: { in: ["PENDING", "RUNNING"] } } } },
        select: { id: true, createdAt: true, tasks: { where: { status: { in: ["PENDING", "RUNNING"] } }, select: { serverId: true } } },
      }),
    ]);

    // A real run counts once it has started. A run still QUEUED was created but never started: it holds a server lock
    // and nothing else (start flips it to RUNNING), so it is not in flight unless a step already moved.
    const liveRuns = runs.filter((r) => r.status !== "QUEUED" || r.startedAt !== null || r.steps.some((s) => s.status !== "PENDING"));
    const runIds = new Set(liveRuns.map((r) => r.id));
    const runOps = new Set(liveRuns.flatMap((r) => [r.opId, ...r.opHistory]).filter((x): x is string => !!x));
    const carriedMoves = new Set(
      projectMoves.flatMap((pm) => (Array.isArray(pm.items) ? (pm.items as { childId?: unknown }[]).map((i) => i?.childId).filter((c): c is string => typeof c === "string") : [])),
    );

    // Cutover runs reach servers and teams through the apps of their import operation.
    const cutoverDomains = cutovers.length
      ? await p.cutoverDomain.findMany({ where: { opId: { in: cutovers.map((c) => c.opId) } }, select: { opId: true, application: { select: { serverId: true, teamId: true } } } })
      : [];

    // An agent update the hub sent counts until the agent reports the version it was sent.
    const agentTargets = uniq(agentRequests.map((r) => r.target));
    const agentServers = agentTargets.length ? await p.server.findMany({ where: { id: { in: agentTargets } }, select: { id: true, agentVersion: true } }) : [];
    const agentVersionOf = new Map(agentServers.map((s) => [s.id, s.agentVersion]));

    const restoreTargets = uniq(restores.map((r) => r.targetDatabaseId));
    const restoreTargetServers = restoreTargets.length ? await p.database.findMany({ where: { id: { in: restoreTargets } }, select: { id: true, serverId: true } }) : [];
    const targetServerOf = new Map(restoreTargetServers.map((d) => [d.id, d.serverId]));

    // Names and teams of servers that rows only know by id.
    const serverIds = uniq([
      ...takeovers.map((t) => t.serverId),
      ...cleanups.map((c) => c.serverId),
      ...transfers.map((t) => t.targetServerId),
      ...liveRuns.map((r) => r.targetServerId),
      ...reboots.map((r) => r.serverId),
      ...agentTargets,
      ...imports.flatMap((o) => [(o.meta as { serverId?: string } | null)?.serverId, ...o.tasks.map((t) => t.serverId)]),
      ...bulkOps.flatMap((o) => o.tasks.map((t) => t.serverId)),
    ]);
    const servers = serverIds.length ? await p.server.findMany({ where: { id: { in: serverIds } }, select: { id: true, name: true, teamId: true } }) : [];
    const serverById = new Map(servers.map((s) => [s.id, s]));
    const nameOf = (id: string): string => serverById.get(id)?.name ?? id;
    const teamOfServers = (ids: string[]): string | null => {
      const teams = uniq(ids.map((i) => serverById.get(i)?.teamId));
      return teams.length === 1 ? teams[0] : null;
    };

    const items: InFlightItem[] = [];

    for (const r of liveRuns) {
      const mapped = r.serverMap && typeof r.serverMap === "object" && !Array.isArray(r.serverMap) ? Object.values(r.serverMap as Record<string, unknown>) : [];
      items.push({
        kind: "migration-run",
        id: r.id,
        label: r.sourceHost || r.sourceKind,
        serverIds: uniq([r.targetServerId, ...strings(mapped), r.agentServerId]),
        teamId: r.teamId,
        since: iso(r.startedAt, r.createdAt),
      });
    }
    for (const t of takeovers) {
      if (t.runId && runIds.has(t.runId)) continue; // carried by a run already listed
      items.push({ kind: "takeover", id: t.id, label: nameOf(t.serverId), serverIds: [t.serverId], teamId: t.teamId, since: iso(null, t.createdAt) });
    }
    for (const c of cleanups) {
      items.push({ kind: "cleanup", id: c.id, label: nameOf(c.serverId), serverIds: [c.serverId], teamId: c.teamId, since: iso(null, c.createdAt) });
    }
    for (const c of cutovers) {
      const apps = cutoverDomains.filter((d) => d.opId === c.opId).map((d) => d.application);
      const teams = uniq(apps.map((a) => a.teamId));
      items.push({ kind: "cutover", id: c.id, label: c.opId, serverIds: uniq(apps.map((a) => a.serverId)), teamId: teams.length === 1 ? teams[0] : null, since: c.startedAt.toISOString() });
    }
    for (const pm of projectMoves) {
      items.push({ kind: "project-move", id: pm.id, label: pm.id, serverIds: uniq([pm.sourceServerId, pm.targetServerId]), teamId: pm.teamId, since: iso(pm.startedAt, pm.createdAt) });
    }
    for (const m of appMoves) {
      if (carriedMoves.has(m.id)) continue; // a member of a project move already listed
      items.push({ kind: "app-move", id: m.id, label: m.appName, serverIds: uniq([m.sourceServerId, m.targetServerId]), teamId: m.teamId, since: iso(m.startedAt, m.createdAt) });
    }
    for (const t of transfers) {
      if (runOps.has(t.opId)) continue; // carried by a run already listed
      items.push({ kind: "volume-transfer", id: t.id, label: t.itemRef, serverIds: [t.targetServerId], teamId: serverById.get(t.targetServerId)?.teamId ?? null, since: iso(t.startedAt, t.createdAt) });
    }
    for (const o of objects) {
      items.push({ kind: "object-migration", id: o.id, label: o.name, serverIds: uniq([o.targetServerId]), teamId: o.teamId, since: iso(null, o.createdAt) });
    }
    for (const o of imports) {
      if (runOps.has(o.id)) continue; // the import step of a run already listed
      const meta = (o.meta ?? {}) as { serverId?: string; sourceKind?: string };
      const ids = uniq([meta.serverId, ...o.tasks.map((t) => t.serverId)]);
      items.push({ kind: "import", id: o.id, label: meta.sourceKind ?? o.id, serverIds: ids, teamId: teamOfServers(ids), since: iso(null, o.createdAt) });
    }
    for (const d of deployments) {
      const a = d.application;
      items.push({ kind: "deployment", id: d.id, label: a.name, serverIds: uniq([d.runServerId ?? a.serverId, a.buildServerId]), teamId: a.teamId, since: iso(d.startedAt, d.createdAt) });
    }
    for (const b of [...dbBackups, ...baseBackups]) {
      items.push({ kind: "backup", id: b.id, label: b.database.name, serverIds: [b.database.serverId], teamId: b.database.teamId, since: iso(null, b.createdAt) });
    }
    for (const b of volBackups) {
      items.push({ kind: "backup", id: b.id, label: `${b.app.name}:${b.volumeName}`, serverIds: [b.app.serverId], teamId: b.app.teamId, since: iso(null, b.createdAt) });
    }
    for (const b of hubBackups) {
      items.push({ kind: "backup", id: b.id, label: "hub", serverIds: [], teamId: null, since: iso(null, b.createdAt) });
    }
    for (const r of restores) {
      const pitr = r.kind === "PITR";
      if (!pitr && r.createdAt.getTime() < now - ORPHAN_MS.runner) continue; // only a point-in-time replay runs for hours
      const target = r.targetDatabaseId ? targetServerOf.get(r.targetDatabaseId) : null;
      items.push({
        kind: pitr ? "pitr-restore" : r.kind === "VERIFY" ? "restore-verify" : "restore",
        id: r.id,
        label: r.database.name,
        serverIds: uniq([r.database.serverId, target]),
        teamId: r.database.teamId,
        since: iso(null, r.createdAt),
      });
    }
    for (const d of drills) {
      items.push({ kind: "restore-verify", id: d.id, label: "hub", serverIds: [], teamId: null, since: iso(null, d.createdAt) });
    }
    for (const r of rollouts) {
      items.push({ kind: "rollout", id: r.id, label: r.name || r.id, serverIds: uniq(r.targets.map((t) => t.serverId)), teamId: r.teamId, since: iso(null, r.createdAt) });
    }
    for (const r of agentRequests) {
      const to = (r.meta as { to?: string } | null)?.to;
      if (!r.target || !to || agentVersionOf.get(r.target) === to) continue; // the agent is back on the version it was sent
      items.push({ kind: "agent-update", id: r.id, label: nameOf(r.target), serverIds: [r.target], teamId: serverById.get(r.target)?.teamId ?? null, since: iso(null, r.createdAt) });
    }
    for (const c of clusters) {
      items.push({ kind: "swarm", id: c.id, label: c.name, serverIds: c.servers.map((s) => s.id), teamId: c.teamId, since: iso(null, c.updatedAt) });
    }
    for (const r of reboots) {
      items.push({ kind: "reboot", id: r.id, label: nameOf(r.serverId), serverIds: [r.serverId], teamId: serverById.get(r.serverId)?.teamId ?? null, since: iso(r.startedAt, r.createdAt) });
    }
    for (const o of bulkOps) {
      const ids = uniq(o.tasks.map((t) => t.serverId));
      items.push({ kind: "bulk-command", id: o.id, label: o.id, serverIds: ids, teamId: teamOfServers(ids), since: iso(null, o.createdAt) });
    }
    // Work that only exists in this process (a server patch, a swarm promote or ingress change).
    items.push(...this.registry.snapshot());

    return items.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
  }

  /** The in-flight items that touch at least one of `serverIds`. */
  async listForServers(serverIds: readonly string[]): Promise<InFlightItem[]> {
    const wanted = new Set(serverIds);
    return (await this.list()).filter((i) => i.serverIds.some((s) => wanted.has(s)));
  }

  /** Group a list by server: `serverId -> the items that touch it`. Only servers in `serverIds` get an entry (when they have items). */
  static byServer(items: readonly InFlightItem[], serverIds: readonly string[]): Map<string, InFlightItem[]> {
    const out = new Map<string, InFlightItem[]>();
    for (const id of serverIds) {
      const hit = items.filter((i) => i.serverIds.includes(id));
      if (hit.length) out.set(id, hit);
    }
    return out;
  }
}
