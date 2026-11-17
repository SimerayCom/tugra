import { ContainerHealthSchedulerService } from "./container-health.scheduler.service";
import { ContainerHealthRunnerService } from "./container-health.runner.service";
import { ConfigService } from "@nestjs/config";

function make(results: boolean[]) {
  let i = 0;
  const runTick = jest.fn().mockImplementation(() => Promise.resolve({ settling: results[Math.min(i++, results.length - 1)] }));
  const svc = new ContainerHealthSchedulerService({ get: jest.fn() } as unknown as ConfigService, { runTick } as unknown as ContainerHealthRunnerService);
  return { svc, runTick };
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
});
