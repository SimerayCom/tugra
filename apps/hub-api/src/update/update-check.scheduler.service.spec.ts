import { UpdateCheckSchedulerService } from "./update-check.scheduler.service";
import type { ConfigService } from "@nestjs/config";
import type { UpdateService } from "./update.service";

// Only the early-return guards are unit-tested; the real BullMQ Queue+Worker path needs Redis (CI e2e).
describe("UpdateCheckSchedulerService", () => {
  const update = { checkRemote: jest.fn().mockResolvedValue({ status: "ok" }) } as unknown as UpdateService;
  const config = (url?: string) =>
    ({ get: (k: string) => ({ UPDATE_MANIFEST_URL: url, REDIS_URL: "redis://localhost:6379", UPDATE_CHECK_INTERVAL_MIN: 1440 } as Record<string, unknown>)[k] }) as unknown as ConfigService;

  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
    (update.checkRemote as jest.Mock).mockClear();
  });

  it("is a no-op in test env (never touches the checker or a queue)", async () => {
    process.env.NODE_ENV = "test";
    await new UpdateCheckSchedulerService(config("https://get.tugra.io/versions.json"), update).onApplicationBootstrap();
    expect(update.checkRemote).not.toHaveBeenCalled();
  });

  it("does nothing when UPDATE_MANIFEST_URL is unset (opt-in)", async () => {
    process.env.NODE_ENV = "production";
    await new UpdateCheckSchedulerService(config(undefined), update).onApplicationBootstrap();
    expect(update.checkRemote).not.toHaveBeenCalled();
  });
});
