import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { ExpiryRunnerService } from "./expiry-runner.service";

const DAILY_MS = 24 * 3600 * 1000;

@Injectable()
export class ExpirySchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExpirySchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly runner: ExpiryRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Disabled in tests; the runner is exercised directly via unit specs.
    if (process.env.NODE_ENV === "test") return;
    await this.ticks.register({ name: "expiry-check", every: DAILY_MS, run: () => this.runner.runChecks() });
    this.logger.log("scheduled daily SSL/token expiry check");
  }
}
