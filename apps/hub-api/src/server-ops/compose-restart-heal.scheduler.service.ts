import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { ComposeRestartHealService } from "./compose-restart-heal.service";

/** The tick fires often; the per-server throttle inside the service (HEAL_INTERVAL_MS) decides who is actually due. */
export const HEAL_TICK_MS = 5 * 60 * 1000;

/** Own repeatable job for the compose restart-policy self-heal, so a slow or hung agent cannot delay the 60s container-health crash/OOM poll.
 *  Disabled in tests (house convention). */
@Injectable()
export class ComposeRestartHealSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ComposeRestartHealSchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly heal: ComposeRestartHealService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.ticks.register({ name: "compose-restart-heal", every: HEAL_TICK_MS, run: async () => { await this.heal.runTick(); } });
    this.logger.log(`scheduled compose restart-policy heal every ${HEAL_TICK_MS / 1000}s`);
  }
}
