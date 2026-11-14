import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma, Rollout, RolloutTarget } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { canAccessResource, isScoped, TeamAccessService, type MembershipAccess } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { loadProjectCtx, loadProjectCtxMany } from "../common/resource-project";
import { RolloutEngineService } from "./rollout-engine.service";
import { rollbackTargets } from "./rollout-decide";
import {
  assignWaves,
  planWaves,
  preflightApp,
  ROLLOUT_MAX_TARGETS,
  RolloutConfigSchema,
  type PreflightBlock,
  type PreflightWarning,
  type RolloutConfig,
} from "./rollout-plan";

export const RolloutCreateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  appIds: z.array(z.string().min(1)).min(1).max(ROLLOUT_MAX_TARGETS),
  config: RolloutConfigSchema.default({}),
});
export type RolloutCreateInput = z.infer<typeof RolloutCreateSchema>;

export const RolloutTargetViewSchema = z.object({
  id: z.string(),
  appId: z.string(),
  serverId: z.string(),
  label: z.string(),
  wave: z.number(),
  position: z.number(),
  status: z.enum(["PENDING", "DEPLOYING", "SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED", "REVERTING", "ROLLED_BACK", "ROLLBACK_FAILED"]),
  attempt: z.number(),
  deploymentId: z.string().nullable(),
  baselineDeploymentId: z.string().nullable(),
  rollbackDeploymentId: z.string().nullable(),
  outcome: z.string().nullable(),
  detail: z.string().nullable(),
  dispatchedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});
export const RolloutSummarySchema = z.object({
  total: z.number(),
  pending: z.number(),
  deploying: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
  cancelled: z.number(),
});
export const RolloutViewSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  createdBy: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  status: z.enum(["RUNNING", "HALTED", "ROLLING_BACK", "COMPLETED", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED"]),
  haltReason: z.string().nullable(),
  haltDetail: z.record(z.unknown()).nullable(),
  config: RolloutConfigSchema,
  currentWave: z.number(),
  waveCount: z.number(),
  waveSizes: z.array(z.number()),
  bakeUntil: z.date().nullable(),
  createdAt: z.date(),
  finishedAt: z.date().nullable(),
  summary: RolloutSummarySchema,
  targets: z.array(RolloutTargetViewSchema),
});
export type RolloutView = z.infer<typeof RolloutViewSchema>;

export const RolloutPlanViewSchema = z.object({
  teamId: z.string(),
  waveSizes: z.array(z.number()),
  targets: z.array(
    z.object({
      appId: z.string(),
      name: z.string(),
      serverId: z.string(),
      wave: z.number().nullable(),
      blocked: z.string().nullable(),
      warnings: z.array(z.string()),
    }),
  ),
  blocked: z.number(),
});
export type RolloutPlanView = z.infer<typeof RolloutPlanViewSchema>;

type AppRow = {
  id: string;
  teamId: string;
  name: string;
  serverId: string;
  status: string;
  clusterId: string | null;
  source: string;
  rollbackOnFailure: boolean;
  healthCheckType: string | null;
  imagesToKeep: number | null;
  autoDeploy: boolean;
  environmentId: string;
};

const APP_SELECT = {
  id: true,
  teamId: true,
  name: true,
  serverId: true,
  status: true,
  clusterId: true,
  source: true,
  rollbackOnFailure: true,
  healthCheckType: true,
  imagesToKeep: true,
  autoDeploy: true,
  environmentId: true,
} as const;

/**
 * Fleet rollouts: create (all-or-nothing authz + preflight), observe, halt / resume / cancel. Every transition
 * is a compare-and-set on the expected status; the engine does the dispatching.
 */
