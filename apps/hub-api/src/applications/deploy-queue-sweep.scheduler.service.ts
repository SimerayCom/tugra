import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { ApplicationsService } from "./applications.service";

const HOURLY_MS = 3600 * 1000;
// A QUEUED deploy whose server's agent never reconnects is cancelled once it is older than this. Generous
// (default 6h) — far beyond any real deploy PLUS a transient reboot/network-blip reconnect window — so a
// server that is merely rebooting is never swept. Env-overridable via DEPLOY_QUEUE_MAX_AGE_MS.
const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000;

/**
 * Backstop for QUEUED deploys that survive a hub restart (see DeploymentReconcileService): a restart no
 * longer cancels them — they re-drive when their server's agent reconnects — so this hourly sweep is what
 * guarantees a row whose server NEVER comes back (offline forever, deleted, or a stuck-QUEUED bug) doesn't
 * linger forever. Mirrors ExpirySchedulerService: a BullMQ repeatable job, disabled in tests (the sweep DB
 * logic is unit-tested directly on ApplicationsService). Keeps the Deployment mutation on ApplicationsService,
 * the single owner of deploy-row writes.
 */
@Injectable()
export class DeployQueueSweepSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeployQueueSweepSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly apps: ApplicationsService,
  ) {}

  /** The stale-QUEUED cancel threshold (env DEPLOY_QUEUE_MAX_AGE_MS, default 6h). A non-positive / garbage
   *  value falls back to the default so a bad env can never shrink the window and cancel fresh rows. */
  private maxAgeMs(): number {
    const raw = Number(process.env.DEPLOY_QUEUE_MAX_AGE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
  }

  async onApplicationBootstrap(): Promise<void> {
    // Disabled in tests; the sweep DB logic is exercised directly via ApplicationsService unit specs.
    if (process.env.NODE_ENV === "test") return;

    await this.ticks.register({
      name: "deploy-queue-sweep",
      every: HOURLY_MS,
      run: async () => {
        const cancelled = await this.apps.sweepStaleQueued(this.maxAgeMs());
        if (cancelled > 0) {
          this.logger.warn(`cancelled ${cancelled} stale QUEUED deploy(s) (server's agent never reconnected)`);
        }
      },
    });
    this.logger.log("scheduled hourly stale-QUEUED deploy sweep");
  }
}
