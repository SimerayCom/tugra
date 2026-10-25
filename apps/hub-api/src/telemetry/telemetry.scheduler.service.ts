import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { TelemetryService } from "./telemetry.service";

const QUEUE = "telemetry";

/**
 * Periodic anonymous-stats sender (ON by default, opt-out). Mirrors the house recurring-job pattern
 * (BullMQ Queue+Worker in OnApplicationBootstrap, disabled in tests). It is NOT started at all when
 * TUGRA_TELEMETRY=0 — a deployment hard-off then makes ZERO outbound calls and touches neither Redis nor
 * the network. When it is started, each send re-checks the owner-UI toggle (TelemetryService.sendNow), so
 * flipping telemetry off in the UI stops sends WITHOUT a restart. The send never throws.
 */
@Injectable()
export class TelemetrySchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelemetrySchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly telemetry: TelemetryService,
    private readonly settings: InstanceSettingsService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

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
      this.logger.log("telemetry disabled by environment (TUGRA_TELEMETRY=0) — not scheduling");
      return; // hard off: no Redis, no network, nothing
    }
    const intervalMin = this.telemetry.intervalMin();
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => { await this.telemetry.sendNow(); }, { connection });
    // Remove any stale repeatable keyed by a previous interval, so changing TUGRA_TELEMETRY_INTERVAL_MIN
    // doesn't leave two jobs firing at once (BullMQ keys a repeat by its `every` value).
    for (const r of await this.queue.getRepeatableJobs()) {
      if (r.name === "telemetry") await this.queue.removeRepeatableByKey(r.key);
    }
    await this.queue.add("telemetry", {}, { repeat: { every: intervalMin * 60_000 } });
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

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