@Injectable()
export class RolloutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly engine: RolloutEngineService,
  ) {}

  /** Resolve + authorize the app set: every id must exist, be in ONE team the caller may deploy in, and be
   *  reachable by the caller's resource scoping. All-or-nothing (a silently shrunk canary is unsafe); the
   *  refusal never leaks which ids exist. */
  private async resolveApps(userId: string, appIds: string[]): Promise<{ teamId: string; apps: AppRow[] }> {
    const ids = [...new Set(appIds)];
    const apps = (await this.prisma.application.findMany({ where: { id: { in: ids } }, select: APP_SELECT })) as AppRow[];
    if (apps.length !== ids.length) throw new ForbiddenException("one or more apps are not available to you");
    const teams = new Set(apps.map((a) => a.teamId));
    if (teams.size !== 1) throw new BadRequestException("all apps in a rollout must belong to the same team");
    const teamId = apps[0].teamId;
    await this.access.requirePermission(userId, teamId, "apps:deploy");
    for (const a of apps) {
      await this.access.requireResourceAccess(userId, teamId, {
        resourceId: a.id,
        resolveProjectId: () => loadProjectCtx(this.prisma, a.environmentId).then((c) => c.projectId),
      });
    }
    // Keep the caller's order (it is the wave order).
    const byId = new Map(apps.map((a) => [a.id, a]));
    return { teamId, apps: ids.map((id) => byId.get(id)!) };
  }

  private async preflight(apps: AppRow[], config: RolloutConfig) {
    const busy = new Set(
      (await this.prisma.rolloutTarget.findMany({ where: { resourceId: { in: apps.map((a) => a.id) }, active: true }, select: { resourceId: true } })).map((t) => t.resourceId),
    );
    return apps.map((a) => ({ app: a, ...preflightApp(a, { allowUngated: config.allowUngated, inOtherRollout: busy.has(a.id) }) }));
  }

  /** Dry run: the same authz + preflight as create, no persistence. */
  async plan(userId: string, input: RolloutCreateInput): Promise<RolloutPlanView> {
    const config = RolloutConfigSchema.parse(input.config ?? {}); // defaults even for a direct (non-HTTP) caller
    const { teamId, apps } = await this.resolveApps(userId, input.appIds);
    const pf = await this.preflight(apps, config);
    const eligible = pf.filter((p) => !p.blocked);
    const sizes = planWaves(eligible.length, config);
    const waves = assignWaves(sizes);
    let i = 0;
    return {
      teamId,
      waveSizes: sizes,
      targets: pf.map((p) => ({
        appId: p.app.id,
        name: p.app.name,
        serverId: p.app.serverId,
        wave: p.blocked ? null : waves[i++],
        blocked: p.blocked,
        warnings: p.warnings,
      })),
      blocked: pf.length - eligible.length,
    };
  }

  async create(userId: string, input: RolloutCreateInput): Promise<RolloutView> {
    const config = RolloutConfigSchema.parse(input.config ?? {});
    const { teamId, apps } = await this.resolveApps(userId, input.appIds);
    const pf = await this.preflight(apps, config);
    const blocked = pf.filter((p) => p.blocked);
    if (blocked.length) {
      throw new UnprocessableEntityException({
        message: "some apps cannot join this rollout",
        blocked: blocked.map((p) => ({ appId: p.app.id, name: p.app.name, reason: p.blocked as PreflightBlock })),
      });
    }
    const sizes = planWaves(apps.length, config);
    const waves = assignWaves(sizes);
    let rollout: Rollout & { targets: RolloutTarget[] };
    try {
      rollout = await this.prisma.$transaction(async (tx) => {
        const r = await tx.rollout.create({
          data: {
            teamId,
            createdBy: userId,
            name: input.name ?? null,
            config: config as Prisma.InputJsonValue,
            waveCount: sizes.length,
            waveStartedAt: new Date(),
          },
        });
        await tx.rolloutTarget.createMany({
          data: apps.map((a, i) => ({ rolloutId: r.id, wave: waves[i], position: i, resourceId: a.id, serverId: a.serverId, label: a.name })),
        });
        return tx.rollout.findUniqueOrThrow({ where: { id: r.id }, include: { targets: { orderBy: [{ wave: "asc" }, { position: "asc" }] } } });
      });
    } catch (e) {
      // Lost the race on the one-live-rollout-per-app index: another rollout claimed one of these apps meanwhile.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("one or more of these apps are already in a live rollout");
      }
      throw e;
    }
    await this.audit.log({
      actor: userId,
      action: "rollout.create",
      target: rollout.id,
      meta: { teamId, targets: apps.length, waves: sizes, warnings: pf.filter((p) => p.warnings.length).map((p) => ({ appId: p.app.id, warnings: p.warnings as PreflightWarning[] })) },
    });
    void this.engine.advance(rollout.id).catch(() => undefined);
    return this.view(rollout);
  }

  async list(userId: string, filter: { teamId?: string; status?: string }): Promise<RolloutView[]> {
    const access = await this.access.accessByTeam(userId);
    const teamIds = [...access.keys()].filter((t) => !filter.teamId || t === filter.teamId);
    if (teamIds.length === 0) return [];
    const where: Prisma.RolloutWhereInput = { teamId: { in: teamIds } };
    if (filter.status && RolloutViewSchema.shape.status.safeParse(filter.status).success) where.status = filter.status as Rollout["status"];
    const rows = await this.prisma.rollout.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { targets: { orderBy: [{ wave: "asc" }, { position: "asc" }] } },
    });
    // Per-resource scoping (same rule as the apps list): a restricted member only sees a rollout when EVERY one
    // of its apps is in a project they are granted — a rollout is one object, never shown half.
    const visible = await this.filterScoped(rows, (r) => access.get(r.teamId));
    return visible.map((r) => this.view(r));
  }

  async get(userId: string, id: string): Promise<RolloutView> {
    const rollout = await this.requireRead(userId, id);
    return this.view(rollout);
  }

  /** Keep only the rollouts whose targets the (possibly scoped) member may all reach. Unscoped members skip
   *  the project lookup entirely. A target whose app is gone is treated as reachable (nothing left to leak). */
  private async filterScoped<R extends Rollout & { targets: RolloutTarget[] }>(rows: R[], accessFor: (r: R) => MembershipAccess | undefined): Promise<R[]> {
    const scopedRows = rows.filter((r) => isScoped(accessFor(r)));
    if (scopedRows.length === 0) return rows;
    const appIds = [...new Set(scopedRows.flatMap((r) => r.targets.map((t) => t.resourceId)))];
    const apps = await this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, environmentId: true } });
    const ctxByEnv = await loadProjectCtxMany(this.prisma, apps.map((a) => a.environmentId));
    const projectByApp = new Map(apps.map((a) => [a.id, ctxByEnv.get(a.environmentId)?.projectId ?? null]));
    return rows.filter((r) => {
      const m = accessFor(r);
      if (!isScoped(m)) return true;
      return r.targets.every((t) => !projectByApp.has(t.resourceId) || canAccessResource(m, t.resourceId, projectByApp.get(t.resourceId) ?? null));
    });
  }

  /** Operator halt: RUNNING → HALTED. 409 when not RUNNING. */
  async halt(userId: string, id: string): Promise<RolloutView> {
    const r = await this.requireDeploy(userId, id);
    if (!(await this.engine.halt(id, "manual", { by: userId }, userId))) throw new ConflictException(`rollout is ${r.status}, not RUNNING`);
    return this.get(userId, id);
  }

  /**
   * Resume a HALTED rollout. The resuming operator TAKES OVER as the initiator (every later dispatch runs under
   * their access, so a rollout whose creator lost access is recoverable by someone who has it) — which is why
   * their deploy access to every target app is re-checked here, all-or-nothing. Then, in one transaction:
   *   - after a failed bake the wave had already passed → the operator accepts the state and the rollout
   *     PROMOTES past the bake (next wave, or completes), so a superseded/stopped app can't dead-end the rollout;
   *   - otherwise the current wave's failed / cancelled / offline-skipped targets go back to PENDING (a new
   *     attempt with a new idempotency key); completed waves are never re-run.
   * Targets are reset BEFORE the status flips so a concurrent tick can never judge the half-reset wave.
   */
  async resume(userId: string, id: string): Promise<RolloutView> {
    const r = await this.requireDeploy(userId, id);
    if (r.status !== "HALTED") throw new ConflictException(`rollout is ${r.status}, not HALTED`);
    const liveApps = await this.prisma.application.findMany({ where: { id: { in: r.targets.map((t) => t.resourceId) } }, select: { id: true, environmentId: true } });
    for (const a of liveApps) {
      await this.access.requireResourceAccess(userId, r.teamId, {
        resourceId: a.id,
        resolveProjectId: () => loadProjectCtx(this.prisma, a.environmentId).then((c) => c.projectId),
      });
    }
    const promote = r.haltReason === "bake_failed";
    const lastWave = r.currentWave + 1 >= r.waveCount;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (!promote) {
        await tx.rolloutTarget.updateMany({
          where: {
            rolloutId: id,
            wave: r.currentWave,
            OR: [{ status: { in: ["FAILED", "CANCELLED"] } }, { status: "SKIPPED", outcome: "offline" }],
          },
          data: { status: "PENDING", deploymentId: null, outcome: null, detail: null, dispatchedAt: null, finishedAt: null },
        });
      }
      const { count } = await tx.rollout.updateMany({
        where: { id, status: "HALTED", currentWave: r.currentWave },
        data: {
          haltReason: null,
          haltDetail: Prisma.JsonNull,
          bakeUntil: null,
          waveStartedAt: now,
          createdBy: userId,
          ...(promote
            ? lastWave
              ? { status: "COMPLETED", finishedAt: now }
              : { status: "RUNNING", currentWave: r.currentWave + 1 }
            : { status: "RUNNING" }),
        },
      });
      if (count !== 1) throw new ConflictException("rollout changed state meanwhile; reload and retry");
      if (promote && lastWave) await tx.rolloutTarget.updateMany({ where: { rolloutId: id }, data: { active: false } });
    });
    await this.audit.log({
      actor: userId,
      action: "rollout.resume",
      target: id,
      meta: { teamId: r.teamId, wave: r.currentWave, takeover: r.createdBy !== userId, ...(promote ? { promotedPastBake: true } : {}) },
    });
    if (promote && lastWave) {
      // This path completes the rollout itself (the engine never sees the transition) → same audit + notification.
      await this.audit.log({ actor: userId, action: "rollout.complete", target: id, meta: { teamId: r.teamId, waves: r.waveCount, targets: r.targets.length, pastBake: true } });
      await this.engine.notify(id, "rollout_completed", {});
    }
    void this.engine.advance(id).catch(() => undefined);
    return this.get(userId, id);
  }

  /**
   * Cancel from RUNNING or HALTED, in one transaction: status → CANCELLED, PENDING targets SKIPPED, the apps'
   * live-rollout slots released. Still-QUEUED deploys are then cancelled (their targets → CANCELLED); a RUNNING
   * deploy is left to finish and its target is settled by the tick when it does (a cancelled rollout still
   * records late results, it just never dispatches again).
   */
  async cancel(userId: string, id: string): Promise<RolloutView> {
    const r = await this.requireDeploy(userId, id);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rollout.updateMany({
        where: { id, status: { in: ["RUNNING", "HALTED"] } },
        data: { status: "CANCELLED", finishedAt: now, bakeUntil: null },
      });
      if (count !== 1) throw new ConflictException(`rollout is ${r.status}, not RUNNING or HALTED`);
      await tx.rolloutTarget.updateMany({
        where: { rolloutId: id, status: "PENDING" },
        data: { status: "SKIPPED", outcome: "cancelled", finishedAt: now },
      });
      await tx.rolloutTarget.updateMany({ where: { rolloutId: id }, data: { active: false } });
    });
    const deploying = await this.prisma.rolloutTarget.findMany({ where: { rolloutId: id, status: "DEPLOYING", deploymentId: { not: null } } });
    for (const t of deploying) {
      const cancelled = await this.engine.cancelQueued(t.deploymentId!, "Cancelled: rollout cancelled");
      if (cancelled) {
        await this.prisma.rolloutTarget.updateMany({ where: { id: t.id, status: "DEPLOYING" }, data: { status: "CANCELLED", outcome: "cancelled", finishedAt: new Date() } });
      }
    }
    await this.audit.log({ actor: userId, action: "rollout.cancel", target: id, meta: { teamId: r.teamId } });
    return this.get(userId, id);
  }

  /**
   * Fleet ROLLBACK: revert every app this rollout moved (SUCCEEDED, or left on a failed deploy) to the baseline
   * recorded at its dispatch, through the per-app rollback pipeline, detached and health-gated per app. Allowed
   * from HALTED or COMPLETED, never while a deploy of this rollout is still in flight (its result would race the
   * revert). The requester takes over as operator (every revert runs under their access, re-checked here).
   * Targets without a baseline (never deployed before the rollout) cannot be reverted → ROLLBACK_FAILED/no_baseline.
   */
  async rollback(userId: string, id: string): Promise<RolloutView> {
    const r = await this.requireDeploy(userId, id);
    if (r.status !== "HALTED" && r.status !== "COMPLETED") throw new ConflictException(`rollout is ${r.status}; rollback is possible from HALTED or COMPLETED`);
    if (r.targets.some((t) => t.status === "DEPLOYING")) throw new ConflictException("a deploy of this rollout is still running; wait for it to finish");
    const liveApps = await this.prisma.application.findMany({ where: { id: { in: r.targets.map((t) => t.resourceId) } }, select: { id: true, environmentId: true } });
    for (const a of liveApps) {
      await this.access.requireResourceAccess(userId, r.teamId, {
        resourceId: a.id,
        resolveProjectId: () => loadProjectCtx(this.prisma, a.environmentId).then((c) => c.projectId),
      });
    }
    const picked = rollbackTargets(r.targets);
    // Superseded guard: an app that has since been deployed again (a webhook, a manual deploy, another rollout) is
    // no longer running what THIS rollout put there — reverting it would clobber someone else's newer release.
    // Such targets are left untouched (SKIPPED/superseded) instead of reverted.
    const byId = new Map(r.targets.map((t) => [t.id, t]));
    const ours = picked.revert.map((tid) => byId.get(tid)!).filter((t) => t.deploymentId);
    const ourDeps = ours.length
      ? await this.prisma.deployment.findMany({ where: { id: { in: ours.map((t) => t.deploymentId!) } }, select: { id: true, appId: true, createdAt: true } })
      : [];
    const createdByDep = new Map(ourDeps.map((d) => [d.id, d.createdAt]));
    const newer = ourDeps.length
      ? await this.prisma.deployment.findMany({
          where: {
            appId: { in: ours.map((t) => t.resourceId) },
            id: { notIn: ours.map((t) => t.deploymentId!) },
            status: { in: ["SUCCESS", "RUNNING", "QUEUED"] },
            createdAt: { gt: new Date(Math.min(...ourDeps.map((d) => d.createdAt.getTime()))) },
          },
          select: { appId: true, createdAt: true },
        })
      : [];
    const supersededApps = new Set(
      newer.filter((d) => ours.some((t) => t.resourceId === d.appId && createdByDep.has(t.deploymentId!) && d.createdAt > createdByDep.get(t.deploymentId!)!)).map((d) => d.appId),
    );
    // A target whose own deploy row is gone (pruned by retention) cannot be compared → never reverted blind.
    const superseded = ours.filter((t) => supersededApps.has(t.resourceId) || !createdByDep.has(t.deploymentId!)).map((t) => t.id);
    const revert = picked.revert.filter((tid) => !superseded.includes(tid));
    const noBaseline = picked.noBaseline;
    if (revert.length + noBaseline.length === 0) {
      throw new ConflictException(
        superseded.length
          ? "nothing to roll back: every app this rollout moved has since been deployed again"
          : "nothing to roll back: this rollout moved no app onto a new version",
      );
    }
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.rollout.updateMany({
          where: { id, status: { in: ["HALTED", "COMPLETED"] } },
          data: { status: "ROLLING_BACK", createdBy: userId, bakeUntil: null, waveStartedAt: now, finishedAt: null },
        });
        if (count !== 1) throw new ConflictException("rollout changed state meanwhile; reload and retry");
        if (revert.length) {
          // Re-claims the apps' live-rollout slots (a COMPLETED rollout had released them) — P2002 = another live rollout.
          await tx.rolloutTarget.updateMany({
            where: { id: { in: revert } },
            data: { status: "REVERTING", rollbackAttempt: 0, rollbackDeploymentId: null, outcome: null, detail: null, finishedAt: null, active: true },
          });
        }
        if (superseded.length) {
          await tx.rolloutTarget.updateMany({
            where: { id: { in: superseded } },
            data: { status: "SKIPPED", outcome: "superseded", detail: "a newer deploy replaced this rollout's version; left untouched", finishedAt: now },
          });
        }
        if (noBaseline.length) {
          await tx.rolloutTarget.updateMany({
            where: { id: { in: noBaseline } },
            data: { status: "ROLLBACK_FAILED", outcome: "no_baseline", detail: "the app had no rollbackable deploy before this rollout", finishedAt: now },
          });
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("one or more of these apps are now in another live rollout");
      }
      throw e;
    }
    await this.audit.log({
      actor: userId,
      action: "rollout.rollback",
      target: id,
      meta: { teamId: r.teamId, revert: revert.length, superseded: superseded.length, noBaseline: noBaseline.length, takeover: r.createdBy !== userId },
    });
    void this.engine.advance(id).catch(() => undefined);
    return this.get(userId, id);
  }

  private async requireRead(userId: string, id: string): Promise<Rollout & { targets: RolloutTarget[] }> {
    const rollout = await this.prisma.rollout.findUnique({ where: { id }, include: { targets: { orderBy: [{ wave: "asc" }, { position: "asc" }] } } });
    if (!rollout) throw new NotFoundException("rollout not found");
    const m = await this.access.membershipAccess(userId, rollout.teamId);
    if (!m) throw new ForbiddenException("not a member of this team");
    // A scoped member may only see a rollout whose apps are all in their granted projects; 404, not 403, so the
    // rollout's existence is not leaked (same as a resource they cannot reach).
    if (isScoped(m) && (await this.filterScoped([rollout], () => m)).length === 0) throw new NotFoundException("rollout not found");
    return rollout;
  }

  private async requireDeploy(userId: string, id: string): Promise<Rollout & { targets: RolloutTarget[] }> {
    const rollout = await this.requireRead(userId, id);
    await this.access.requirePermission(userId, rollout.teamId, "apps:deploy");
    return rollout;
  }

  view(r: Rollout & { targets: RolloutTarget[] }): RolloutView {
    const config = RolloutConfigSchema.parse(r.config ?? {});
    const count = (s: RolloutTarget["status"]) => r.targets.filter((t) => t.status === s).length;
    const sizes = Array.from({ length: r.waveCount }, (_, w) => r.targets.filter((t) => t.wave === w).length);
    return {
      id: r.id,
      teamId: r.teamId,
      createdBy: r.createdBy,
      name: r.name,
      kind: r.kind,
      status: r.status,
      haltReason: r.haltReason,
      haltDetail: (r.haltDetail as Record<string, unknown> | null) ?? null,
      config,
      currentWave: r.currentWave,
      waveCount: r.waveCount,
      waveSizes: sizes,
      bakeUntil: r.bakeUntil,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      summary: {
        total: r.targets.length,
        pending: count("PENDING"),
        deploying: count("DEPLOYING"),
        succeeded: count("SUCCEEDED"),
        failed: count("FAILED"),
        skipped: count("SKIPPED"),
        cancelled: count("CANCELLED"),
      },
      targets: r.targets.map((t) => ({
        id: t.id,
        appId: t.resourceId,
        serverId: t.serverId,
        label: t.label,
        wave: t.wave,
        position: t.position,
        status: t.status,
        attempt: t.attempt,
        deploymentId: t.deploymentId,
        baselineDeploymentId: t.baselineDeploymentId,
        rollbackDeploymentId: t.rollbackDeploymentId,
        outcome: t.outcome,
        detail: t.detail,
        dispatchedAt: t.dispatchedAt,
        finishedAt: t.finishedAt,
      })),
    };
  }
}
