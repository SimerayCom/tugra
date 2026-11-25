import { HubBackupSchedulerService } from "./hub-backup-scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { HubBackupRunnerService } from "./hub-backup-runner.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

function make() {
  const ticks = new FakeTicks();
  const prisma = { hubBackupConfig: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
  const runBackup = jest.fn().mockResolvedValue(undefined);
  const runner = { runBackup } as unknown as HubBackupRunnerService;
  return { svc: new HubBackupSchedulerService(ticks.asService(), prisma, runner), ticks, runBackup };
}

describe("HubBackupSchedulerService", () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = prev; });

  it("is a no-op under NODE_ENV=test (no Redis connection)", async () => {
    process.env.NODE_ENV = "test";
    const { svc, ticks } = make();
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(ticks.registered).toEqual([]);
    expect(ticks.disabled).toEqual([]);
  });

  it("apply() registers the job with the configured interval, and its run is the scheduled hub backup", async () => {
    const { svc, ticks, runBackup } = make();
    await svc.apply({ enabled: true, intervalHours: 6 });
    expect(ticks.spec("hub-backup")).toMatchObject({ every: 6 * 3600_000 });
    await ticks.run("hub-backup");
    expect(runBackup).toHaveBeenCalledWith("scheduler");
  });

  it("apply() only removes the job when disabled", async () => {
    const { svc, ticks } = make();
    await svc.apply({ enabled: false, intervalHours: 24 });
    expect(ticks.disabled).toEqual(["hub-backup"]);
    expect(ticks.registered).toEqual([]);
    await svc.apply(null);
    expect(ticks.disabled).toEqual(["hub-backup", "hub-backup"]);
  });

  it("apply() schedules on a cron pattern (wins over the interval) and boot enrolment survives a bad cron", async () => {
    const { svc, ticks } = make();
    await svc.apply({ enabled: true, intervalHours: 6, cron: "0 3 * * *" });
    expect(ticks.spec("hub-backup")).toMatchObject({ pattern: "0 3 * * *" });
    expect(ticks.spec("hub-backup").every).toBeUndefined();
    jest.spyOn(ticks, "register").mockRejectedValueOnce(new Error("Invalid pattern"));
    await expect(svc.applySafe({ enabled: true, intervalHours: 6, cron: "bad" })).resolves.toBeUndefined();
  });
});
