import { ImageUpdateSchedulerService } from "./image-update.scheduler.service";
import type { ImageUpdateService } from "./image-update.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

describe("ImageUpdateSchedulerService", () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
    jest.useRealTimers();
  });

  it("is a no-op under NODE_ENV=test (no tick, no boot timer)", async () => {
    const runTick = jest.fn();
    const t = new FakeTicks();
    const svc = new ImageUpdateSchedulerService(t.asService(), { runTick, intervalMin: () => 360 } as unknown as ImageUpdateService);
    await svc.onApplicationBootstrap();
    expect(t.registered).toEqual([]);
    expect((svc as unknown as { bootTimer?: unknown }).bootTimer).toBeUndefined();
    expect(runTick).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it("kill switch (interval 0) registers nothing and drops a schedule an earlier boot left behind", async () => {
    process.env.NODE_ENV = "production";
    const t = new FakeTicks();
    await new ImageUpdateSchedulerService(t.asService(), { runTick: jest.fn(), intervalMin: () => 0 } as unknown as ImageUpdateService).onApplicationBootstrap();
    expect(t.registered).toEqual([]);
    expect(t.disabled).toEqual(["image-update-check"]);
  });

  it("registers the 10-minute tick and kicks one probe tick shortly after boot", async () => {
    process.env.NODE_ENV = "production";
    jest.useFakeTimers();
    const runTick = jest.fn().mockResolvedValue(undefined);
    const t = new FakeTicks();
    const svc = new ImageUpdateSchedulerService(t.asService(), { runTick, intervalMin: () => 360 } as unknown as ImageUpdateService);
    await svc.onApplicationBootstrap();
    expect(t.spec("image-update-check").every).toBe(10 * 60 * 1000);
    expect(runTick).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(runTick).toHaveBeenCalledTimes(1);
    await t.run("image-update-check");
    expect(runTick).toHaveBeenCalledTimes(2);
    await svc.onModuleDestroy();
  });
});
