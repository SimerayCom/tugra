import { DeployQueueSweepSchedulerService } from "./deploy-queue-sweep.scheduler.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

// The sweep's DB logic is covered directly on ApplicationsService.sweepStaleQueued; this only pins the
// scheduler's test-mode no-op (mirrors expiry/cleanup schedulers) and its env-driven max-age resolution.
describe("DeployQueueSweepSchedulerService", () => {
  const ticks = () => new FakeTicks().asService();

  it("is a no-op in tests (NODE_ENV==='test'): registers no tick and never runs the sweep", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const apps = { sweepStaleQueued: jest.fn() } as never;
      const t = new FakeTicks();
      const svc = new DeployQueueSweepSchedulerService(t.asService(), apps);
      await svc.onApplicationBootstrap();
      expect((apps as { sweepStaleQueued: jest.Mock }).sweepStaleQueued).not.toHaveBeenCalled();
      expect(t.registered).toEqual([]);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("maxAgeMs() defaults to 6h and honours a positive env override, ignoring garbage/negative", () => {
    const svc = new DeployQueueSweepSchedulerService(ticks(), {} as never);
    const maxAgeMs = () => (svc as unknown as { maxAgeMs: () => number }).maxAgeMs();
    const prev = process.env.DEPLOY_QUEUE_MAX_AGE_MS;
    try {
      delete process.env.DEPLOY_QUEUE_MAX_AGE_MS;
      expect(maxAgeMs()).toBe(6 * 3600 * 1000);
      process.env.DEPLOY_QUEUE_MAX_AGE_MS = "900000";
      expect(maxAgeMs()).toBe(900_000);
      process.env.DEPLOY_QUEUE_MAX_AGE_MS = "-5"; // negative → fall back to default
      expect(maxAgeMs()).toBe(6 * 3600 * 1000);
      process.env.DEPLOY_QUEUE_MAX_AGE_MS = "notanumber"; // NaN → fall back to default
      expect(maxAgeMs()).toBe(6 * 3600 * 1000);
    } finally {
      if (prev === undefined) delete process.env.DEPLOY_QUEUE_MAX_AGE_MS;
      else process.env.DEPLOY_QUEUE_MAX_AGE_MS = prev;
    }
  });

  it("registers one hourly tick whose run sweeps stale QUEUED deploys with the configured max age", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const sweepStaleQueued = jest.fn().mockResolvedValue(2);
      const t = new FakeTicks();
      await new DeployQueueSweepSchedulerService(t.asService(), { sweepStaleQueued } as never).onApplicationBootstrap();
      expect(t.spec("deploy-queue-sweep")).toMatchObject({ name: "deploy-queue-sweep", every: 3600 * 1000 });
      await t.run("deploy-queue-sweep");
      expect(sweepStaleQueued).toHaveBeenCalledWith(6 * 3600 * 1000);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
