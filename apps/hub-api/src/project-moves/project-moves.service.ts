import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, Role, type ProjectMove } from "@prisma/client";
import type { ProjectMoveItemView, ProjectMovePhase, ProjectMoveView } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AppMovesService } from "../app-moves/app-moves.service";
import { DatabasesService } from "../databases/databases.service";
import { supportsBackup, type DbEngine } from "../databases/database-script";
import { planProjectMove, resolveSource, type Plan, type PlanApp, type PlanDb } from "./project-move-plan";
import { ProjectMoveRunnerService } from "./project-move-runner.service";
import { parseItems, parsePlan, type StoredPlan } from "./project-move-state";
import type { PreviewProjectMoveInput, StartProjectMoveInput } from "./dto";

const NON_TERMINAL = ["QUEUED", "PRECHECK", "MOVING", "VERIFYING", "CUTOVER", "ROLLING_BACK"];
const CANCELLABLE = ["QUEUED", "PRECHECK", "MOVING"];
const PREFLIGHT_CONCURRENCY = 3;

export interface ProjectMovePreview extends Plan {
  projectName: string;
  targetServerId: string;
}

const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, message, code, ...extra });

/**
 * Move a project and everything under it (applications, databases, compose services, their volumes and domains) from one Tugra server to
 * another (lane H). Team OWNER only; every privileged step is audited. The preview changes nothing; start re-runs it and refuses when any
 * blocker is left. The work is the runner's; this service authorizes, plans, records and reports.
 */
@Injectable()
export class ProjectMovesService {
  private readonly log = new Logger(ProjectMovesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly appMoves: AppMovesService,
    private readonly databases: DatabasesService,
    private readonly runner: ProjectMoveRunnerService,
  ) {}

  // ───────────────────────────── authorization ─────────────────────────────

