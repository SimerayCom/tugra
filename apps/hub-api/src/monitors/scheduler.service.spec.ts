import { MonitorSchedulerService } from "./scheduler.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { MonitorRunnerService } from "./runner.service";
import { FakeHub } from "../scheduler/testing/fake-hub";

describe("MonitorSchedulerService", () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
  });

  function make(monitors: Array<{ id: string; intervalSec: number }>) {
    const hub = new FakeHub();
    const runCheck = jest.fn().mockResolvedValue(undefined);
    const prisma = { monitor: { findMany: jest.fn().mockResolvedValue(monitors) } } as unknown as PrismaService;
    const svc = new MonitorSchedulerService(hub.asService(), prisma, { runCheck } as unknown as MonitorRunnerService);
    return { svc, hub, runCheck };
  }

  it("is a no-op under NODE_ENV=test (no queue is created)", async () => {
    process.env.NODE_ENV = "test";
    const { svc, hub } = make([{ id: "m1", intervalSec: 30 }]);
    await svc.onApplicationBootstrap();
    expect(hub.queues.size).toBe(0);
  });

  it("creates the monitors queue on the shared hub, schedules every enabled monitor and runs its check from the worker", async () => {
    process.env.NODE_ENV = "production";
    const { svc, hub, runCheck } = make([{ id: "m1", intervalSec: 30 }, { id: "m2", intervalSec: 60 }]);
    await svc.onApplicationBootstrap();
    const q = hub.queues.get("monitors")!;
    expect(q.added).toEqual([
      { name: "check:m1", data: { monitorId: "m1" }, opts: { repeat: { every: 30_000 } } },
      { name: "check:m2", data: { monitorId: "m2" }, opts: { repeat: { every: 60_000 } } },
    ]);
    await hub.processors.get("monitors")!({ name: "check:m1", data: { monitorId: "m1" } });
    expect(runCheck).toHaveBeenCalledWith("m1");
  });

  it("unschedule removes only that monitor's repeat key", async () => {
    process.env.NODE_ENV = "production";
    const { svc, hub } = make([]);
    await svc.onApplicationBootstrap();
    const q = hub.queues.get("monitors")!;
    q.repeatables = [{ name: "check:m1", key: "k1" }, { name: "check:m2", key: "k2" }];
    await svc.unschedule("m1");
    expect(q.removedKeys).toEqual(["k1"]);
  });
});
