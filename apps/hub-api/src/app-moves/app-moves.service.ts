import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Application, AppMove, Server } from "@prisma/client";
import { APP_MOVE_TERMINAL_PHASES } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { MovePreflightService } from "./move-preflight.service";
import type { AppMoveView, MoveAckInput, MoveAppPreflightInput, MoveAppPreflightResult } from "./dto";

const PROBE_TIMEOUT_MS = 600_000; // du on a large volume can take a while

export interface StoredVolume {
  name: string;
  dockerName: string;
  kind: "app" | "compose";
  sizeBytes: number | null;
  state: "PENDING" | "PACKED" | "TRANSFERRED" | "APPLIED" | "SKIPPED";
  parts: number;
  partsDone: number;
  bytesDone: number;
  entries: number | null;
  createdOnTarget: boolean;
  archiveOverwritten: boolean;
}

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
