import { RebootQueueService, rebootJobId } from "./reboot-queue.service";
import { rebootTiming } from "./reboot-logic";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

const OLD = process.env.NODE_ENV;

describe("RebootQueueService (on the shared scheduler; the real BullMQ path is covered by the Redis integration spec)", () => {
  afterEach(() => {
    process.env.NODE_ENV = OLD;
  });

  it("is a no-op in test env (nothing registered)", async () => {
    process.env.NODE_ENV = "test";
    const t = new FakeTicks();
    const q = new RebootQueueService(t.asService());
    await q.start({ tick: jest.fn(), due: jest.fn() });
    expect(t.registered).toEqual([]);
    expect(t.handlers.size).toBe(0);
  });

  it("starts a recurring watcher and routes the delayed due job to its handler", async () => {
    process.env.NODE_ENV = "production";
    const tick = jest.fn().mockResolvedValue(undefined);
    const due = jest.fn().mockResolvedValue(undefined);
    const t = new FakeTicks();
    await new RebootQueueService(t.asService()).start({ tick, due });
    expect(t.spec("reboot-tick").every).toBe(rebootTiming.tickMs);
    await t.run("reboot-tick");
    await t.handlers.get("reboot-due")!({ name: "reboot-due", data: { rebootId: "r7" } });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(due).toHaveBeenCalledWith("r7");
  });

  it("a failing due handler rethrows (so BullMQ records the failure)", async () => {
    process.env.NODE_ENV = "production";
    const t = new FakeTicks();
    const q = new RebootQueueService(t.asService());
    jest.spyOn((q as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    await q.start({ tick: jest.fn(), due: jest.fn().mockRejectedValue(new Error("boom")) });
    await expect(t.handlers.get("reboot-due")!({ name: "reboot-due", data: { rebootId: "r1" } })).rejects.toThrow("boom");
  });

  it("queues a scheduled reboot as a delayed job with a stable id (re-adding after a hub restart is harmless)", async () => {
    const t = new FakeTicks();
    const q = new RebootQueueService(t.asService());
    const at = new Date(1_000_000 + 90_000);
    await q.scheduleAt("r1", at, 1_000_000);
    expect(t.enqueued).toEqual([{ name: "reboot-due", data: { rebootId: "r1" }, jobId: rebootJobId("r1"), at }]);
  });

  it("unschedule removes the delayed job by its id", async () => {
    const t = new FakeTicks();
    await new RebootQueueService(t.asService()).unschedule("r1");
    expect(t.removed).toEqual(["reboot-r1"]);
  });
});
