import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, Rollout, RolloutTarget, type RolloutStatus as RolloutStatusEnum } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { ApplicationsService } from "../applications/applications.service";
import { preflightApp, RolloutConfigSchema } from "./rollout-plan";
import { decide, rolloutKey, type Action, type DeploymentFacts, type HaltReason, type RolloutSnap, type TargetSnap } from "./rollout-decide";

/** A settle only ever lands on an OPEN target (a late result never overwrites a terminal one). */
const OPEN_TARGET_FILTER: Prisma.RolloutTargetWhereInput = { status: { in: ["PENDING", "DEPLOYING"] } };
const TERMINAL_ROLLOUT: RolloutStatusEnum[] = ["COMPLETED", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED"];

/**
 * Drives rollouts: a STATELESS tick that re-reads each live rollout, asks the pure `decide()` what to do and
 * applies every action as a status-guarded compare-and-set. It never awaits a build — dispatch goes through
 * ApplicationsService.deployDetached, which returns the QUEUED/RUNNING row at once — so a tick is cheap and a
 * hub restart loses nothing but the in-flight deploys themselves (which the boot reconcile marks interrupted →
 * the rollout halts for the operator). Single-hub by design (in-process per-rollout guard), like the other
 * schedulers; the DB CAS keeps every transition safe even if two drivers ever overlapped.
 */
@Injectable()
export class RolloutEngineService {
  private readonly logger = new Logger(RolloutEngineService.name);
  /** When THIS process started: a RUNNING deploy older than this is an orphan of the previous process. */
  private readonly bootAt = Date.now();
  private readonly advancing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
  ) {}

  /** Overridable clock (specs). */
  protected now(): number {
    return Date.now();
  }

  async tick(): Promise<void> {
    // Self-heal the live-rollout slots: a crash between a terminal status flip and the targets' release (or any
    // older row) must never lock an app out of rollouts forever.
    await this.prisma.rolloutTarget
      .updateMany({ where: { active: true, rollout: { status: { in: TERMINAL_ROLLOUT } } }, data: { active: false } })
      .catch((e) => this.logger.warn(`rollout slot self-heal failed: ${e instanceof Error ? e.message : e}`));
    // RUNNING rollouts, plus any rollout (HALTED or even CANCELLED) that still has a deploy in flight to settle.
    const live = await this.prisma.rollout.findMany({
      where: { OR: [{ status: "RUNNING" }, { targets: { some: { status: "DEPLOYING" } } }] },
      select: { id: true },
    });
    for (const r of live) {
      try {
        await this.advance(r.id);
      } catch (e) {
        this.logger.warn(`rollout ${r.id}: tick failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** One decide→apply pass for a rollout. Re-entrancy-guarded per rollout (create/halt/resume kick it too). */
  async advance(id: string): Promise<void> {
    if (this.advancing.has(id)) return;
    this.advancing.add(id);
    try {
      // A wave promotion re-runs the pass once so the next wave starts at once instead of waiting a tick.
      for (let pass = 0; pass < 2; pass++) {
        const rollout = await this.prisma.rollout.findUnique({ where: { id }, include: { targets: { orderBy: [{ wave: "asc" }, { position: "asc" }] } } });
        if (!rollout) return;
        const { snap, targets } = await this.snapshot(rollout, rollout.targets);
        const actions = decide(snap, targets, this.now(), this.bootAt);
        let promoted = false;
        let halted = false;
        for (const a of actions) {
          // Once this pass halted the rollout, nothing further is dispatched (decide never emits both, but a
          // manual halt landing mid-pass is caught by the status re-check inside dispatch as well).
          if (halted && a.type === "enqueue") continue;
          const r = await this.apply(rollout, rollout.targets, a);
          if (r === "promoted") promoted = true;
          if (r === "halted") halted = true;
        }
        if (!promoted) return;
      }
    } finally {
      this.advancing.delete(id);
    }
  }

  private async snapshot(rollout: Rollout, targets: RolloutTarget[]): Promise<{ snap: RolloutSnap; targets: TargetSnap[] }> {
    const config = RolloutConfigSchema.parse(rollout.config ?? {});
    const deploying = targets.filter((t) => t.status === "DEPLOYING");
    // A DEPLOYING target with no pinned Deployment id (crash between the enqueue and the pin): recover the row by
    // its idempotency key before judging it — the deploy may well be running.
    for (const t of deploying) {
      if (t.deploymentId) continue;
      const found = await this.prisma.deployment.findUnique({ where: { appId_idempotencyKey: { appId: t.resourceId, idempotencyKey: rolloutKey(rollout.id, t.resourceId, t.attempt) } }, select: { id: true } });
      if (found) {
        await this.prisma.rolloutTarget.updateMany({ where: { id: t.id, status: "DEPLOYING", deploymentId: null }, data: { deploymentId: found.id } });
        t.deploymentId = found.id;
      }
    }
    const depIds = deploying.map((t) => t.deploymentId).filter((x): x is string => !!x);
    const appIds = [...new Set(targets.map((t) => t.resourceId))];
    // "Superseded" matters only during a bake, for the current wave's passed targets: any deploy of that app
    // created after ours was dispatched (and not ours) means a newer version replaced the one we verified.
    const baking = rollout.status === "RUNNING" && !!rollout.bakeUntil;
    const bakeTargets = baking ? targets.filter((t) => t.wave === rollout.currentWave && t.status === "SUCCEEDED" && t.dispatchedAt) : [];
    const [deps, apps, newer] = await Promise.all([
      depIds.length
        ? this.prisma.deployment.findMany({ where: { id: { in: depIds } }, select: { id: true, status: true, kind: true, exitCode: true, logs: true, startedAt: true, createdAt: true } })
        : Promise.resolve([]),
      this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, status: true, serverId: true, buildServerId: true } }),
      bakeTargets.length
        ? this.prisma.deployment.findMany({
            where: {
              appId: { in: bakeTargets.map((t) => t.resourceId) },
              id: { notIn: bakeTargets.map((t) => t.deploymentId).filter((x): x is string => !!x) },
              createdAt: { gt: new Date(Math.min(...bakeTargets.map((t) => t.dispatchedAt!.getTime()))) },
            },
            select: { appId: true, createdAt: true },
          })
        : Promise.resolve([]),
    ]);
    const depById = new Map(deps.map((d) => [d.id, d]));
    const appById = new Map(apps.map((a) => [a.id, a]));
    const dispatchedByApp = new Map(bakeTargets.map((t) => [t.resourceId, t.dispatchedAt!.getTime()]));
    const supersededApps = new Set(newer.filter((d) => d.createdAt.getTime() > (dispatchedByApp.get(d.appId) ?? Infinity)).map((d) => d.appId));
    const snaps: TargetSnap[] = targets.map((t) => {
      const app = appById.get(t.resourceId);
      const dep = t.deploymentId ? depById.get(t.deploymentId) : undefined;
      const online = !!app && this.agentWs.isOnline(app.serverId) && (!app.buildServerId || app.buildServerId === app.serverId || this.agentWs.isOnline(app.buildServerId));
      const facts: DeploymentFacts | null = dep
        ? { status: dep.status as DeploymentFacts["status"], kind: dep.kind, exitCode: dep.exitCode, logs: dep.logs, startedAt: dep.startedAt, createdAt: dep.createdAt }
        : null;
      return {
        id: t.id,
        wave: t.wave,
        status: t.status,
        attempt: t.attempt,
        deploymentId: t.deploymentId,
        deployment: facts,
        appStatus: app ? app.status : null,
        superseded: supersededApps.has(t.resourceId),
        online,
      };
    });
    const snap: RolloutSnap = {
      status: rollout.status,
      currentWave: rollout.currentWave,
      waveCount: rollout.waveCount,
      waveStartedAt: rollout.waveStartedAt,
      bakeUntil: rollout.bakeUntil,
      config,
    };
    return { snap, targets: snaps };
  }

  /** Apply one action. "promoted" = a wave was promoted (the caller re-runs the pass); "halted" = the rollout
   *  halted (the caller dispatches nothing further this pass). */
  private async apply(rollout: Rollout, targets: RolloutTarget[], a: Action): Promise<"promoted" | "halted" | null> {
    switch (a.type) {
      case "settle":
        await this.settle(a.targetId, a.status, a.outcome, a.detail);
        return null;
      case "queue_timeout": {
        // Only a deploy that is STILL queued is abandoned; one that started meanwhile keeps running and is judged
        // by its own outcome on a later tick.
        const cancelled = a.deploymentId ? await this.cancelQueued(a.deploymentId, "Cancelled: rollout dispatch timeout") : true;
        if (cancelled) await this.settle(a.targetId, "FAILED", "queue_timeout", "the deploy never left the app's queue in time");
        return null;
      }
      case "enqueue": {
        const t = targets.find((x) => x.id === a.targetId);
        if (t) return (await this.dispatch(rollout, t)) ? null : "halted";
        return null;
      }
      case "halt":
        await this.halt(rollout.id, a.reason, a.detail, "system");
        return "halted";
      case "start_bake":
        await this.prisma.rollout.updateMany({ where: { id: rollout.id, status: "RUNNING", currentWave: rollout.currentWave }, data: { bakeUntil: a.until } });
        return null;
      case "advance_wave": {
        const { count } = await this.prisma.rollout.updateMany({
          where: { id: rollout.id, status: "RUNNING", currentWave: rollout.currentWave },
          data: { currentWave: rollout.currentWave + 1, bakeUntil: null, waveStartedAt: new Date(this.now()) },
        });
        if (count !== 1) return null;
        await this.auditLog("rollout.wave.promote", rollout, { from: rollout.currentWave, to: rollout.currentWave + 1 });
        return "promoted";
      }
      case "complete": {
        // One transaction: the status flip and the release of the apps' live-rollout slots never split.
        const count = await this.prisma.$transaction(async (tx) => {
          const r = await tx.rollout.updateMany({
            where: { id: rollout.id, status: "RUNNING", currentWave: rollout.currentWave },
            data: { status: "COMPLETED", finishedAt: new Date(this.now()), bakeUntil: null },
          });
          if (r.count === 1) await tx.rolloutTarget.updateMany({ where: { rolloutId: rollout.id }, data: { active: false } });
          return r.count;
        });
        if (count === 1) await this.auditLog("rollout.complete", rollout, { waves: rollout.waveCount, targets: targets.length });
        return null;
      }
    }
  }

  private async settle(targetId: string, status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED", outcome: string, detail?: string): Promise<void> {
    await this.prisma.rolloutTarget.updateMany({
      where: { id: targetId, ...OPEN_TARGET_FILTER },
      data: { status, outcome, detail: detail?.slice(0, 500) ?? null, finishedAt: new Date(this.now()) },
    });
  }

  /**
   * Claim the target (PENDING→DEPLOYING by CAS), re-check that the rollout is still RUNNING and that the app still
   * passes the gate preflight it was admitted with, record its baseline, dispatch the detached deploy and pin the
   * Deployment id. The initiator's access is re-checked on EVERY dispatch (fail closed). Returns false when the
   * rollout turned out to be halted/cancelled (the caller stops dispatching).
   */
  private async dispatch(rollout: Rollout, t: RolloutTarget): Promise<boolean> {
    const live = await this.prisma.rollout.findUnique({ where: { id: rollout.id }, select: { status: true, currentWave: true, createdBy: true } });
    if (!live || live.status !== "RUNNING" || live.currentWave !== t.wave) return false;
    const cfg = RolloutConfigSchema.parse(rollout.config ?? {});
    const attempt = t.attempt + 1;
    const { count } = await this.prisma.rolloutTarget.updateMany({
      where: { id: t.id, status: "PENDING" },
      data: { status: "DEPLOYING", attempt, dispatchedAt: new Date(this.now()), deploymentId: null, outcome: null, detail: null },
    });
    if (count !== 1) return true;
    // Re-preflight on the CURRENT app row: an app moved to a swarm or stripped of its auto-rollback since the plan
    // was made no longer has the gate the plan promised — skip it rather than deploy it ungated.
    const app = await this.prisma.application.findUnique({
      where: { id: t.resourceId },
      select: { clusterId: true, source: true, rollbackOnFailure: true, healthCheckType: true, imagesToKeep: true, autoDeploy: true },
    });
    if (!app) {
      await this.settle(t.id, "SKIPPED", "app_gone");
      return true;
    }
    const pf = preflightApp(app, { allowUngated: cfg.allowUngated, inOtherRollout: false });
    if (pf.blocked) {
      await this.settle(t.id, "SKIPPED", "preflight", `no longer eligible: ${pf.blocked}`);
      return true;
    }
    if (!t.baselineDeploymentId) {
      const baseline = await this.apps.rolloutBaseline(t.resourceId).catch(() => null);
      if (baseline) await this.prisma.rolloutTarget.update({ where: { id: t.id }, data: { baselineDeploymentId: baseline } });
    }
    const key = rolloutKey(rollout.id, t.resourceId, attempt);
    try {
      const dep = await this.apps.deployDetached(live.createdBy, t.resourceId, { key, noCache: cfg.noCache });
      await this.prisma.rolloutTarget.updateMany({ where: { id: t.id, status: "DEPLOYING" }, data: { deploymentId: dep.id } });
    } catch (e) {
      // Whatever threw, the deploy row may already exist (the enqueue succeeded and a later step failed): pin it
      // by its key so the target is judged by the real deploy instead of being written off.
      const existing = await this.prisma.deployment
        .findUnique({ where: { appId_idempotencyKey: { appId: t.resourceId, idempotencyKey: key } }, select: { id: true } })
        .catch(() => null);
      if (existing) {
        await this.prisma.rolloutTarget.updateMany({ where: { id: t.id, status: "DEPLOYING" }, data: { deploymentId: existing.id } });
        return true;
      }
      if (e instanceof AgentOfflineException) {
        // Not an outcome: back to PENDING; the wave's offline wait (waitOnlineSec) bounds how long it is retried.
        await this.prisma.rolloutTarget.updateMany({ where: { id: t.id, status: "DEPLOYING" }, data: { status: "PENDING", dispatchedAt: null } });
        return true;
      }
      if (e instanceof NotFoundException) {
        await this.settle(t.id, "SKIPPED", "app_gone");
        return true;
      }
      if (e instanceof ForbiddenException) {
        await this.settle(t.id, "FAILED", "forbidden", "the rollout's initiator no longer has deploy access to this app");
        await this.halt(rollout.id, "initiator_lost", { target: t.id }, "system");
        return false;
      }
      if (e instanceof ConflictException) {
        await this.settle(t.id, "FAILED", "queue_full", e.message);
        return true;
      }
      // Exception messages are not persisted: they can carry internals; the log has them.
      this.logger.warn(`rollout ${rollout.id}: dispatch for ${t.resourceId} failed: ${e instanceof Error ? e.message : e}`);
      await this.settle(t.id, "FAILED", "enqueue_failed");
    }
    return true;
  }

  /**
   * RUNNING → HALTED (CAS). Deploys of this rollout still QUEUED are cancelled (they never started, so this is
   * free) and their targets recorded CANCELLED/halted; a RUNNING deploy is left to finish (it cannot be cancelled
   * after a restart) and its late result is still settled while HALTED. Shared by the engine and the manual halt.
   */
  async halt(rolloutId: string, reason: HaltReason, detail: Record<string, unknown> | undefined, actor: string): Promise<boolean> {
    const { count } = await this.prisma.rollout.updateMany({
      where: { id: rolloutId, status: "RUNNING" },
      data: { status: "HALTED", haltReason: reason, haltDetail: (detail ?? Prisma.JsonNull) as Prisma.InputJsonValue, bakeUntil: null },
    });
    if (count !== 1) return false;
    const deploying = await this.prisma.rolloutTarget.findMany({ where: { rolloutId, status: "DEPLOYING", deploymentId: { not: null } } });
    for (const t of deploying) {
      const cancelled = await this.cancelQueued(t.deploymentId!, "Cancelled: rollout halted");
      if (cancelled) await this.settle(t.id, "CANCELLED", "halted");
    }
    const rollout = await this.prisma.rollout.findUnique({ where: { id: rolloutId } });
    if (rollout) await this.auditLog("rollout.halt", rollout, { reason, ...(detail ?? {}) }, actor);
    return true;
  }

  /** Cancel a still-QUEUED deploy this rollout dispatched (system authority: the rollout row). False if it had
   *  already started (a RUNNING deploy is never killed by the engine). */
  cancelQueued(deploymentId: string, note: string): Promise<boolean> {
    return this.apps.cancelQueuedDeploymentSystem(deploymentId, note).catch(() => false);
  }

  private async auditLog(action: string, rollout: Rollout, meta: Record<string, unknown>, actor = "system"): Promise<void> {
    try {
      await this.audit.log({ actor, action, target: rollout.id, meta: { teamId: rollout.teamId, ...meta } });
    } catch {
      /* best-effort */
    }
  }
}
