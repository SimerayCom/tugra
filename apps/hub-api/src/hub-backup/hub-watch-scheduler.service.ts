import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { HubRestoreDrillService } from "./hub-restore-drill.service";
import { HubDeadmanService } from "./hub-deadman.service";

const DRILL_JOB = "hub-backup-drill";
/** 03:20 on the 1st of every month. */
export const DRILL_CRON = "20 3 1 * *";
const DEADMAN_JOB = "hub-deadman";

/** Two scheduled jobs: the monthly restore drill and the dead-man check-in. Disabled in tests (no Redis). */
@Injectable()
export class HubWatchSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HubWatchSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly prisma: PrismaService,
    private readonly drills: HubRestoreDrillService,
    private readonly deadman: HubDeadmanService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    try {
      await this.applyDrill();
      await this.applyDeadman();
    } catch (e) {
      this.logger.warn(`hub watch schedules not applied: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async runDrillIfEnabled(): Promise<void> {
    const cfg = await this.prisma.hubBackupConfig.findUnique({ where: { id: "singleton" } });
    if (cfg && !cfg.drillEnabled) return;
    // nothing to drill without a stored hub backup (a manual one counts: the schedule need not be on)
    if ((await this.prisma.hubBackup.count({ where: { status: "SUCCESS" } })) === 0) return;
    await this.drills.run("schedule").catch((e) => this.logger.warn(`scheduled restore drill could not run: ${e instanceof Error ? e.message : e}`));
  }

  /** Always scheduled; the job itself checks the switch, so toggling needs no re-apply. */
  async applyDrill(): Promise<void> {
    await this.ticks.register({ name: DRILL_JOB, pattern: DRILL_CRON, run: () => this.runDrillIfEnabled() });
  }

  /** A one-minute tick; the service decides whether a check-in is due (so an interval change needs no re-schedule). */
  async applyDeadman(): Promise<void> {
    await this.ticks.register({ name: DEADMAN_JOB, every: 60_000, run: () => this.deadman.tick() });
  }
}
