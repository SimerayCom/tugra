const queueAdd = jest.fn().mockResolvedValue(undefined);
const queueClose = jest.fn().mockResolvedValue(undefined);
const getRepeatableJobs = jest.fn().mockResolvedValue([]);
const removeRepeatableByKey = jest.fn().mockResolvedValue(true);
const queueCtor = jest.fn();
const workerCtor = jest.fn();
jest.mock("bullmq", () => ({
  Queue: function Queue(...args: unknown[]) {
    queueCtor(...args);
    return { add: queueAdd, close: queueClose, getRepeatableJobs, removeRepeatableByKey };
  },
  Worker: function Worker(...args: unknown[]) {
    workerCtor(...args);
    return { close: jest.fn().mockResolvedValue(undefined) };
  },
}));

import { UpdateCheckSchedulerService } from "./update-check.scheduler.service";
import type { ConfigService } from "@nestjs/config";
import type { CheckResult, UpdateService } from "./update.service";
import type { UpdaterService } from "./updater.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";

// The BullMQ Queue+Worker path needs Redis (CI e2e); the early-return guards + the extracted
// runScheduledCheck auto-update hook are unit-tested here.
describe("UpdateCheckSchedulerService", () => {
  const update = { checkRemote: jest.fn().mockResolvedValue({ status: "ok" }) } as unknown as UpdateService;
  const config = (url?: string, interval = 60) =>
    ({ get: (k: string) => ({ UPDATE_MANIFEST_URL: url, REDIS_URL: "redis://localhost:6379", UPDATE_CHECK_INTERVAL_MIN: interval } as Record<string, unknown>)[k] }) as unknown as ConfigService;

  /** A scheduler over a checker stub with the given hard-off / configured state and last-check time. */
  function boot(o: { forcedOff?: boolean; configured?: boolean; lastCheckedAt?: Date | null; interval?: number }) {
    const upd = {
      isForcedOff: jest.fn().mockReturnValue(!!o.forcedOff),
      isConfigured: jest.fn().mockReturnValue(o.configured ?? true),
      checkRemote: jest.fn().mockResolvedValue({ status: "ok" }),
    } as unknown as UpdateService;
    const settings = { get: jest.fn().mockResolvedValue({ updateLastCheckedAt: o.lastCheckedAt ?? null }) } as unknown as InstanceSettingsService;
    const svc = new UpdateCheckSchedulerService(config("https://x/v.json", o.interval ?? 60), upd, { requestUpdate: jest.fn() } as unknown as UpdaterService, settings);
    return { svc, upd };
  }

  function make(check: CheckResult, autoUpdate: boolean) {
    const upd = { checkRemote: jest.fn().mockResolvedValue(check) } as unknown as UpdateService;
    const updater = { requestUpdate: jest.fn().mockResolvedValue({ status: "started", targetVersion: null }) } as unknown as UpdaterService;
    const settings = { get: jest.fn().mockResolvedValue({ autoUpdate }) } as unknown as InstanceSettingsService;
    return { svc: new UpdateCheckSchedulerService(config("https://x/v.json"), upd, updater, settings), updater };
  }

  const OLD = process.env.NODE_ENV;
  beforeEach(() => {
    queueAdd.mockClear();
    queueCtor.mockClear();
    workerCtor.mockClear();
    getRepeatableJobs.mockReset().mockResolvedValue([]);
    removeRepeatableByKey.mockClear();
  });
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

  it("does nothing when TUGRA_UPDATE_CHECKS=0 (never touches the checker or a queue)", async () => {
    process.env.NODE_ENV = "production";
    const { svc, upd } = boot({ forcedOff: true });
    await svc.onApplicationBootstrap();
    expect(upd.checkRemote).not.toHaveBeenCalled();
    expect(upd.isConfigured).not.toHaveBeenCalled();
    expect(queueCtor).not.toHaveBeenCalled();
    expect(workerCtor).not.toHaveBeenCalled();
  });

  it("warns and returns when only the key is set (unconfigured)", async () => {
    process.env.NODE_ENV = "production";
    const { svc, upd } = boot({ configured: false });
    const warn = jest.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    await svc.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TUGRA_UPDATE_CHECKS=0"));
    expect(upd.checkRemote).not.toHaveBeenCalled();
    expect(queueCtor).not.toHaveBeenCalled();
  });

  it("schedules hourly when the defaults apply, and logs the interval", async () => {
    process.env.NODE_ENV = "production";
    const { svc } = boot({});
    const log = jest.spyOn((svc as unknown as { logger: { log: () => void } }).logger, "log").mockImplementation(() => undefined);
    await svc.onApplicationBootstrap();
    expect(queueAdd).toHaveBeenCalledWith("update-check", {}, { repeat: { every: 60 * 60_000 } });
    expect(log).toHaveBeenCalledWith("scheduled update check every 60m");
  });

  it("removes stale 'update-check' repeatables (the old daily one) BEFORE adding the new one, leaving other jobs alone", async () => {
    process.env.NODE_ENV = "production";
    const order: string[] = [];
    getRepeatableJobs.mockResolvedValue([
      { name: "update-check", key: "update-check::86400000" },
      { name: "something-else", key: "other::1" },
    ]);
    removeRepeatableByKey.mockImplementation(async (k: string) => {
      order.push(`remove:${k}`);
      return true;
    });
    queueAdd.mockImplementation(async () => {
      order.push("add");
    });
    const { svc } = boot({});
    await svc.onApplicationBootstrap();
    expect(order).toEqual(["remove:update-check::86400000", "add"]);
  });

  it("runs the initial check when never checked, WITHOUT awaiting it (boot is not held by the network)", async () => {
    process.env.NODE_ENV = "production";
    const { svc, upd } = boot({ lastCheckedAt: null });
    (upd.checkRemote as jest.Mock).mockReturnValue(new Promise(() => undefined)); // never settles
    await svc.onApplicationBootstrap(); // would hang if awaited
    expect(upd.checkRemote).toHaveBeenCalledTimes(1);
  });

  it("skips the initial check when the last successful check is younger than the interval", async () => {
    process.env.NODE_ENV = "production";
    const { svc, upd } = boot({ lastCheckedAt: new Date(Date.now() - 10 * 60_000) });
    await svc.onApplicationBootstrap();
    expect(upd.checkRemote).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalled(); // still scheduled
  });

  it("runs the initial check when the last one is older than the interval", async () => {
    process.env.NODE_ENV = "production";
    const { svc, upd } = boot({ lastCheckedAt: new Date(Date.now() - 2 * 60 * 60_000) });
    await svc.onApplicationBootstrap();
    expect(upd.checkRemote).toHaveBeenCalledTimes(1);
  });

  describe("runScheduledCheck (auto-update hook)", () => {
    it("auto-applies a PATCH update when autoUpdate is on", async () => {
      const { svc, updater } = make({ status: "ok", channel: "stable", current: "1.2.3", latest: "1.2.4", updateAvailable: true }, true);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).toHaveBeenCalledWith({ actor: "auto-update", auto: true });
    });

    it("auto-applies the next beta of the same series (0.1.0-beta.16 -> 0.1.0-beta.17)", async () => {
      const { svc, updater } = make({ status: "ok", channel: "beta", current: "0.1.0-beta.16", latest: "0.1.0-beta.17", updateAvailable: true }, true);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).toHaveBeenCalledWith({ actor: "auto-update", auto: true });
    });

    it("does NOT auto-apply beta -> stable (0.1.0-beta.16 -> 0.1.0)", async () => {
      const { svc, updater } = make({ status: "ok", channel: "beta", current: "0.1.0-beta.16", latest: "0.1.0", updateAvailable: true }, true);
      await svc.runScheduledCheck();
      expect(updater.requestUpdate).not.toHaveBeenCalled();
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
