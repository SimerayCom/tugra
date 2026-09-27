import { SwarmSchedulerService } from "./swarm.scheduler.service";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { SwarmService } from "./swarm.service";
import type { NotificationsService } from "../notifications/notifications.service";

// The BullMQ Queue+Worker path needs Redis (CI e2e); the real logic lives in runTick(), unit-tested here.
describe("SwarmSchedulerService", () => {
  const config = {
    get: (k: string) => ({ REDIS_URL: "redis://localhost:6379", SWARM_STATUS_INTERVAL_SEC: 60 } as Record<string, unknown>)[k],
  } as unknown as ConfigService;

  function make(clusters: Array<{ id: string; name: string; teamId: string }>, statusImpl: (id: string) => Promise<unknown>) {
    const findMany = jest.fn().mockResolvedValue(clusters);
    const prisma = { cluster: { findMany } } as unknown as PrismaService;
    const statusInternal = jest.fn(statusImpl);
    const swarm = { statusInternal } as unknown as SwarmService;
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const notifications = { fireForEvent } as unknown as NotificationsService;
    return { svc: new SwarmSchedulerService(config, prisma, swarm, notifications), findMany, statusInternal, fireForEvent };
  }

  const degraded = { swarmStatus: "DEGRADED", nodes: [{ swarmRole: "MANAGER" }, { swarmRole: "WORKER" }], live: [{ state: "ready" }] };
  const active = { swarmStatus: "ACTIVE", nodes: [{ swarmRole: "MANAGER" }], live: [{ state: "ready" }] };

  const OLD = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = OLD; });

  it("is a no-op in test env (never opens a queue/worker)", async () => {
    process.env.NODE_ENV = "test";
    const { svc, findMany } = make([], async () => active);
    await svc.onApplicationBootstrap(); // must not throw or need Redis
    expect(findMany).not.toHaveBeenCalled();
  });

  it("only fetches ACTIVE clusters (a DEGRADED/NONE cluster is never re-notified)", async () => {
    const { svc, findMany } = make([], async () => active);
    await svc.runTick();
    expect(findMany).toHaveBeenCalledWith({ where: { swarmStatus: "ACTIVE" }, select: { id: true, name: true, teamId: true } });
  });

  it("fires swarm_degraded once on a real ACTIVE→DEGRADED edge", async () => {
    const { svc, fireForEvent } = make([{ id: "c1", name: "prod", teamId: "t1" }], async () => degraded);
    await svc.runTick();
    expect(fireForEvent).toHaveBeenCalledTimes(1);
    expect(fireForEvent).toHaveBeenCalledWith("t1", "swarm_degraded", expect.objectContaining({ clusterId: "c1", clusterName: "prod", readyCount: 1, joinedCount: 2 }));
  });

  it("does NOT notify a cluster that is still ACTIVE", async () => {
    const { svc, fireForEvent } = make([{ id: "c1", name: "prod", teamId: "t1" }], async () => active);
    await svc.runTick();
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("isolates a failing cluster: the rest of the tick still runs", async () => {
    const { svc, fireForEvent, statusInternal } = make(
      [
        { id: "c1", name: "a", teamId: "t1" },
        { id: "c2", name: "b", teamId: "t2" },
      ],
      async (id) => {
        if (id === "c1") throw new Error("manager unreachable");
        return degraded;
      },
    );
    await svc.runTick();
    expect(statusInternal).toHaveBeenCalledTimes(2); // c1 threw, c2 still checked
    expect(fireForEvent).toHaveBeenCalledTimes(1);
    expect(fireForEvent).toHaveBeenCalledWith("t2", "swarm_degraded", expect.objectContaining({ clusterId: "c2" }));
  });
});
