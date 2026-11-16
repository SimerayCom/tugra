import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DeployLeaseService } from "./deploy-lease.service";

export const INTERRUPTED_DEPLOY_NOTE =
  "Deployment interrupted: the hub restarted while this deploy was in progress, so its result is unknown. Re-deploy to continue.";

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
 * QUEUED rows (single-server AND clustered/swarm) are deliberately LEFT INTACT across a restart. A QUEUED deploy has
 * startedAt=null and has dispatched NOTHING to its agent (executeDeploy is the only sender, and it runs only on a
 * RUNNING row), so re-driving it later is a byte-identical NORMAL deploy — not a resume — with zero double-apply
 * risk. They are re-driven automatically when the owning agent reconnects to the gateway
 * (ApplicationsService.redriveQueuedForServer for single-server apps, redriveQueuedClusteredForServer for swarm apps,
 * both registered in ApplicationsModule.onModuleInit), strictly gated on the agent(s) the deploy needs being online:
 * the app's server, or for a swarm app a reachable cluster manager (plus the build server if one is set). A stale-QUEUED
 * safety sweep (ApplicationsService.sweepStaleQueued, DeployQueueSweepSchedulerService) is the backstop that
 * eventually cancels a row whose server/cluster never comes back, so nothing lingers QUEUED forever.
 *
 * SWARM RUNNING rows follow the same two-way split as single-server ones, decided by how far the deploy got:
 *  - phase DISPATCHED/RECOVERING with a journaled `docker service` command (agentReqId): RECOVERABLE (case 1 above) —
 *    adopted from the manager's command journal, never re-sent.
 *  - phase PREPARING (the swarm build/inspect phase, nothing on the cluster touched, no command journaled): the row is
 *    RE-QUEUED (status QUEUED, startedAt/owner/phase cleared; createdAt untouched so it keeps its FIFO place) and re-driven
 *    like any queued row. Re-running that phase is idempotent (the image build/push is tagged by the deployment id,
 *    the pull/inspect and proxy ensure are read-only/idempotent), so a restart can neither double-apply nor lose it.
 *  Swarm rows on an agent WITHOUT a journal (no PREPARING stamp, no reqId) fall through to the legacy reap below.
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
    // (1b) Swarm deploys caught in their pre-dispatch build/inspect phase: nothing live was touched and no command was
    // journaled, so put the row back in the queue (it re-drives when the cluster is reachable) instead of failing it.
    // Must run BEFORE the reap below, which would otherwise FAIL every non-RECOVERING row.
    const { count: requeued } = await this.prisma.deployment.updateMany({
      where: { status: "RUNNING", phase: "PREPARING", agentReqId: null, ...notOurs },
      data: { status: "QUEUED", startedAt: null, ownerId: null, heartbeatAt: null, phase: null },
    });
    if (requeued > 0) {
      this.logger.warn(`re-queued ${requeued} swarm deployment(s) interrupted by a hub restart before anything was dispatched — they re-run when the cluster is reachable`);
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
    // QUEUED rows (single-server and swarm) are intentionally NOT touched: they survive the restart and re-drive when
    // their agent / cluster manager is reachable (see the class docstring). The stale-QUEUED sweep is the backstop.
  }
}
