import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { RolloutEngineService } from "./rollout-engine.service";

const TICK_JOB = "rollout-tick";
/** While a rollout is live the engine is ticked this often (an in-process loop: nothing is written to Redis per tick). */
export const ACTIVE_TICK_MS = 5_000;
/** The safety-net poll while nothing is live: picks up a live rollout nobody woke the loop for (e.g. a row left by
 *  another process) and runs the slot self-heal. Starting or resuming a rollout wakes the loop at once instead. */
export const IDLE_TICK_MS = 60_000;
const BOOT_KICK_MS = 3_000;

/**
 * Drives the rollout engine's stateless tick. It is event-driven with an idle back-off, not a fixed 5 s job:
 *  - the engine's `advance()` (called when a rollout is created, resumed or rolled back) wakes the fast loop;
 *  - the fast loop ticks every 5 s only while the last tick found a live rollout and stops by itself when none is left;
 *  - while idle, a single 60 s tick on the shared scheduler queue is the safety net (12x fewer wake-ups than the old
 *    5 s job, no DB or Redis traffic in between).
 * A tick never awaits a build. Disabled under NODE_ENV=test — specs call tick()/advance() directly. A boot kick settles
 * what the previous process left behind as soon as the reconcile has run.
 */
@Injectable()
export class RolloutSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RolloutSchedulerService.name);
  private kick?: ReturnType<typeof setTimeout>;
  private loop?: ReturnType<typeof setTimeout>;
  private running = false;
  private rewake = false;
  private stopped = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly ticks: TickSchedulerService,
    private readonly engine: RolloutEngineService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    this.unsubscribe = this.engine.onWake(() => this.wake());
    await this.ticks.register({ name: TICK_JOB, every: IDLE_TICK_MS, run: () => this.runTick() });
    this.kick = setTimeout(() => void this.runTick().catch(() => undefined), BOOT_KICK_MS);
    this.kick.unref();
    this.logger.log(`rollout tick scheduled (idle poll ${IDLE_TICK_MS / 1000}s, ${ACTIVE_TICK_MS / 1000}s while a rollout is live)`);
  }

  /** One engine tick; keeps the fast loop going while rollouts are live and lets it lapse when none are. Never overlaps itself. */
  async runTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const live = await this.engine.tick();
      this.arm(live > 0 || this.rewake);
    } catch (e) {
      this.logger.warn(`rollout tick failed: ${e instanceof Error ? e.message : e}`);
      this.arm(this.rewake);
    } finally {
      this.rewake = false;
      this.running = false;
    }
  }

  /** A rollout became live: start the fast loop unless it is already running. */
  wake(): void {
    if (this.stopped) return;
    if (this.running) this.rewake = true; // a wake that lands mid-tick must not be lost
    else this.arm(true);
  }

  private arm(active: boolean): void {
    if (this.loop) {
      clearTimeout(this.loop);
      this.loop = undefined;
    }
    if (!active || this.stopped) return;
    this.loop = setTimeout(() => {
      this.loop = undefined;
      void this.runTick();
    }, ACTIVE_TICK_MS);
    this.loop.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.kick) clearTimeout(this.kick);
    if (this.loop) clearTimeout(this.loop);
  }
}
