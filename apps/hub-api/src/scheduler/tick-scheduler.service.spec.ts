import { TickSchedulerService, SCHEDULER_QUEUE, tickSchedulerId, nextBoundary, MAX_CONSECUTIVE_SKIPS } from "./tick-scheduler.service";
import { FakeHub } from "./testing/fake-hub";

jest.mock("./legacy-queues", () => ({ retireLegacyQueues: jest.fn().mockResolvedValue({ retiredQueues: [], removedRepeatables: 0, movedJobs: 0 }) }));

const OLD = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = OLD;
  jest.useRealTimers();
});

function make() {
  process.env.NODE_ENV = "production";
  const hub = new FakeHub();
  const svc = new TickSchedulerService(hub.asService());
  void svc.onApplicationBootstrap(); // creates the queue + worker, as Nest does at boot
  const queue = () => hub.queues.get(SCHEDULER_QUEUE)!;
  const dispatch = (name: string, data: unknown = {}) => hub.processors.get(SCHEDULER_QUEUE)!({ name, data });
  return { hub, svc, queue, dispatch };
}

describe("TickSchedulerService", () => {
  it("runs ONE queue and ONE worker for any number of ticks, each a job scheduler keyed by a stable id", async () => {
    const { hub, svc, queue } = make();
    await svc.register({ name: "metrics-rollup", every: 120_000, run: jest.fn() });
    await svc.register({ name: "retention-prune", every: 3_600_000, run: jest.fn() });
    await svc.register({ name: "hub-backup-drill", pattern: "20 3 1 * *", run: jest.fn() });
    await svc.register({ name: "x", pattern: "0 3 * * *", tz: "Europe/Istanbul", run: jest.fn() });
    expect([...hub.queues.keys()]).toEqual([SCHEDULER_QUEUE]);
    expect([...hub.processors.keys()]).toEqual([SCHEDULER_QUEUE]);
    const rollup = queue().schedulers.get(tickSchedulerId("metrics-rollup"))!;
    expect(rollup.repeat).toMatchObject({ every: 120_000 });
    expect(rollup.template).toEqual({ name: "metrics-rollup", data: {} });
    expect(queue().schedulers.get(tickSchedulerId("hub-backup-drill"))!.repeat).toEqual({ pattern: "20 3 1 * *" });
    expect(queue().schedulers.get(tickSchedulerId("x"))!.repeat).toEqual({ pattern: "0 3 * * *", tz: "Europe/Istanbul" });
  });

  it("registering the same name again (a restart, or a changed interval) replaces the one scheduler instead of adding a second", async () => {
    const { svc, queue } = make();
    await svc.register({ name: "update-check", every: 86_400_000, run: jest.fn() });
    await svc.register({ name: "update-check", every: 3_600_000, run: jest.fn() });
    expect(queue().schedulers.size).toBe(1);
    expect(queue().schedulers.get("tick:update-check")!.repeat).toMatchObject({ every: 3_600_000 });
  });

  it("a new interval starts at the next interval boundary (not at once), like the old per-queue repeat did; an unchanged one is upserted untouched", async () => {
    const { svc, queue } = make();
    await svc.register({ name: "telemetry", every: 3_600_000, run: jest.fn() });
    const first = queue().schedulers.get("tick:telemetry")!.repeat as { every: number; startDate: Date };
    expect(first.startDate.getTime()).toBeGreaterThan(Date.now());
    expect(first.startDate.getTime() % 3_600_000).toBe(0);
    await svc.register({ name: "telemetry", every: 3_600_000, run: jest.fn() }); // a restart
    expect(queue().schedulers.get("tick:telemetry")!.repeat).toEqual({ every: 3_600_000 }); // keeps the pending job as is
    await svc.register({ name: "telemetry", every: 7_200_000, run: jest.fn() }); // interval changed
    expect((queue().schedulers.get("tick:telemetry")!.repeat as { startDate?: Date }).startDate).toBeInstanceOf(Date);
  });

  it("nextBoundary is the next multiple of the interval", () => {
    expect(nextBoundary(60_000, 1_000_000)).toBe(1_020_000);
    expect(nextBoundary(60_000, 1_020_000)).toBe(1_080_000);
  });

  it("needs exactly one of every / pattern", async () => {
    const { svc } = make();
    await expect(svc.register({ name: "a", run: jest.fn() })).rejects.toThrow(/exactly one/);
    await expect(svc.register({ name: "a", every: 1, pattern: "* * * * *", run: jest.fn() })).rejects.toThrow(/exactly one/);
  });

  it("gives the worker enough slots that every job name has its own lane", async () => {
    const { hub, svc } = make();
    await svc.register({ name: "a", every: 1000, run: jest.fn() });
    expect((hub.workerOpts.get(SCHEDULER_QUEUE) as { concurrency: number }).concurrency).toBeGreaterThanOrEqual(20);
  });

  it("is inert under NODE_ENV=test: handlers are remembered but nothing touches the hub/Redis", async () => {
    const { hub, svc } = make();
    hub.queues.clear();
    hub.enabled = false;
    await svc.register({ name: "a", every: 1000, run: jest.fn() });
    await svc.disable("a");
    await svc.enqueueAt("due", {}, "j1", new Date());
    await svc.removeJob("j1");
    await svc.onApplicationBootstrap();
    expect(hub.queues.size).toBe(0);
  });

  it("dispatches by job name; a failing job is logged and rethrown (BullMQ marks only it failed) and never stops the others", async () => {
    const { svc, dispatch } = make();
    const ok = jest.fn().mockResolvedValue(undefined);
    const bad = jest.fn().mockRejectedValue(new Error("db down"));
    const warn = jest.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    await svc.register({ name: "ok", every: 1000, run: ok });
    await svc.register({ name: "bad", every: 1000, run: bad });
    await expect(dispatch("bad")).rejects.toThrow("db down");
    await expect(dispatch("ok")).resolves.toBeUndefined();
    await expect(dispatch("bad")).rejects.toThrow("db down"); // the failing job keeps being retried on its own schedule
    expect(ok).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tick bad failed"));
  });

  it("a slow tick never blocks another job, and a tick still running from its previous run is skipped, not run twice", async () => {
    const { svc, dispatch } = make();
    let release!: () => void;
    const slow = jest.fn().mockImplementationOnce(() => new Promise<void>((r) => (release = r))).mockResolvedValue(undefined);
    const fast = jest.fn().mockResolvedValue(undefined);
    jest.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    await svc.register({ name: "slow", every: 1000, run: slow });
    await svc.register({ name: "fast", every: 1000, run: fast });
    const first = dispatch("slow");
    await dispatch("fast"); // not held up by the slow one
    await dispatch("slow"); // overlap: skipped
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(1);
    release();
    await first;
    await dispatch("slow"); // free again
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("a tick skipped MAX_CONSECUTIVE_SKIPS times in a row (permanently slower than its interval) is logged at error level and fails the job; the count resets once it runs again", async () => {
    const { svc, dispatch } = make();
    let release!: () => void;
    const slow = jest.fn().mockImplementationOnce(() => new Promise<void>((r) => (release = r))).mockResolvedValue(undefined);
    const logger = (svc as unknown as { logger: { warn: () => void; error: () => void } }).logger;
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    await svc.register({ name: "slow", every: 1000, run: slow });
    const first = dispatch("slow");
    for (let i = 1; i < MAX_CONSECUTIVE_SKIPS; i++) await expect(dispatch("slow")).resolves.toBeUndefined(); // early skips: warn only
    expect(warn).toHaveBeenCalledTimes(MAX_CONSECUTIVE_SKIPS - 1);
    expect(error).not.toHaveBeenCalled();
    await expect(dispatch("slow")).rejects.toThrow(/skipped in a row/); // the Nth: visible failure
    expect(error).toHaveBeenCalledWith(expect.stringContaining("slow"));
    await expect(dispatch("slow")).rejects.toThrow(/skipped in a row/); // and it stays visible while the run hangs
    release();
    await first;
    await dispatch("slow"); // runs again
    expect(slow).toHaveBeenCalledTimes(2);
    // the counter was reset: the next overlap is a plain warn-skip again
    let release2!: () => void;
    slow.mockImplementationOnce(() => new Promise<void>((r) => (release2 = r)));
    const again = dispatch("slow");
    await expect(dispatch("slow")).resolves.toBeUndefined();
    release2();
    await again;
  });

  it("a failed run releases its lane, so the next tick of the same job runs", async () => {
    const { svc, dispatch } = make();
    const run = jest.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    jest.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    await svc.register({ name: "a", every: 1000, run });
    await expect(dispatch("a")).rejects.toThrow("x");
    await expect(dispatch("a")).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("one-off jobs (handle) may run side by side: two scheduled reboots due at once both start", async () => {
    const { svc, dispatch } = make();
    const started: string[] = [];
    const gates: Array<() => void> = [];
    svc.handle("reboot-due", async (job) => {
      started.push((job.data as { id: string }).id);
      await new Promise<void>((r) => gates.push(r));
    });
    const a = dispatch("reboot-due", { id: "r1" });
    const b = dispatch("reboot-due", { id: "r2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["r1", "r2"]);
    gates.forEach((g) => g());
    await Promise.all([a, b]);
  });

  it("a job that fires before its handler is registered (restart with an overdue tick) waits for the registration", async () => {
    const { svc, dispatch } = make();
    const run = jest.fn().mockResolvedValue(undefined);
    const pending = dispatch("late");
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    await svc.register({ name: "late", every: 1000, run });
    await pending;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up on a job that never gets a handler (fails that one job, nothing else)", async () => {
    jest.useFakeTimers();
    const { dispatch } = make();
    const pending = dispatch("ghost");
    const assertion = expect(pending).rejects.toThrow(/no handler registered for scheduler job "ghost"/);
    await jest.advanceTimersByTimeAsync(121_000);
    await assertion;
  });

  it("removes orphaned tick:* schedulers no feature registered in this process (and leaves claimed ones and non-tick schedulers alone)", async () => {
    const { svc, queue } = make();
    await svc.register({ name: "kept", every: 1000, run: jest.fn() });
    await queue().upsertJobScheduler("tick:old-renamed", { every: 1000 }, {});
    await queue().upsertJobScheduler("tick:gone", { every: 1000 }, {});
    await queue().upsertJobScheduler("custom:other", { every: 1000 }, {});
    expect((await svc.removeOrphanSchedulers()).sort()).toEqual(["gone", "old-renamed"]);
    expect([...queue().schedulers.keys()].sort()).toEqual(["custom:other", "tick:kept"]);
    expect(await svc.removeOrphanSchedulers()).toEqual([]);
  });

  it("sweeps orphans on its own once boot has settled, after which an unclaimed job name fails fast instead of holding a slot for 2 minutes", async () => {
    jest.useFakeTimers();
    const { svc, queue, dispatch } = make();
    await svc.register({ name: "kept", every: 1000, run: jest.fn() });
    await queue().upsertJobScheduler("tick:ghost", { every: 1000 }, {});
    const early = dispatch("early-ghost"); // boot not settled: may still be a late registration, waits
    const earlyAssert = expect(early).rejects.toThrow(/no handler registered/);
    await jest.advanceTimersByTimeAsync(31_000);
    expect([...queue().schedulers.keys()]).toEqual(["tick:kept"]);
    const late = dispatch("ghost-2");
    const lateAssert = expect(late).rejects.toThrow(/no handler registered/);
    await jest.advanceTimersByTimeAsync(6_000); // far less than the 120s boot wait
    await lateAssert;
    await jest.advanceTimersByTimeAsync(90_000);
    await earlyAssert;
    svc.onModuleDestroy();
  });

  it("shutdown does not wait for a job that is still waiting for a handler (the worker's graceful close would hang for 2 minutes)", async () => {
    jest.useFakeTimers();
    const { svc, dispatch } = make();
    const pending = dispatch("never-registered");
    const assertion = expect(pending).rejects.toThrow(/shutting down/);
    svc.onModuleDestroy();
    await assertion;
    await jest.advanceTimersByTimeAsync(121_000); // its timer was cancelled: nothing fires later
  });

  it("disable() drops the scheduler (kill switch) and its handler; unknown names are harmless", async () => {
    const { svc, queue } = make();
    await svc.register({ name: "telemetry", every: 1000, run: jest.fn() });
    await svc.disable("telemetry");
    await svc.disable("never-registered");
    expect(queue().schedulers.size).toBe(0);
    expect(svc.names()).not.toContain("telemetry");
  });

  it("enqueueAt adds one delayed job under a stable id (never negative delay); removeJob drops it", async () => {
    const { svc, queue } = make();
    await svc.enqueueAt("reboot-due", { rebootId: "r1" }, "reboot-r1", new Date(1_090_000), 1_000_000);
    await svc.enqueueAt("reboot-due", { rebootId: "r2" }, "reboot-r2", new Date(900_000), 1_000_000);
    expect(queue().added).toEqual([
      { name: "reboot-due", data: { rebootId: "r1" }, opts: { jobId: "reboot-r1", delay: 90_000 } },
      { name: "reboot-due", data: { rebootId: "r2" }, opts: { jobId: "reboot-r2", delay: 0 } },
    ]);
    await svc.removeJob("reboot-r1");
    expect(queue().removedJobs).toEqual(["reboot-r1"]);
  });
});
