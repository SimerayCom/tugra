import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { HubBackupRunnerService } from "./hub-backup-runner.service";

const JOB = "hub-backup"; // single scheduled job (one hub DB)

/** A single scheduled job for the hub-DB backup on the shared scheduler queue, disabled in tests. */
@Injectable()
export class HubBackupSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HubBackupSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly prisma: PrismaService,
    private readonly runner: HubBackupRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // driven directly via POST /instance/backup/run in tests
    const cfg = await this.prisma.hubBackupConfig.findUnique({ where: { id: "singleton" } });
    await this.applySafe(cfg ?? null);
  }

  /** {@link apply} that never throws: a bad stored cron must not crash the hub at boot (BullMQ throws on an invalid pattern). */
  async applySafe(cfg: { enabled: boolean; intervalHours: number; cron?: string | null } | null): Promise<void> {
    try {
      await this.apply(cfg);
    } catch (e) {
      this.logger.warn(`skipped hub backup schedule (cron "${cfg?.cron}"): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** (Re)apply the schedule from the current config: replace the scheduled job when enabled, remove it otherwise. */
  async apply(cfg: { enabled: boolean; intervalHours: number; cron?: string | null } | null): Promise<void> {
    if (!cfg?.enabled) {
      await this.unschedule();
      return;
    }
    const run = async () => {
      await this.runner.runBackup("scheduler");
    };
    // A cron expression wins over the plain interval.
    if (cfg.cron) {
      await this.ticks.register({ name: JOB, pattern: cfg.cron, run });
      this.logger.log(`hub backup scheduled on cron "${cfg.cron}"`);
    } else {
      await this.ticks.register({ name: JOB, every: cfg.intervalHours * 3600_000, run });
      this.logger.log(`hub backup scheduled every ${cfg.intervalHours}h`);
    }
  }

  async unschedule(): Promise<void> {
    await this.ticks.disable(JOB);
  }
}
