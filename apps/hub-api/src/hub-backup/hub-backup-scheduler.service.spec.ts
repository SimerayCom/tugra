import { HubBackupSchedulerService } from "./hub-backup-scheduler.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { HubBackupRunnerService } from "./hub-backup-runner.service";

function make() {
  const config = { get: () => "redis://localhost:6379" } as unknown as ConfigService;
  const prisma = { hubBackupConfig: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
  const runner = { runBackup: jest.fn() } as unknown as HubBackupRunnerService;
  return new HubBackupSchedulerService(config, prisma, runner);
}

describe("HubBackupSchedulerService", () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = prev; });

  it("is a no-op under NODE_ENV=test (no Redis connection)", async () => {
    process.env.NODE_ENV = "test";
    const svc = make();
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("apply() is a no-op before the queue is created (CI-safe)", async () => {
    const svc = make();
    await expect(svc.apply({ enabled: true, intervalHours: 24 })).resolves.toBeUndefined();
  });

  it("apply() schedules a repeatable job with the configured interval when a queue exists", async () => {
    const svc = make();
    const add = jest.fn().mockResolvedValue(undefined);
    const getRepeatableJobs = jest.fn().mockResolvedValue([]);
    (svc as unknown as { queue: unknown }).queue = { add, getRepeatableJobs, removeRepeatableByKey: jest.fn() };
    await svc.apply({ enabled: true, intervalHours: 6 });
    expect(add).toHaveBeenCalledWith("hub-backup", {}, { repeat: { every: 6 * 3600_000 } });
  });

  it("apply() only unschedules when disabled", async () => {
    const svc = make();
    const add = jest.fn();
    const getRepeatableJobs = jest.fn().mockResolvedValue([{ name: "hub-backup", key: "k" }]);
    const removeRepeatableByKey = jest.fn().mockResolvedValue(undefined);
    (svc as unknown as { queue: unknown }).queue = { add, getRepeatableJobs, removeRepeatableByKey };
    await svc.apply({ enabled: false, intervalHours: 24 });
    expect(removeRepeatableByKey).toHaveBeenCalledWith("k");
    expect(add).not.toHaveBeenCalled();
  });
});