  private async loadProject(projectId: string) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, teamId: true } });
    if (!p) throw new NotFoundException("project not found");
    return p;
  }

  private async requireOwner(userId: string, teamId: string, projectId: string): Promise<void> {
    if ((await this.access.teamRole(userId, teamId)) !== Role.OWNER) throw new ForbiddenException("only a team owner can move a project");
    await this.access.requireProjectAccess(userId, teamId, projectId);
  }

  private async requireMember(userId: string, teamId: string, projectId: string): Promise<void> {
    if (!(await this.access.teamRole(userId, teamId))) throw new ForbiddenException("not a member of this team");
    await this.access.requireProjectAccess(userId, teamId, projectId);
  }

  // ───────────────────────────── preview ─────────────────────────────

  /** POST preview: read-only. Probes the agents through the apps' own preflights but changes nothing. */
  async preview(userId: string, input: PreviewProjectMoveInput): Promise<ProjectMovePreview> {
    const project = await this.loadProject(input.projectId);
    await this.requireOwner(userId, project.teamId, project.id);
    return this.compute(userId, project, input);
  }

  private async compute(userId: string, project: { id: string; name: string; teamId: string }, input: PreviewProjectMoveInput): Promise<ProjectMovePreview> {
    // A target in another team is "not found": no oracle for other teams' servers.
    const target = await this.prisma.server.findUnique({ where: { id: input.targetServerId } });
    if (!target || target.teamId !== project.teamId) throw new NotFoundException("server not found");

    const envs = await this.prisma.environment.findMany({ where: { projectId: project.id }, select: { id: true } });
    const envIds = envs.map((e) => e.id);
    const [appRows, dbRows] = await Promise.all([
      this.prisma.application.findMany({ where: { environmentId: { in: envIds }, teamId: project.teamId, isPreview: false }, select: { id: true, name: true, serverId: true, status: true } }),
      this.prisma.database.findMany({
        where: { environmentId: { in: envIds }, teamId: project.teamId },
        select: { id: true, name: true, engine: true, serverId: true, status: true, backupDestinationId: true, volumes: true, pitrEnabled: true },
      }),
    ]);
    const appIds = appRows.map((a) => a.id);
    const dbIds = dbRows.map((d) => d.id);
    const links = await this.prisma.appDatabaseLink.findMany({ where: { OR: [{ appId: { in: appIds } }, { databaseId: { in: dbIds } }] }, select: { appId: true, databaseId: true } });
    const apps: PlanApp[] = appRows.map((a) => ({ id: a.id, name: a.name, serverId: a.serverId, status: a.status, linkedDbIds: links.filter((l) => l.appId === a.id).map((l) => l.databaseId) }));
    const dbs: PlanDb[] = dbRows.map((d) => ({
      id: d.id,
      name: d.name,
      engine: d.engine,
      serverId: d.serverId,
      status: d.status,
      backupDestinationId: d.backupDestinationId,
      extraVolumes: Array.isArray(d.volumes) ? d.volumes.length : 0,
      pitrEnabled: d.pitrEnabled,
      outsideLinkedApps: links.filter((l) => l.databaseId === d.id && !appIds.includes(l.appId)).map((l) => l.appId),
    }));

    const source = resolveSource(input.sourceServerId, apps, dbs);
    const sourceServer = source.serverId ? await this.prisma.server.findUnique({ where: { id: source.serverId }, select: { id: true, teamId: true, status: true } }) : null;
    if (source.serverId && (!sourceServer || sourceServer.teamId !== project.teamId)) throw new NotFoundException("server not found");

    const active = await this.prisma.projectMove.findFirst({ where: { projectId: project.id, phase: { in: NON_TERMINAL } }, select: { id: true } });
    const activeMoves = await this.prisma.appMove.findMany({ where: { appId: { in: appIds }, phase: { notIn: ["COMPLETED", "ROLLED_BACK", "FAILED"] } }, select: { appId: true } });

    const moving = apps.filter((a) => a.serverId === source.serverId);
    const appPreflight: Record<string, string[]> = {};
    // Each app's own move preflight (probes both agents; changes nothing), a few at a time.
    for (let i = 0; i < moving.length; i += PREFLIGHT_CONCURRENCY) {
      await Promise.all(
        moving.slice(i, i + PREFLIGHT_CONCURRENCY).map(async (a) => {
          if (!source.serverId || source.serverId === target.id) return;
          try {
            const r = await this.appMoves.preflight(userId, a.id, { targetServerId: target.id, acknowledge: input.acknowledge, probeLink: false });
            appPreflight[a.id] = r.blockers.map((b) => b.code);
          } catch (e) {
            if (e instanceof ForbiddenException) throw e;
            appPreflight[a.id] = ["preflight_unavailable"];
          }
        }),
      );
    }

    const plan = planProjectMove({
      sourceServerId: source.serverId,
      targetServerId: target.id,
      apps,
      dbs,
      agentOnline: { source: source.serverId ? this.agentWs.isOnline(source.serverId) : true, target: this.agentWs.isOnline(target.id) },
      serversReady: { source: sourceServer ? sourceServer.status === "ONLINE" : true, target: target.status === "ONLINE" },
      backupEngines: new Set(dbs.map((d) => d.engine).filter((e) => supportsBackup(e as DbEngine))),
      activeProjectMove: !!active,
      appPreflight,
      appsWithActiveMove: new Set(activeMoves.map((m) => m.appId)),
    });
    if (source.several && !plan.blockers.some((b) => b.code === "items_on_several_servers")) plan.blockers.push({ code: "items_on_several_servers" });
    return { ...plan, projectName: project.name, targetServerId: target.id };
  }

  // ───────────────────────────── start ─────────────────────────────

  async start(userId: string, input: StartProjectMoveInput): Promise<{ moveId: string; phase: "QUEUED" }> {
    const project = await this.loadProject(input.projectId);
    await this.requireOwner(userId, project.teamId, project.id);
    if (input.confirmName !== project.name) throw new BadRequestException({ statusCode: 400, message: "type the project's exact name to confirm the move", code: "confirm_name_mismatch" });
    const plan = await this.compute(userId, project, input);
    if (plan.blockers.length) throw conflict("preflight_failed", "the move cannot start: the preview has blockers", { blockers: plan.blockers });
    const target = await this.prisma.server.findUnique({ where: { id: input.targetServerId }, select: { publicIp: true } });

    const stored: StoredPlan = {
      v: 1,
      acks: input.acknowledge,
      repointDns: input.repointDns,
      confirmName: project.name,
      dbs: Object.fromEntries(plan.items.filter((i) => i.kind === "database").map((i) => [i.refId, { stage: "pending" as const, configOnly: i.configOnly, oldName: i.name }])),
      apps: Object.fromEntries(plan.items.filter((i) => i.kind === "application").map((i) => [i.refId, { stage: "pending" as const, links: [], hadDbNetwork: false, wasRunning: false }])),
      frozen: [],
      targetIp: target?.publicIp ?? null,
      warnings: plan.warnings.map((w) => (w.ref ? `${w.code}:${w.ref}` : w.code)),
    };
    const items: ProjectMoveItemView[] = plan.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, childId: null, phase: "pending", tempAddress: null }));

    const row: ProjectMove = await this.prisma.$transaction(
        async (tx) => {
          // One live move per project: the project row is the lock.
          await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${project.id} FOR UPDATE`;
          const busy = await tx.projectMove.findFirst({ where: { projectId: project.id, phase: { in: NON_TERMINAL } }, select: { id: true } });
          if (busy) throw conflict("project_move_active", "this project already has a move in progress");
          return tx.projectMove.create({
            data: {
              teamId: project.teamId,
              actorId: userId,
              projectId: project.id,
              sourceServerId: plan.sourceServerId!,
              targetServerId: plan.targetServerId,
              plan: stored as unknown as Prisma.InputJsonValue,
              items: items as unknown as Prisma.InputJsonValue,
              retainDays: input.retainDays,
              repointDns: input.repointDns,
            },
          });
        },
        { timeout: 15_000 },
      );
    await this.audit.log({
      actor: userId,
      action: "project.move.start",
      target: project.id,
      meta: { moveId: row.id, from: plan.sourceServerId, to: plan.targetServerId, applications: items.filter((i) => i.kind === "application").length, databases: items.filter((i) => i.kind === "database").length, retainDays: input.retainDays },
    });
    void this.runner.run(row.id).catch((e: unknown) => this.log.error(`project move run failed: ${e instanceof Error ? e.constructor.name : "unknown"}`));
    return { moveId: row.id, phase: "QUEUED" };
  }

  // ───────────────────────────── read ─────────────────────────────

  async get(userId: string, id: string): Promise<ProjectMoveView> {
    const row = await this.loadRow(id);
    await this.requireMember(userId, row.teamId, row.projectId);
    return this.toView(row);
  }

  async list(userId: string, projectId: string): Promise<ProjectMoveView[]> {
    const project = await this.loadProject(projectId);
    await this.requireMember(userId, project.teamId, project.id);
    const rows = await this.prisma.projectMove.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 20 });
    return rows.map((r) => this.toView(r));
  }

  // ───────────────────────────── cancel and purge ─────────────────────────────

  /** Before any app has moved the move can be stopped (it rolls back by itself); afterwards it rolls forward or fails. */
  async cancel(userId: string, id: string): Promise<void> {
    const row = await this.loadRow(id);
    await this.requireOwner(userId, row.teamId, row.projectId);
    if (!CANCELLABLE.includes(row.phase)) throw conflict("move_not_cancellable", "this move can no longer be cancelled");
    const won = await this.prisma.projectMove.updateMany({ where: { id, phase: { in: CANCELLABLE } }, data: { cancelRequested: true } });
    if (won.count !== 1) throw conflict("move_not_cancellable", "this move can no longer be cancelled");
    await this.audit.log({ actor: userId, action: "project.move.cancel", target: row.projectId, meta: { moveId: id, phase: row.phase } });
  }

  /**
   * Remove the safety copy of a COMPLETED move now: the old databases that were set aside (only when stopped and used by nothing) and the
   * apps' archived source volumes. Returns how many databases were removed.
   */
  async purgeSafetyCopy(userId: string, id: string): Promise<{ removed: number; kept: number }> {
    const row = await this.loadRow(id);
    await this.requireOwner(userId, row.teamId, row.projectId);
    if (row.phase !== "COMPLETED") throw conflict("move_not_completed", "only a completed move has a safety copy");
    const plan = parsePlan(row.plan);
    if (plan.safetyPurged) throw conflict("nothing_to_purge", "the safety copy was already removed");
    const out = await this.purge(userId, row, plan);
    await this.audit.log({ actor: userId, action: "project.move.purge", target: row.projectId, meta: { moveId: id, ...out } });
    return out;
  }

  private async purge(userId: string, row: ProjectMove, plan: StoredPlan): Promise<{ removed: number; kept: number }> {
    let removed = 0;
    let kept = 0;
    for (const [sourceId, st] of Object.entries(plan.dbs)) {
      if (!st.setAside) continue;
      const db = await this.prisma.database.findUnique({ where: { id: sourceId }, select: { id: true, status: true } });
      if (!db) continue;
      const used = await this.prisma.appDatabaseLink.count({ where: { databaseId: sourceId } });
      if (db.status !== "STOPPED" || used > 0) {
        kept++;
        continue;
      }
      await this.databases.remove(userId, sourceId, { keepVolume: false });
      removed++;
    }
    for (const [appId, a] of Object.entries(plan.apps)) {
      if (!a.moveId) continue;
      await this.appMoves.purgeSource(userId, appId, a.moveId).catch(() => undefined); // the app move's own archive; its sweeper retries
    }
    plan.safetyPurged = true;
    await this.prisma.projectMove.update({ where: { id: row.id }, data: { plan: plan as unknown as Prisma.InputJsonValue } });
    return { removed, kept };
  }

  /** Hourly: remove the safety copy of moves whose retention has passed. Never touches a move whose owner is no longer an owner. */
  async purgeDue(now = new Date()): Promise<string[]> {
    const due = await this.prisma.projectMove.findMany({ where: { phase: "COMPLETED", archiveUntil: { lt: now } }, take: 50 });
    const done: string[] = [];
    for (const row of due) {
      const plan = parsePlan(row.plan);
      if (plan.safetyPurged) continue;
      if ((await this.access.teamRole(row.actorId, row.teamId)) !== Role.OWNER) continue;
      try {
        await this.purge(row.actorId, row, plan);
        await this.audit.log({ actor: "system", action: "project.move.purge", target: row.projectId, meta: { moveId: row.id, due: true } });
        done.push(row.id);
      } catch (e) {
        this.log.warn(`safety copy purge failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
      }
    }
    return done;
  }

  // ───────────────────────────── view ─────────────────────────────

  private async loadRow(id: string): Promise<ProjectMove> {
    const row = await this.prisma.projectMove.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("move not found");
    return row;
  }

  toView(row: ProjectMove): ProjectMoveView {
    const plan = parsePlan(row.plan);
    return {
      id: row.id,
      projectId: row.projectId,
      sourceServerId: row.sourceServerId,
      targetServerId: row.targetServerId,
      phase: row.phase as ProjectMovePhase,
      items: parseItems(row.items),
      retainDays: row.retainDays,
      archiveUntil: row.archiveUntil?.toISOString() ?? null,
      failureCode: row.failureReason,
      report: plan.report ?? null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}
