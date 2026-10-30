import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const INTERRUPTED_DEPLOY_NOTE =
  "Deployment interrupted: the hub restarted while this deploy was in progress, so its result is unknown. Re-deploy to continue.";

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
    // Drop any deploys still QUEUED from before the restart: agents haven't reconnected at bootstrap, so
    // draining them now would just fail with "agent offline". The operator re-deploys. (Re-adopting a queue
    // across restarts is deferred.)
    const dropped = await this.prisma.deployment.updateMany({
      where: { status: "QUEUED" },
      data: { status: "CANCELLED", exitCode: -1, logs: "Queued deploy dropped: the hub restarted before it started. Re-deploy." },
    });
    if (dropped.count > 0) {
      this.logger.warn(`dropped ${dropped.count} QUEUED deployment(s) left by a hub restart (marked CANCELLED)`);
    }
  }
}
