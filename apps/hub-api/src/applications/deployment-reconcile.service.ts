import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DeployLeaseService } from "./deploy-lease.service";

export const INTERRUPTED_DEPLOY_NOTE =
  "Deployment interrupted: the hub restarted while this deploy was in progress, so its result is unknown. Re-deploy to continue.";

export const CLUSTERED_QUEUED_DROP_NOTE =
  "Queued deploy dropped: the hub restarted before it started. Swarm/cluster deploys don't yet resume across a restart — re-deploy.";

/**
 * On hub startup, deal with every Deployment still marked RUNNING by a dead hub process. A deploy is driven
 * synchronously by the hub process (executeDeploy awaits the agent), so a RUNNING row at boot is orphaned — the
 * process that owned it died with the previous hub. Left as-is it wedges the app: the in-progress guard
 * (`a deployment is already running`) throws 409 on every future deploy.
 *
 * Two kinds of orphan:
 *  - RECOVERABLE: the main deploy command was dispatched as `durable` to a cmd_journal_v1 agent (agentReqId set).
 *    The agent kept running it and journaled the result (kept for days), so the row is NOT failed: it is
 *    marked phase RECOVERING with no owner and stays RUNNING, and DeployRecoveryService adopts it when that agent
 *    (re)connects — the real outcome (SUCCESS / FAILED / auto-rollback / cancelled) lands instead of a guess.
 *  - EVERYTHING ELSE (no journaled command: pre-dispatch, build-server/render phase, swarm, rollback, an old agent,
 *    a pre-migration row with phase NULL): reaped to FAILED exactly as before,
 *    so the app is unblocked and the operator re-deploys.
 * Rows owned by THIS process (ownerId = our bootId) are excluded: an agent reconnect hook can legitimately claim a
 * deploy in the same bootstrap phase this runs in.
 *
 * durationMs is intentionally left null — the true wall-clock of an interrupted run is unknown (the hub may
 * have been down for hours), and a stamped value would be misleading.
 *
 * NON-CLUSTERED (single-server) QUEUED rows are deliberately LEFT INTACT across a restart (no longer cancelled
 * here). A QUEUED deploy has startedAt=null and has dispatched NOTHING to its agent (executeDeploy is the only
 * sender, and it runs only on a RUNNING row), so re-driving it later is a byte-identical NORMAL deploy — not a
 * resume — with zero double-apply risk. They are re-driven automatically when the owning server's agent
 * reconnects to the gateway (ApplicationsService.redriveQueuedForServer, registered in
 * ApplicationsModule.onModuleInit), which is strictly gated on that server being online — so a restart no
 * longer silently drops single-server queued work, and a drain is never attempted while the agent is offline.
 * A stale-QUEUED safety sweep (ApplicationsService.sweepStaleQueued, driven by DeployQueueSweepSchedulerService)
 * is the backstop that eventually cancels a row whose server never comes back, so nothing lingers QUEUED forever.
 *
 * CLUSTERED (swarm) QUEUED rows ARE still cancelled here. A swarm deploy targets the cluster MANAGER, resolved
 * dynamically (swarmDeploy.resolveManager), not Application.serverId — so the reconnect re-drive's per-server
 * online gate cannot safely gate it, and driving it while the manager is offline would spuriously FAIL the
 * deploy. Resuming clustered deploys is a deferred follow-up; cancelling them at boot preserves today's exact
 * behavior for swarm apps (no regression, no spurious "manager offline" FAILED) while single-server apps gain
 * resume. redriveQueuedForServer and the sweep both reflect this split.
 */
@Injectable()
export class DeploymentReconcileService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeploymentReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lease: DeployLeaseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const notOurs = { OR: [{ ownerId: null }, { ownerId: { not: this.lease.bootId } }] };
    // (1) Recoverable rows (a journaled command exists): keep RUNNING, release for adoption. No deadline cut here —
    // the agent's journal keeps results for days, so even after a long hub outage the real outcome is asked for
    // first; DeployRecoveryService settles a row as interrupted only when its agent is not there to ask.
    const { count: recoverable } = await this.prisma.deployment.updateMany({
      where: { status: "RUNNING", agentReqId: { not: null }, ...notOurs },
      data: { ownerId: null, phase: "RECOVERING" },
    });
    if (recoverable > 0) {
      this.logger.warn(`${recoverable} deployment(s) left RUNNING by a hub restart are recoverable — awaiting their agent to adopt the outcome`);
    }
    // (2) Everything else still RUNNING and not ours: the legacy reap. NULL-safe on purpose: Prisma's `not` on a
    // nullable column compiles to `<> value`, which never matches NULL — and every row written before this
    // migration (or by a legacy path) has phase NULL. Those are exactly the orphans this reap exists for.
    const { count } = await this.prisma.deployment.updateMany({
      where: { status: "RUNNING", AND: [{ OR: [{ phase: null }, { phase: { not: "RECOVERING" } }] }, notOurs] },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE, ownerId: null, phase: null },
    });
    if (count > 0) {
      this.logger.warn(`reaped ${count} deployment(s) left RUNNING by a hub restart (marked FAILED)`);
    }
    // Non-clustered QUEUED rows are intentionally NOT touched: they survive the restart and re-drive when their
    // server's agent reconnects (see the class docstring). CLUSTERED (swarm) QUEUED rows ARE cancelled — a
    // swarm deploy targets the dynamically-resolved cluster manager, not Application.serverId, so the per-server
    // reconnect gate can't safely gate them; resuming them is deferred. This preserves today's behavior for
    // swarm apps. The stale-QUEUED sweep is the eventual backstop for the single-server rows left intact.
    const { count: cancelled } = await this.prisma.deployment.updateMany({
      where: { status: "QUEUED", application: { clusterId: { not: null } } },
      data: { status: "CANCELLED", exitCode: -1, logs: CLUSTERED_QUEUED_DROP_NOTE },
    });
    if (cancelled > 0) {
      this.logger.warn(`cancelled ${cancelled} clustered QUEUED deploy(s) across a hub restart (swarm resume is deferred)`);
    }
  }
}
