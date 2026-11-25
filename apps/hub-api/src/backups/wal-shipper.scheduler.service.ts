import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { WalShipperRunnerService } from "./wal-shipper-runner.service";

/** One GLOBAL repeatable sweep (not a per-db job): the runner selects the enabled databases each tick, so there
 *  is no schedule/unschedule to couple to enable/disable/delete and no orphan repeatables to reap — a database
 *  that is disabled or deleted simply stops matching the sweep's query. */
const SWEEP_JOB = "wal-sweep";
const SWEEP_EVERY_MS = 60_000;

/**
 * Drives the WAL shipper (PITR 5.5) on a fixed interval, mirroring BackupSchedulerService / the volume-backup
 * scheduler: its own tick on the shared scheduler queue (NOT the "backups" queue, whose single Worker could be
 * blocked for up to an hour by a base backup and let the spool grow; the scheduler runs each tick in its own slot), disabled under NODE_ENV=test so the e2e
 * suite drives the runner directly. Inert in production until a database is PITR-enabled.
 */
@Injectable()
export class WalShipperSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalShipperSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly runner: WalShipperRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    // Idempotent re-register of the single sweep (a stable scheduler id, like the backup watchdog).
    await this.ticks.register({ name: SWEEP_JOB, every: SWEEP_EVERY_MS, run: async () => { await this.runner.shipAll(); } });
    this.logger.log("WAL shipper sweep scheduled");
  }
}
