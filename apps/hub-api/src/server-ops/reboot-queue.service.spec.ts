const queueAdd = jest.fn().mockResolvedValue(undefined);
const queueRemove = jest.fn().mockResolvedValue(1);
const queueClose = jest.fn().mockResolvedValue(undefined);
const queueCtor = jest.fn();
let workerProcessor: ((job: { name: string; data: unknown }) => Promise<void>) | null = null;
const workerClose = jest.fn().mockResolvedValue(undefined);
jest.mock("bullmq", () => ({
  Queue: function Queue(...args: unknown[]) {
    queueCtor(...args);
    return { add: queueAdd, remove: queueRemove, close: queueClose };
  },
  Worker: function Worker(_name: string, processor: (job: { name: string; data: unknown }) => Promise<void>) {
    workerProcessor = processor;
    return { close: workerClose, on: jest.fn() };
  },
}));

import type { ConfigService } from "@nestjs/config";
import { RebootQueueService, rebootJobId } from "./reboot-queue.service";
import { rebootTiming } from "./reboot-logic";

const config = { get: () => "redis://localhost:6379" } as unknown as ConfigService;
const OLD = process.env.NODE_ENV;

describe("RebootQueueService (BullMQ is mocked; the real queue needs Redis)", () => {
  beforeEach(() => {
    queueAdd.mockClear();
    queueRemove.mockClear();
    queueCtor.mockClear();
    workerProcessor = null;
  });
  afterEach(() => {
    process.env.NODE_ENV = OLD;
  });

  it("is a no-op in test env (no queue, nothing scheduled)", async () => {
    process.env.NODE_ENV = "test";
    const q = new RebootQueueService(config);
    await q.start({ tick: jest.fn(), due: jest.fn() });
    await q.scheduleAt("r1", new Date(Date.now() + 1000));
    await q.unschedule("r1");
    expect(queueCtor).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("starts a recurring watcher and routes tick / due jobs to the handlers", async () => {
    process.env.NODE_ENV = "production";
    const tick = jest.fn().mockResolvedValue(undefined);
    const due = jest.fn().mockResolvedValue(undefined);
    const q = new RebootQueueService(config);
    await q.start({ tick, due });
    expect(queueAdd).toHaveBeenCalledWith("reboot-tick", {}, { repeat: { every: rebootTiming.tickMs } });
    await workerProcessor!({ name: "reboot-tick", data: {} });
    await workerProcessor!({ name: "reboot-due", data: { rebootId: "r7" } });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(due).toHaveBeenCalledWith("r7");
  });

  it("queues a scheduled reboot as a delayed job with a stable id (re-adding after a hub restart is harmless)", async () => {
    process.env.NODE_ENV = "production";
    const q = new RebootQueueService(config);
    await q.start({ tick: jest.fn(), due: jest.fn() });
    queueAdd.mockClear();
    const now = 1_000_000;
    await q.scheduleAt("r1", new Date(now + 90_000), now);
    expect(queueAdd).toHaveBeenCalledWith("reboot-due", { rebootId: "r1" }, { jobId: rebootJobId("r1"), delay: 90_000 });
    // an overdue one (the hub was down at its time) fires at once
    await q.scheduleAt("r2", new Date(now - 5_000), now);
    expect(queueAdd).toHaveBeenLastCalledWith("reboot-due", { rebootId: "r2" }, { jobId: rebootJobId("r2"), delay: 0 });
  });

  it("unschedule removes the delayed job by its id and tolerates one that is already gone", async () => {
    process.env.NODE_ENV = "production";
    const q = new RebootQueueService(config);
    await q.start({ tick: jest.fn(), due: jest.fn() });
    await q.unschedule("r1");
    expect(queueRemove).toHaveBeenCalledWith("reboot-r1");
    queueRemove.mockRejectedValueOnce(new Error("gone"));
    await expect(q.unschedule("r1")).resolves.toBeUndefined();
  });

  it("closes the worker and queue on shutdown", async () => {
    process.env.NODE_ENV = "production";
    const q = new RebootQueueService(config);
    await q.start({ tick: jest.fn(), due: jest.fn() });
    await q.onModuleDestroy();
    expect(workerClose).toHaveBeenCalled();
    expect(queueClose).toHaveBeenCalled();
  });
});
