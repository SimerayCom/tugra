import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { DigestService } from "./digest.service";

const SWEEP_EVERY_MS = 15 * 60_000;

/** A repeatable sweep (every 15 minutes) that sends whichever weekly digests have come due. Off in tests. */
@Injectable()
export class DigestSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DigestSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly digest: DigestService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.ticks
      .register({ name: "digest-sweep", every: SWEEP_EVERY_MS, run: async () => void (await this.digest.runDue()) })
      .catch((e) => this.logger.warn(`weekly digest sweep not scheduled: ${e instanceof Error ? e.message : e}`));
  }
}
