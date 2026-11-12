import { DeployQueueSweepSchedulerService } from "./deploy-queue-sweep.scheduler.service";

// The sweep's DB logic is covered directly on ApplicationsService.sweepStaleQueued; this only pins the
// scheduler's test-mode no-op (mirrors expiry/cleanup schedulers) and its env-driven max-age resolution.
describe("DeployQueueSweepSchedulerService", () => {
  const config = { get: jest.fn().mockReturnValue("redis://localhost:6379") } as never;

  it("is a no-op in tests (NODE_ENV==='test'): schedules no BullMQ queue/worker and never runs the sweep", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const apps = { sweepStaleQueued: jest.fn() } as never;
      const svc = new DeployQueueSweepSchedulerService(config, apps);
      await svc.onApplicationBootstrap();
      expect((apps as { sweepStaleQueued: jest.Mock }).sweepStaleQueued).not.toHaveBeenCalled();
      expect((svc as unknown as { queue?: unknown }).queue).toBeUndefined();
      expect((svc as unknown as { worker?: unknown }).worker).toBeUndefined();
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined(); // safe with nothing scheduled
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("maxAgeMs() defaults to 6h and honours a positive env override, ignoring garbage/negative", () => {
    const svc = new DeployQueueSweepSchedulerService(config, {} as never);
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
});
