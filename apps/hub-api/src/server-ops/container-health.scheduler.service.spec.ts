import { ContainerHealthSchedulerService } from "./container-health.scheduler.service";
import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { ConfigService } from "@nestjs/config";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

// Each result is the list of settling container keys for that poll (a boolean is shorthand for one container "c").
function make(results: (boolean | string[])[]) {
  let i = 0;
  const runTick = jest.fn().mockImplementation(() => {
    const r = results[Math.min(i++, results.length - 1)];
    const settlingKeys = typeof r === "boolean" ? (r ? ["c"] : []) : r;
    return Promise.resolve({ settling: settlingKeys.length > 0, settlingKeys });
  });
  const ticks = new FakeTicks();
  const svc = new ContainerHealthSchedulerService({ get: jest.fn() } as unknown as ConfigService, ticks.asService(), { runTick } as unknown as ContainerHealthRunnerService);
  return { svc, runTick, ticks };
}

describe("ContainerHealthSchedulerService fast follow-up", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("re-checks soon while a container is settling, and stops once it has settled", async () => {
    const { svc, runTick } = make([true, true, false]);
    await svc.tickAndFollowUp();
    expect(runTick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runTick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runTick).toHaveBeenCalledTimes(3); // this one reports settled → no further follow-up
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runTick).toHaveBeenCalledTimes(3);
    await svc.onModuleDestroy();
  });

  it("does nothing extra when nothing is settling", async () => {
    const { svc, runTick } = make([false]);
    await svc.tickAndFollowUp();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(runTick).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });

  it("caps a container stuck settling at a bounded number of quick re-checks", async () => {
    const { svc, runTick } = make([true]);
    await svc.tickAndFollowUp();
    await jest.advanceTimersByTimeAsync(10_000 * 100);
    expect(runTick).toHaveBeenCalledTimes(31); // the interval tick + 30 quick re-checks
    await svc.onModuleDestroy();
  });

  it("does not schedule follow-ups after shutdown", async () => {
    const { svc, runTick } = make([true]);
    await svc.onModuleDestroy();
    await svc.tickAndFollowUp();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("a container stuck settling does not starve a later, unrelated transition", async () => {
    // A crash-looping container "a" settles forever; after its budget is spent, container "b" starts settling.
    const { svc, runTick } = make([["a"]]);
    await svc.tickAndFollowUp();
    await jest.advanceTimersByTimeAsync(10_000 * 60);
    // a: interval tick + 30 quick re-checks = 31 polls, then it stops buying follow-ups (poll #32 never happens on its own).
    expect(runTick).toHaveBeenCalledTimes(31);
    // The next interval tick sees "b" appear: b has a fresh budget, so a follow-up is scheduled despite a being capped.
    runTick.mockClear();
    (runTick as jest.Mock).mockImplementation(() => Promise.resolve({ settling: true, settlingKeys: ["a", "b"] }));
    await svc.tickAndFollowUp();
    expect(runTick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runTick).toHaveBeenCalledTimes(2);
    await svc.onModuleDestroy();
  });

  it("forgets a container once it stops settling, so a later episode gets a fresh budget", async () => {
    const { svc, runTick } = make([["a"], ["a"], [], ["a"]]);
    (runTick as jest.Mock).mockClear();
    await svc.tickAndFollowUp(); // a (streak 1) → follow-up
    await jest.advanceTimersByTimeAsync(10_000); // a (2)
    await jest.advanceTimersByTimeAsync(10_000); // settled → streak dropped, no more follow-ups
    expect(runTick).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runTick).toHaveBeenCalledTimes(3);
    await svc.onModuleDestroy();
  });
});

describe("ContainerHealthSchedulerService registration", () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
  });

  it("registers one 60 s tick on the shared scheduler whose run is the poll + fast follow-up; nothing under test", async () => {
    const test = make([false]);
    process.env.NODE_ENV = "test";
    await test.svc.onApplicationBootstrap();
    expect(test.ticks.registered).toEqual([]);

    const { svc, runTick, ticks } = make([false]);
    process.env.NODE_ENV = "production";
    await svc.onApplicationBootstrap();
    expect(ticks.spec("container-health").every).toBe(60_000);
    await ticks.run("container-health");
    expect(runTick).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });
});
