import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type Application, type AppMove, type Server } from "@prisma/client";
import { APP_MOVE_TERMINAL_PHASES } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { MovePreflightService } from "./move-preflight.service";
import { AppMoveRunnerService } from "./app-move-runner.service";
import { purgeMoveSource, retryTargetCleanup, type PurgeOutcome } from "./app-move-archive";
import type { StoredVolume } from "./move-types";
import type { AppMoveView, MoveAppPreflightInput, MoveAppPreflightResult, StartAppMoveInput } from "./dto";

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function parseExtraPorts(raw: unknown): { hostPort: number }[] {
  return asArray<{ hostPort?: unknown }>(raw).filter((p) => p && typeof p.hostPort === "number") as { hostPort: number }[];
}

@Injectable()
export class AppMovesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly preflights: MovePreflightService,
    private readonly runner: AppMoveRunnerService,
    private readonly agentWs: AgentWsServer,
  ) {}

  // ───────────────────────────── authorization ─────────────────────────────

  /** Preflight / start / cancel / purge: apps:config AND apps:deploy AND backups (a move edits config, redeploys and
   *  copies volume data) plus the caller's per-resource scoping. */
  async authorizeMutate(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, "apps:config");
    await this.access.requirePermission(userId, app.teamId, "apps:deploy");
    await this.access.requirePermission(userId, app.teamId, "backups");
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  /** GET routes: any team member with access to the app (the writer-only fields are stripped in the view). */
  private async authorizeRead(userId: string, appId: string): Promise<{ app: Application; canWrite: boolean }> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    if (!(await this.access.teamRole(userId, app.teamId))) throw new ForbiddenException("not a member of this team");
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    return { app, canWrite: perms?.has("apps:config") ?? false };
  }

  /** The target server must exist AND be in the app's team — a uniform 404 otherwise (no cross-team existence oracle). */
  async requireTarget(app: Application, targetServerId: string): Promise<Server> {
    const target = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!target || target.teamId !== app.teamId) throw new NotFoundException("server not found");
    return target;
  }

  /** POST /apps/:id/move/preflight — read-only (it probes the agents but changes nothing). */
  async preflight(userId: string, appId: string, input: MoveAppPreflightInput): Promise<MoveAppPreflightResult> {
    const app = await this.authorizeMutate(userId, appId);
    const target = await this.requireTarget(app, input.targetServerId);
    return this.preflights.computePreflight(app, target, input.acknowledge, userId, input.probeLink);
  }

  // ───────────────────────────── start / cancel / purge ─────────────────────────────

  /**
   * POST /apps/:id/move — the client's preflight is advisory: the WHOLE preflight (probes included) is re-run here, and the
   * row is only inserted when it is still clean. The probes cannot run inside a transaction (they take minutes), so the
   * database half is a short transaction under the same `FOR UPDATE` lock the deploy queue takes: it re-checks that the
   * app did not change, no deploy is queued/running and no move is live, then inserts. The partial unique index is the
   * backstop for two concurrent starts (-> 409 move_active).
   */
  async start(userId: string, appId: string, input: StartAppMoveInput): Promise<{ moveId: string; phase: "QUEUED" }> {
    const app = await this.authorizeMutate(userId, appId);
    const target = await this.requireTarget(app, input.targetServerId);
    if (input.confirmName !== app.name) {
      throw new BadRequestException({ statusCode: 400, message: "type the app's exact name to confirm the move", code: "confirm_name_mismatch" });
    }
    const pre = await this.preflights.computePreflight(app, target, input.acknowledge, userId, false);
    if (!pre.ok) throw new ConflictException({ statusCode: 409, message: "the move cannot start: the preflight has blockers", code: "preflight_failed", preflight: pre });

    const volumes: StoredVolume[] = pre.plan.volumes.map((v) => ({
      name: v.name,
      dockerName: v.dockerName,
      kind: v.kind,
      sizeBytes: v.sizeBytes,
      state: v.state === "move" ? "PENDING" : "SKIPPED",
      parts: 0,
      partsDone: 0,
      bytesDone: 0,
      entries: null,
      createdOnTarget: false,
      archiveOverwritten: false,
    }));
    let created: AppMove;
    try {
      created = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${app.id} FOR UPDATE`;
          const cur = await tx.application.findUnique({ where: { id: app.id }, select: { serverId: true, status: true } });
          if (!cur || cur.serverId !== app.serverId || cur.status !== app.status) throw this.conflict("changed_under_us", "the app changed while the move was being prepared — run the preflight again");
          const busy = await tx.deployment.count({
            where: { appId: app.id, status: { in: ["QUEUED", "RUNNING"] }, OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "move:" } } }] },
          });
          if (busy) throw this.conflict("deploy_active", "a deployment is queued or running — wait for it to finish");
          return tx.appMove.create({
            data: {
              appId: app.id,
              appName: app.name,
              teamId: app.teamId,
              requestedBy: userId,
              sourceServerId: app.serverId,
              targetServerId: target.id,
              prevStatus: app.status,
              plan: { ...pre.plan } as unknown as Prisma.InputJsonValue,
              acks: input.acknowledge as unknown as Prisma.InputJsonValue,
              repointDns: input.repointDns,
              retainDays: input.archiveRetainDays,
              volumes: volumes as unknown as Prisma.InputJsonValue,
              warnings: pre.warnings as unknown as Prisma.InputJsonValue,
            },
          });
        },
        { timeout: 15_000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw this.conflict("move_active", "this app already has a move in progress");
      throw e;
    }
    await this.audit.log({ actor: userId, action: "app.move.start", target: app.id, meta: { moveId: created.id, from: app.serverId, to: target.id, volumes: volumes.filter((v) => v.state === "PENDING").map((v) => v.name), bytes: pre.plan.totalBytes } });
    void this.runner.run(created.id); // in-process; the row is the source of truth (recovery re-drives it after a restart)
    return { moveId: created.id, phase: "QUEUED" };
  }

  /** POST /apps/:id/moves/:moveId/cancel — only before the cutover; after it the move rolls forward (or rolls back itself). */
  async cancel(userId: string, appId: string, moveId: string): Promise<void> {
    await this.authorizeMutate(userId, appId);
    const m = await this.prisma.appMove.findFirst({ where: { id: moveId, appId } });
    if (!m) throw new NotFoundException("move not found");
    if (["DEPLOYING", "FINALIZING"].includes(m.phase)) throw this.conflict("move_past_cutover", "the app is already on the new server — the move can no longer be cancelled");
    if (!["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"].includes(m.phase)) throw this.conflict("move_not_active", "this move is not running");
    const won = await this.prisma.appMove.updateMany({ where: { id: m.id, phase: { in: ["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"] } }, data: { cancelRequested: true } });
    if (won.count !== 1) throw this.conflict("move_past_cutover", "the app is already on the new server — the move can no longer be cancelled");
    this.runner.requestCancel(m.id);
    await this.audit.log({ actor: userId, action: "app.move.cancel", target: appId, meta: { moveId: m.id, phase: m.phase } });
  }

  /**
   * POST /apps/:id/moves/:moveId/purge-source — remove what the move left behind NOW: a COMPLETED move's archived source
   * volumes, or the target leftovers of a ROLLED_BACK/FAILED move (FAILED is how a human clears "needs attention").
   * 409 archive_in_use when the app runs on that server again or another live move uses it.
   */
  async purgeSource(userId: string, appId: string, moveId: string): Promise<void> {
    await this.authorizeMutate(userId, appId);
    const m = await this.prisma.appMove.findFirst({ where: { id: moveId, appId } });
    if (!m) throw new NotFoundException("move not found");
    const deps = { prisma: this.prisma as never, agentWs: this.agentWs as never };
    const fail = (o: PurgeOutcome): never => {
      if (o === "offline") throw new ServiceUnavailableException("the server holding the data is offline — try again when it is back");
      if (o === "skipped_live") throw this.conflict("archive_in_use", "that server holds the app's live data (or another move uses it) — nothing was removed");
      throw this.conflict("purge_incomplete", "some volumes could not be removed (in use?) — they will be retried");
    };
    let outcome: PurgeOutcome | null = null;
    if (m.phase === "COMPLETED") {
      if (m.sourcePurgedAt) throw this.conflict("nothing_to_purge", "the archive was already removed");
      outcome = await purgeMoveSource(deps, m, { stampWhenLive: false });
      if (outcome !== "purged" && outcome !== "nothing") fail(outcome);
    } else if (m.phase === "ROLLED_BACK" || m.phase === "FAILED") {
      if (m.targetPurgedAt && (m.phase === "ROLLED_BACK" || m.sourcePurgedAt)) throw this.conflict("nothing_to_purge", "nothing is left to remove");
      outcome = await retryTargetCleanup(deps, m);
      if (outcome !== "purged") {
        // a FAILED move is cleared by a human even when the target is unreachable: leftovers are reported, the block lifts
        if (m.phase !== "FAILED") fail(outcome);
      }
      if (m.phase === "FAILED") {
        // after fixing the source by hand: clear the "needs attention" block (both stamps)
        await this.prisma.appMove.update({ where: { id: m.id }, data: { sourcePurgedAt: m.sourcePurgedAt ?? new Date(), targetPurgedAt: m.targetPurgedAt ?? new Date() } });
      }
    } else {
      throw this.conflict("move_active", "the move is still running");
    }
    await this.audit.log({ actor: userId, action: "app.move.purge_source", target: appId, meta: { moveId: m.id, phase: m.phase, outcome } });
  }

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ statusCode: 409, message, code });
  }

  // ───────────────────────────── views ─────────────────────────────

  async list(userId: string, appId: string, opts: { active?: boolean; limit?: number } = {}): Promise<AppMoveView[]> {
    const { canWrite } = await this.authorizeRead(userId, appId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = await this.prisma.appMove.findMany({
      where: { appId, ...(opts.active ? { phase: { notIn: APP_MOVE_TERMINAL } } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.active ? 1 : limit,
    });
    return rows.map((m) => this.toView(m, canWrite));
  }

  async get(userId: string, appId: string, moveId: string): Promise<AppMoveView> {
    const { canWrite } = await this.authorizeRead(userId, appId);
    const m = await this.prisma.appMove.findFirst({ where: { id: moveId, appId } });
    if (!m) throw new NotFoundException("move not found");
    return this.toView(m, canWrite);
  }

  /** The row → the API view. `plan`, `acks` and `logTail` only for writers; the secret-free `snapshotBefore` never. */
  toView(m: AppMove, canWrite: boolean): AppMoveView {
    const vols = asArray<StoredVolume>(m.volumes);
    const moving = vols.filter((v) => v.state !== "SKIPPED");
    const bytesTotal = moving.reduce((a, v) => a + (v.sizeBytes ?? 0), 0);
    const bytesDone = moving.reduce((a, v) => a + (v.bytesDone ?? 0), 0);
    const firstOpen = moving.findIndex((v) => v.state !== "APPLIED");
    const pastCutover = ["DEPLOYING", "FINALIZING", "COMPLETED", "ROLLING_BACK", "ROLLED_BACK", "FAILED"].includes(m.phase);
    const terminal = (APP_MOVE_TERMINAL_PHASES as readonly string[]).includes(m.phase);
    return {
      id: m.id,
      appId: m.appId,
      appName: m.appName,
      phase: m.phase,
      prevStatus: m.prevStatus,
      sourceServerId: m.sourceServerId,
      targetServerId: m.targetServerId,
      volumes: vols.map((v) => ({ name: v.name, state: v.state, sizeBytes: v.sizeBytes ?? null, parts: v.parts ?? 0, partsDone: v.partsDone ?? 0, bytesDone: v.bytesDone ?? 0 })),
      progress: { volumeIndex: firstOpen === -1 ? moving.length : firstOpen, volumeCount: moving.length, bytesDone, bytesTotal },
      warnings: asArray<{ code: string; details?: Record<string, unknown> }>(m.warnings),
      failureReason: m.failureReason,
      failurePhase: m.failurePhase,
      deploymentId: m.deploymentId,
      cutoverAt: m.cutoverAt?.toISOString() ?? null,
      finishedAt: m.finishedAt?.toISOString() ?? null,
      archiveUntil: m.archiveUntil?.toISOString() ?? null,
      sourcePurgedAt: m.sourcePurgedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      canCancel: !terminal && !pastCutover && !m.cancelRequested,
      needsAttention: m.phase === "FAILED" && !m.sourcePurgedAt && !m.targetPurgedAt,
      plan: canWrite ? ((m.plan as Record<string, unknown>) ?? null) : null,
      acks: canWrite ? ((m.acks as Record<string, boolean>) ?? null) : null,
      logTail: canWrite ? m.logTail : null,
    };
  }
}
