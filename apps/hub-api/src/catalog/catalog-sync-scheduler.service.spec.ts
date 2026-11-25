import { CatalogSyncSchedulerService } from "./catalog-sync-scheduler.service";
import type { ConfigService } from "@nestjs/config";
import type { CatalogSyncRunnerService } from "./catalog-sync-runner.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

describe("CatalogSyncSchedulerService", () => {
  const runner = { sync: jest.fn().mockResolvedValue({ status: "ok" }) } as unknown as CatalogSyncRunnerService;
  const config = (url?: string, interval = 60) =>
    ({ get: (k: string) => ({ CATALOG_SOURCE_URL: url, CATALOG_SYNC_INTERVAL_MIN: interval } as Record<string, unknown>)[k] }) as unknown as ConfigService;

  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
    (runner.sync as jest.Mock).mockClear();
  });

  it("is a no-op in test env (never touches the runner or the scheduler)", async () => {
    process.env.NODE_ENV = "test";
    const t = new FakeTicks();
    await new CatalogSyncSchedulerService(config("https://c.example/catalog"), t.asService(), runner).onApplicationBootstrap();
    expect(runner.sync).not.toHaveBeenCalled();
    expect(t.registered).toEqual([]);
    expect(t.disabled).toEqual([]);
  });

  it("does nothing when CATALOG_SOURCE_URL is unset (opt-in) except drop a schedule an earlier boot left behind", async () => {
    process.env.NODE_ENV = "production";
    const t = new FakeTicks();
    await new CatalogSyncSchedulerService(config(undefined), t.asService(), runner).onApplicationBootstrap();
    expect(runner.sync).not.toHaveBeenCalled();
    expect(t.registered).toEqual([]);
    expect(t.disabled).toEqual(["catalog-sync"]);
  });

  it("syncs once at boot, then registers the recurring tick at the configured interval", async () => {
    process.env.NODE_ENV = "production";
    const t = new FakeTicks();
    await new CatalogSyncSchedulerService(config("https://c.example/catalog", 15), t.asService(), runner).onApplicationBootstrap();
    expect(runner.sync).toHaveBeenCalledTimes(1);
    expect(t.spec("catalog-sync").every).toBe(15 * 60_000);
    await t.run("catalog-sync");
    expect(runner.sync).toHaveBeenCalledTimes(2);
  });
});
