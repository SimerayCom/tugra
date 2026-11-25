import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { MetricsRollupRunnerService } from "./metrics-rollup-runner.service";

const ROLLUP_MS = 2 * 60_000; // every 2 minutes: enough that whole minutes are always settled

@Injectable()
export class MetricsRollupSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MetricsRollupSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly runner: MetricsRollupRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Disabled in tests; the runner is exercised directly via unit specs.
    if (process.env.NODE_ENV === "test") return;
    await this.ticks.register({ name: "metrics-rollup", every: ROLLUP_MS, run: () => this.runner.roll() });
    this.logger.log("scheduled 1-minute metrics rollup");
  }
}
