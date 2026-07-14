import { CatalogSyncSchedulerService } from "./catalog-sync-scheduler.service";
import type { ConfigService } from "@nestjs/config";
import type { CatalogSyncRunnerService } from "./catalog-sync-runner.service";

// Only the early-return guards are unit-tested; the real BullMQ Queue+Worker path needs Redis (CI e2e).
describe("CatalogSyncSchedulerService", () => {
  const runner = { sync: jest.fn().mockResolvedValue({ status: "ok" }) } as unknown as CatalogSyncRunnerService;
  const config = (url?: string) =>
    ({ get: (k: string) => ({ CATALOG_SOURCE_URL: url, REDIS_URL: "redis://localhost:6379", CATALOG_SYNC_INTERVAL_MIN: 60 } as Record<string, unknown>)[k] }) as unknown as ConfigService;

  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
    (runner.sync as jest.Mock).mockClear();
  });

  it("is a no-op in test env (never touches the runner or a queue)", async () => {
    process.env.NODE_ENV = "test";
    await new CatalogSyncSchedulerService(config("https://c.example/catalog"), runner).onApplicationBootstrap();
    expect(runner.sync).not.toHaveBeenCalled();
  });

  it("does nothing when CATALOG_SOURCE_URL is unset (opt-in)", async () => {
    process.env.NODE_ENV = "production";
    await new CatalogSyncSchedulerService(config(undefined), runner).onApplicationBootstrap();
    expect(runner.sync).not.toHaveBeenCalled();
  });
});
