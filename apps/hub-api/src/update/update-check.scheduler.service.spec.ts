import { UpdateCheckSchedulerService } from "./update-check.scheduler.service";
import type { ConfigService } from "@nestjs/config";
import type { CheckResult, UpdateService } from "./update.service";
import type { UpdaterService } from "./updater.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";

// The BullMQ Queue+Worker path needs Redis (CI e2e); the early-return guards + the extracted
// runScheduledCheck auto-update hook are unit-tested here.
describe("UpdateCheckSchedulerService", () => {
  const update = { checkRemote: jest.fn().mockResolvedValue({ status: "ok" }) } as unknown as UpdateService;
  const config = (url?: string) =>
    ({ get: (k: string) => ({ UPDATE_MANIFEST_URL: url, REDIS_URL: "redis://localhost:6379", UPDATE_CHECK_INTERVAL_MIN: 1440 } as Record<string, unknown>)[k] }) as unknown as ConfigService;

  function make(check: CheckResult, autoUpdate: boolean) {
    const upd = { checkRemote: jest.fn().mockResolvedValue(check) } as unknown as UpdateService;
    const updater = { requestUpdate: jest.fn().mockResolvedValue({ status: "started", targetVersion: null }) } as unknown as UpdaterService;
    const settings = { get: jest.fn().mockResolvedValue({ autoUpdate }) } as unknown as InstanceSettingsService;
    return { svc: new UpdateCheckSchedulerService(config("https://x/v.json"), upd, updater, settings), updater };
  }

  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
    (update.checkRemote as jest.Mock).mockClear();
  });

  it("is a no-op in test env (never touches the checker or a queue)", async () => {
    process.env.NODE_ENV = "test";
    const { svc } = make({ status: "unconfigured" }, true);
    await svc.onApplicationBootstrap();
    // no throw / no queue is the assertion; the initial check is not the auto path
  });

  it("does nothing when UPDATE_MANIFEST_URL is unset (opt-in)", async () => {
    process.env.NODE_ENV = "production";
    const svc = new UpdateCheckSchedulerService(
      config(undefined),
      update,
      { requestUpdate: jest.fn() } as unknown as UpdaterService,
      { get: jest.fn() } as unknown as InstanceSettingsService,
    );
    await svc.onApplicationBootstrap();
    expect(update.checkRemote).not.toHaveBeenCalled();
  });

  describe("runScheduledCheck (auto-update hook)", () => {
    it("auto-applies a PATCH update when autoUpdate is on", async () => {
      const { svc, updater } = make({ status: "ok", channel: "stable", current: "1.2.3", latest: "1.2.4", updateAvailable: true }, true);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).toHaveBeenCalledWith({ actor: "auto-update", auto: true });
    });

    it("does NOT auto-apply a minor/major bump (notify-only)", async () => {
      const { svc, updater } = make({ status: "ok", channel: "stable", current: "1.2.3", latest: "1.3.0", updateAvailable: true }, true);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).not.toHaveBeenCalled();
    });

    it("does NOT auto-apply when autoUpdate is off", async () => {
      const { svc, updater } = make({ status: "ok", channel: "stable", current: "1.2.3", latest: "1.2.4", updateAvailable: true }, false);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).not.toHaveBeenCalled();
    });

    it("does nothing when no update is available", async () => {
      const { svc, updater } = make({ status: "ok", channel: "stable", current: "1.2.3", latest: "1.2.3", updateAvailable: false }, true);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).not.toHaveBeenCalled();
    });
  });
});
