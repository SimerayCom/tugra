import { ConfigService } from "@nestjs/config";
import { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";

type Repeat = { name: string; key: string };

function make(opts: { app?: unknown; policies?: unknown[]; policyRow?: unknown; appRow?: unknown } = {}) {
  const repeatables: Repeat[] = [];
  const add = jest.fn().mockImplementation(async (name: string) => {
    repeatables.push({ name, key: `${name}#k` });
  });
  const removeRepeatableByKey = jest.fn().mockImplementation(async (key: string) => {
    const i = repeatables.findIndex((r) => r.key === key);
    if (i >= 0) repeatables.splice(i, 1);
  });
  const queue = { add, getRepeatableJobs: jest.fn(async () => [...repeatables]), removeRepeatableByKey };
  const prisma = {
    application: {
      findUnique: jest.fn().mockResolvedValue("appRow" in opts ? opts.appRow : (opts.app ?? { id: "a1", volumeBackupEnabled: true })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    volumeBackupPolicy: {
      findMany: jest.fn().mockResolvedValue(opts.policies ?? []),
      findUnique: jest.fn().mockResolvedValue("policyRow" in opts ? opts.policyRow : { id: "p1" }),
    },
  };
  const runner = { runBackup: jest.fn().mockResolvedValue([]) };
  const alerts = { checkApps: jest.fn().mockResolvedValue(0) };
  const svc = new VolumeBackupSchedulerService({ get: () => "redis://x" } as unknown as ConfigService, prisma as never, runner as never, alerts as never);
  (svc as unknown as { queue: unknown }).queue = queue;
  return { svc, add, removeRepeatableByKey, repeatables, prisma, runner, alerts };
}

describe("VolumeBackupSchedulerService — cron + policy jobs", () => {
  it("scheduleCron uses repeat.pattern; schedule keeps repeat.every (existing key + data unchanged)", async () => {
    const t = make();
    await t.svc.scheduleCron("a1", "0 3 * * *");
    expect(t.add).toHaveBeenLastCalledWith("volbackup:a1", { appId: "a1" }, { repeat: { pattern: "0 3 * * *" } });
    await t.svc.schedule("a1", 3600);
    expect(t.add).toHaveBeenLastCalledWith("volbackup:a1", { appId: "a1" }, { repeat: { every: 3_600_000 } });
    expect(t.repeatables.filter((r) => r.name === "volbackup:a1")).toHaveLength(1); // replaced, not duplicated
  });

  it("schedulePolicy: own cron wins, else own interval; job name volpol:<id> carrying the volume", async () => {
    const t = make();
    await t.svc.schedulePolicy({ id: "p1", appId: "a1", volumeName: "media", cron: "0 4 * * *", intervalHours: 3 });
    expect(t.add).toHaveBeenLastCalledWith("volpol:p1", { appId: "a1", volumeName: "media", policyId: "p1" }, { repeat: { pattern: "0 4 * * *" } });
    await t.svc.schedulePolicy({ id: "p1", appId: "a1", volumeName: "media", cron: null, intervalHours: 3 });
    expect(t.add).toHaveBeenLastCalledWith("volpol:p1", expect.anything(), { repeat: { every: 3 * 3_600_000 } });
  });

  it("syncPolicyJobs: a job exists iff the app is enabled and the policy is enabled with its own schedule", async () => {
    const policies = [
      { id: "own", appId: "a1", volumeName: "m", enabled: true, cron: "0 4 * * *", intervalHours: null },
      { id: "inherit", appId: "a1", volumeName: "d", enabled: true, cron: null, intervalHours: null },
      { id: "off", appId: "a1", volumeName: "c", enabled: false, cron: "0 4 * * *", intervalHours: null },
    ];
    const t = make({ policies });
    await t.svc.syncPolicyJobs("a1");
    expect(t.repeatables.map((r) => r.name)).toEqual(["volpol:own"]);
    // app disabled -> every policy job removed
    const off = make({ policies, app: { id: "a1", volumeBackupEnabled: false } });
    await off.svc.schedulePolicy(policies[0] as never);
    await off.svc.syncPolicyJobs("a1");
    expect(off.repeatables).toHaveLength(0);
  });

  it("routes volbackup:* to the app job excluding carved-out volumes", async () => {
    const t = make();
    await t.svc.handleJob({ name: "volbackup:a1", data: { appId: "a1" } });
    expect(t.runner.runBackup).toHaveBeenCalledWith("a1", "scheduler", { excludePolicied: true });
  });

  it("routes volpol:* to a single-volume run", async () => {
    const t = make();
    await t.svc.handleJob({ name: "volpol:p1", data: { appId: "a1", volumeName: "media", policyId: "p1" } });
    expect(t.runner.runBackup).toHaveBeenCalledWith("a1", "scheduler", { only: ["media"] });
  });

  it("reaps a policy job whose policy row is gone (no run) and an app job whose app is gone", async () => {
    const t = make({ policyRow: null });
    await t.svc.schedulePolicy({ id: "p1", appId: "a1", volumeName: "media", cron: "0 4 * * *", intervalHours: null });
    await t.svc.handleJob({ name: "volpol:p1", data: { appId: "a1", volumeName: "media", policyId: "p1" } });
    expect(t.runner.runBackup).not.toHaveBeenCalled();
    expect(t.repeatables).toHaveLength(0);
    const gone = make({ appRow: null });
    await gone.svc.handleJob({ name: "volbackup:a1", data: { appId: "a1" } });
    expect(gone.runner.runBackup).not.toHaveBeenCalled();
  });

  it("the watchdog job runs the app watchdog", async () => {
    const t = make();
    await t.svc.handleJob({ name: "watchdog", data: {} });
    expect(t.alerts.checkApps).toHaveBeenCalled();
  });

  it("boot enrolment enrols cron-only apps and a bad stored cron does not throw", async () => {
    {
      const t = make();
      (t.prisma.application.findMany as jest.Mock).mockResolvedValue([
        { id: "a1", volumeBackupCron: "0 3 * * *", volumeBackupIntervalHours: null },
        { id: "a2", volumeBackupCron: "bad", volumeBackupIntervalHours: null },
        { id: "a3", volumeBackupCron: null, volumeBackupIntervalHours: 6 },
      ]);
      t.add.mockImplementation(async (name: string, _d: unknown, o: { repeat: { pattern?: string } }) => {
        if (o.repeat.pattern === "bad") throw new Error("Invalid pattern");
        t.repeatables.push({ name, key: `${name}#k` });
      });
      await expect(t.svc.enrolApps()).resolves.toBeUndefined();
      expect(t.repeatables.map((r) => r.name).sort()).toEqual(["volbackup:a1", "volbackup:a3"]);
      const where = (t.prisma.application.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.OR).toEqual([{ volumeBackupIntervalHours: { not: null } }, { volumeBackupCron: { not: null } }]);
    }
  });
});
