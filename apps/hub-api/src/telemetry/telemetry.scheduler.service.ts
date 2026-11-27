import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { TelemetryService } from "./telemetry.service";

/**
 * Periodic anonymous-stats sender (ON by default, opt-out). Mirrors the house recurring-job pattern
 * (BullMQ Queue+Worker in OnApplicationBootstrap, disabled in tests). It is NOT started at all when
 * TUGRA_STATS=0 — a deployment hard-off then makes ZERO outbound calls (it only drops a schedule
 * an earlier boot may have left in the hub's own Redis). When it is started, each send re-checks the owner-UI toggle (TelemetryService.sendNow), so
 * flipping telemetry off in the UI stops sends WITHOUT a restart. The send never throws.
 */
@Injectable()
export class TelemetrySchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelemetrySchedulerService.name);

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly telemetry: TelemetryService,
    private readonly settings: InstanceSettingsService,
  ) {}

  /** Avoid a send on every quick restart: only do the initial boot send when the last successful send is
   *  older than roughly the configured interval. The recurring job owns steady-state cadence. */
  private async dueForInitialSend(intervalMin: number): Promise<boolean> {
    try {
      const s = await this.settings.get();
      if (!s.telemetryLastSentAt) return true;
      const ageMin = (Date.now() - s.telemetryLastSentAt.getTime()) / 60_000;
      return ageMin >= intervalMin;
    } catch {
      return false; // a transient DB error just defers the initial send to the recurring job
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    if (this.telemetry.isForcedOff()) {
      this.logger.log("usage stats disabled by environment (TUGRA_STATS=0) — not scheduling");
      await this.ticks.disable("telemetry"); // hard off now, but an earlier boot may have left its schedule behind
      return; // hard off: no network, nothing scheduled
    }
    const intervalMin = this.telemetry.intervalMin();
    // A job scheduler is keyed by id, not by its interval, so changing TUGRA_STATS_INTERVAL_MIN updates the one
    // schedule in place (no stale second job to clean up).
    await this.ticks.register({ name: "telemetry", every: intervalMin * 60_000, run: async () => { await this.telemetry.sendNow(); } });
    this.logger.log(`scheduled anonymous stats every ${intervalMin}m`);
    // Initial send is fire-and-forget, ~1 min after boot: NestJS runs bootstrap hooks before it accepts
    // connections, so awaiting a network call here would delay boot by up to the send timeout when the
    // endpoint is blackholed. The delay also gives a fresh install a moment before its first ping. It
    // re-checks the owner toggle inside sendNow, so a UI-disabled box still sends nothing.
    if (await this.dueForInitialSend(intervalMin)) {
      const t = setTimeout(() => {
        void this.telemetry
          .sendNow()
          .then((r) => this.logger.debug?.(`initial telemetry send: ${r.status}`))
          .catch((e) => this.logger.warn(`initial telemetry send failed: ${String(e)}`));
      }, 60_000);
      t.unref?.();
    }
  }
}
