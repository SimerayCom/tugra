import { RolloutSchedulerService, ACTIVE_TICK_MS, IDLE_TICK_MS } from "./rollout-scheduler.service";
import { RolloutEngineService } from "./rollout-engine.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

const OLD = process.env.NODE_ENV;

/** An engine stub: `lives` is how many rollouts each successive tick reports live (the last value repeats). */
function make(lives: number[]) {
  let i = 0;
  let wake: (() => void) | undefined;
  const tick = jest.fn().mockImplementation(async () => lives[Math.min(i++, lives.length - 1)]);
  const engine = {
    tick,
    onWake: jest.fn((l: () => void) => {
      wake = l;
      return () => undefined;
    }),
  } as unknown as RolloutEngineService;
  const ticks = new FakeTicks();
  const svc = new RolloutSchedulerService(ticks.asService(), engine);
  return { svc, tick, ticks, wake: () => wake!() };
}

beforeEach(() => {
  process.env.NODE_ENV = "production";
  jest.useFakeTimers();
});
afterEach(() => {
  process.env.NODE_ENV = OLD;
  jest.useRealTimers();
});

describe("RolloutSchedulerService (event-driven, idle back-off)", () => {
  it("does nothing under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const { svc, ticks, tick } = make([0]);
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(ticks.registered).toEqual([]);
    expect(tick).not.toHaveBeenCalled();
  });

  it("idle: the only recurring tick is a 60 s safety net on the shared scheduler (was a 5 s job); the boot kick finds nothing and stops", async () => {
    const { svc, ticks, tick } = make([0]);
    await svc.onApplicationBootstrap();
    expect(ticks.spec("rollout-tick").every).toBe(IDLE_TICK_MS);
    expect(IDLE_TICK_MS).toBeGreaterThanOrEqual(12 * ACTIVE_TICK_MS);
    await jest.advanceTimersByTimeAsync(3_000); // boot kick
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(59_000); // nothing live -> no fast loop, no extra ticks
    expect(tick).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });

  it("a live rollout found by the boot kick (the previous process died mid-rollout) starts the 5 s loop, which stops by itself when nothing is left", async () => {
    const { svc, tick } = make([1, 1, 1, 0]);
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(ACTIVE_TICK_MS); // reports 0 live -> loop ends after this one
    expect(tick).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(4);
    await svc.onModuleDestroy();
  });

  it("creating / resuming a rollout wakes the fast loop at once instead of waiting for the idle poll", async () => {
    const { svc, tick, wake } = make([0, 1, 0]);
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(3_000); // boot kick: idle
    expect(tick).toHaveBeenCalledTimes(1);
    wake(); // engine.advance() from RolloutsService.create
    await jest.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(3);
    await svc.onModuleDestroy();
  });

  it("a wake that lands while a tick is running is not lost, and ticks never overlap", async () => {
    let release!: (n: number) => void;
    const tick = jest.fn().mockImplementationOnce(() => new Promise<number>((r) => (release = r))).mockResolvedValue(0);
    let wakeFn!: () => void;
    const engine = { tick, onWake: (l: () => void) => ((wakeFn = l), () => undefined) } as unknown as RolloutEngineService;
    const svc = new RolloutSchedulerService(new FakeTicks().asService(), engine);
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(3_000); // boot kick starts a slow tick
    expect(tick).toHaveBeenCalledTimes(1);
    void svc.runTick(); // the 60 s safety net fires meanwhile: skipped, not run in parallel
    expect(tick).toHaveBeenCalledTimes(1);
    wakeFn(); // a rollout was created while the tick was still reading
    release(0); // that tick had seen nothing live
    await jest.advanceTimersByTimeAsync(ACTIVE_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2); // the wake still got its fast tick
    await svc.onModuleDestroy();
  });

  it("a failing tick is logged and never breaks the loop", async () => {
    const tick = jest.fn().mockRejectedValueOnce(new Error("db")).mockResolvedValue(0);
    const engine = { tick, onWake: () => () => undefined } as unknown as RolloutEngineService;
    const svc = new RolloutSchedulerService(new FakeTicks().asService(), engine);
    const warn = jest.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rollout tick failed"));
    await expect(svc.runTick()).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it("stops everything on shutdown (no timer left behind)", async () => {
    const { svc, tick } = make([1]);
    await svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(3_000);
    await svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
