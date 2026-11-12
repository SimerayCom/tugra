import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const INTERRUPTED_DEPLOY_NOTE =
  "Deployment interrupted: the hub restarted while this deploy was in progress, so its result is unknown. Re-deploy to continue.";

export const CLUSTERED_QUEUED_DROP_NOTE =
  "Queued deploy dropped: the hub restarted before it started. Swarm/cluster deploys don't yet resume across a restart — re-deploy.";

/**
 * On hub startup, fail any Deployment still marked RUNNING. A deploy is driven synchronously by the hub
 * process (runDeploy awaits the agent), so a RUNNING row at boot is orphaned — the process that owned it
 * died with the previous hub. Left as-is it wedges the app: the in-progress guard
 * (`a deployment is already running`) throws 409 on every future deploy. Marking it FAILED unblocks the app
 * and the operator re-deploys. Safe because the hub is a single process with no replicas, so at boot nothing
 * else can legitimately be driving a deploy (mirrors the importer's stale-RUNNING reap).
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

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const { count } = await this.prisma.deployment.updateMany({
      where: { status: "RUNNING" },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE },
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
