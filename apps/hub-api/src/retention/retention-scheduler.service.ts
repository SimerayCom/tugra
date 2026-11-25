import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { RetentionRunnerService } from "./retention-runner.service";
import { legacyRetentionNotes } from "../metrics/metric-tiers";

const HOURLY_MS = 3600 * 1000;

@Injectable()
export class RetentionSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly runner: RetentionRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Disabled in tests; the runner is exercised directly via unit specs.
    if (process.env.NODE_ENV === "test") return;

    for (const note of legacyRetentionNotes()) this.logger.warn(`retention changed with the metric tiers: ${note}`);

    await this.ticks.register({ name: "retention-prune", every: HOURLY_MS, run: () => this.runner.prune() });
    this.logger.log("scheduled hourly metrics/heartbeat retention prune");
  }
}
