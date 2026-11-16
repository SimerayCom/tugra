import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { RunOptionsSchema, type WaitSpec } from "./dto";
import type { RunMode, StepKey } from "./run-contract";
import { RunEngineService } from "./run-engine.service";
import { WAIT_STUCK_KEY, isWaitingStep, waitSince } from "./run-logic";
import { RUN_SINK, RUN_STORE, type RunSinkPort } from "./run-ports";
import type { RunStore } from "./run-store";

const TICK_MS = 15_000;
/** Runs are picked up shortly after boot, once the agents have had a moment to reconnect. */
const BOOT_DELAY_MS = 5_000;

/**
 * "Lose the hub without losing the run": at boot and then every 15 s, give every non-terminal, non-paused run that this
 * process is not already driving one engine pass. That one rule is both the crash recovery (a run whose owner is a dead
 * boot is adopted: the engine claims the lease, emits `run.recovered` and re-observes the world) and the polling of parked
 * runs (an operator step is only ever re-observed here; a timer step wakes here once its `notBefore` passed). It also
 * resumes a decommission a restart interrupted and runs the stuck-operator watchdog.
 */
@Injectable()
export class RunRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private boot?: ReturnType<typeof setTimeout>;

  constructor(
    @Inject(RUN_STORE) private readonly store: RunStore,
    private readonly engine: RunEngineService,
    @Inject(RUN_SINK) private readonly sink: RunSinkPort,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.boot = setTimeout(() => void this.tick().catch((e: unknown) => this.logger.warn(`run recovery failed: ${e instanceof Error ? e.message : String(e)}`)), BOOT_DELAY_MS);
    this.boot.unref?.();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.boot) clearTimeout(this.boot);
  }

  /** One pass. Resolves once the passes it started settled; returns the run ids it handed to the engine (for tests). */
  async tick(now: Date = this.engine.clock.now()): Promise<string[]> {
    const rows = await this.store.drivable();
    const driven: Promise<void>[] = [];
    const ids: string[] = [];
    for (const r of rows) {
      if (this.engine.isDriving(r.id)) continue;
      await this.watchdog(r.id, r.mode as RunMode, r.teamId, r.currentStep as StepKey | null, r.options, now).catch(() => undefined);
      ids.push(r.id);
      driven.push(this.engine.drive(r.id, r.ownerId && r.ownerId !== this.engine.bootId ? "recover" : "tick"));
    }
    for (const s of await this.store.manualInFlight()) {
      if (this.engine.isDriving(s.runId)) continue;
      ids.push(s.runId);
      driven.push(this.engine.driveManual(s.runId, s.key as StepKey, "recover"));
    }
    await Promise.all(driven);
    return ids;
  }

  /** Notify (once per wait) when an operator or approval wait outlives `stuckOperatorMinutes`. */
  private async watchdog(runId: string, mode: RunMode, teamId: string, current: StepKey | null, optionsRaw: unknown, now: Date): Promise<void> {
    if (!current) return;
    const step = (await this.store.steps(runId)).find((s) => s.key === current);
    if (!step || !isWaitingStep(step.status) || !step.wait) return;
    const wait = step.wait as WaitSpec & Record<string, unknown>;
    if (wait.kind === "timer" || wait[WAIT_STUCK_KEY] === true) return;
    const since = waitSince(wait);
    if (!since) return;
    const minutes = RunOptionsSchema.parse(optionsRaw).stuckOperatorMinutes;
    if (now.getTime() - Date.parse(since) < minutes * 60_000) return;
    const marked = await this.store.updateStepIf(runId, current, [step.status], { wait: { ...wait, [WAIT_STUCK_KEY]: true } });
    if (!marked) return;
    await this.sink.notify(teamId, { runId, kind: "stuck-operator", mode, stepKey: current, code: wait.kind === "approval" ? "step.waiting-approval" : wait.code });
  }
}

