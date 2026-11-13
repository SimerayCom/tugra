import { BadRequestException, ConflictException } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { BaseBackupRunnerService } from "./base-backup-runner.service";
import { BASE_BACKUP_MIN_HOURS, BaseBackupConfigSchema } from "./dto";

describe("BaseBackupConfigSchema — a base copies the whole cluster, so the floor is 6h", () => {
  it("accepts an interval ≥ 6h and a sparse cron; rejects a tight interval or a cron denser than 6h", () => {
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, intervalHours: BASE_BACKUP_MIN_HOURS }).success).toBe(true);
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, intervalHours: 24, cron: "0 2 * * *" }).success).toBe(true);
    expect(BaseBackupConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, intervalHours: 1 }).success).toBe(false);
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, intervalHours: 24 * 31 }).success).toBe(false);
    const dense = BaseBackupConfigSchema.safeParse({ enabled: true, cron: "*/30 * * * *" });
    expect(dense.success).toBe(false);
    if (!dense.success) expect(dense.error.issues[0].path).toEqual(["cron"]);
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, cron: "0 */4 * * *" }).success).toBe(false);
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, cron: "0 */6 * * *" }).success).toBe(true);
    // enabled with nothing to run on is a silent no-op schedule → refused; disabled needs nothing
    expect(BaseBackupConfigSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(BaseBackupConfigSchema.safeParse({ enabled: true, cron: null }).success).toBe(false);
    expect(BaseBackupConfigSchema.safeParse({ enabled: false, cron: null }).success).toBe(true);
  });
});

function make(engine: string, pitr: { pitrEnabled: boolean; pitrEnabledAt: Date | null } = { pitrEnabled: true, pitrEnabledAt: new Date("2026-11-01T00:00:00Z") }) {
  const row = { id: "db1", teamId: "t1", engine, ...pitr, backupDestinationId: null };
  const update = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ ...row, baseBackupCron: null, baseBackupIntervalHours: null, ...args.data }));
  const scheduler = { scheduleBase: jest.fn(), scheduleBaseCron: jest.fn(), unscheduleBase: jest.fn() };
  const alerts = { onScheduleChanged: jest.fn() };
  const audit = { log: jest.fn() };
  const requirePermission = jest.fn().mockResolvedValue(undefined);
  const svc = new BackupsService(
    { database: { findUnique: jest.fn().mockResolvedValue(row), update } } as unknown as PrismaService,
    { requirePermission } as unknown as TeamAccessService,
    audit as unknown as AuditService,
    {} as AgentWsServer,
    {} as BackupRunnerService,
    scheduler as unknown as BackupSchedulerService,
    {} as NotificationsService,
    alerts as unknown as BackupAlertsService,
    {} as BaseBackupRunnerService,
  );
  return { svc, update, scheduler, alerts, audit, requirePermission };
}

describe("BackupsService.setBaseBackupSchedule", () => {
  it("is Postgres-only (400) and touches nothing for another engine", async () => {
    const m = make("MYSQL");
    await expect(m.svc.setBaseBackupSchedule("u1", "db1", { enabled: true, intervalHours: 24 })).rejects.toBeInstanceOf(BadRequestException);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("arming requires PITR ACTIVE (409 while OFF or ARMING); disarming is always allowed", async () => {
    const off = make("POSTGRES", { pitrEnabled: false, pitrEnabledAt: null });
    await expect(off.svc.setBaseBackupSchedule("u1", "db1", { enabled: true, intervalHours: 24 })).rejects.toBeInstanceOf(ConflictException);
    expect(off.update).not.toHaveBeenCalled();
    const arming = make("POSTGRES", { pitrEnabled: true, pitrEnabledAt: null });
    await expect(arming.svc.setBaseBackupSchedule("u1", "db1", { enabled: true, intervalHours: 24 })).rejects.toBeInstanceOf(ConflictException);
    await off.svc.setBaseBackupSchedule("u1", "db1", { enabled: false });
    expect(off.scheduler.unscheduleBase).toHaveBeenCalledWith("db1");
  });

  it("requires the 'databases' permission on top of the backups write, persists, schedules the interval, re-arms the watchdog, audits", async () => {
    const m = make("POSTGRES");
    await m.svc.setBaseBackupSchedule("u1", "db1", { enabled: true, intervalHours: 12 });
    expect(m.requirePermission).toHaveBeenCalledWith("u1", "t1", "databases");
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ baseBackupEnabled: true, baseBackupIntervalHours: 12 }) }),
    );
    expect(m.scheduler.scheduleBase).toHaveBeenCalledWith("db1", 12 * 3600);
    expect(m.scheduler.scheduleBaseCron).not.toHaveBeenCalled();
    expect(m.alerts.onScheduleChanged).toHaveBeenCalledWith("basebackup", "db1");
    expect(m.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.basebackup.schedule", target: "db1" }));
  });

  it("a cron wins over the interval; disabling unschedules the base family only", async () => {
    const m = make("POSTGRES");
    await m.svc.setBaseBackupSchedule("u1", "db1", { enabled: true, intervalHours: 24, cron: "0 2 * * *" });
    expect(m.scheduler.scheduleBaseCron).toHaveBeenCalledWith("db1", "0 2 * * *");
    expect(m.scheduler.scheduleBase).not.toHaveBeenCalled();

    const off = make("POSTGRES");
    await off.svc.setBaseBackupSchedule("u1", "db1", { enabled: false });
    expect(off.scheduler.unscheduleBase).toHaveBeenCalledWith("db1");
    expect(off.scheduler.scheduleBase).not.toHaveBeenCalled();
    expect(off.scheduler.scheduleBaseCron).not.toHaveBeenCalled();
  });
});

describe("BackupSchedulerService — base family is a no-op without a queue (tests) and never collides with the others", () => {
  it("scheduleBase / scheduleBaseCron / unscheduleBase resolve without a queue", async () => {
    const svc = new BackupSchedulerService(
      { get: () => "redis://x" } as never,
      {} as PrismaService,
      {} as never,
      {} as BackupAlertsService,
      {} as BaseBackupRunnerService,
    );
    await expect(svc.scheduleBase("db1", 3600)).resolves.toBeUndefined();
    await expect(svc.scheduleBaseCron("db1", "0 2 * * *")).resolves.toBeUndefined();
    await expect(svc.unscheduleBase("db1")).resolves.toBeUndefined();
  });
});

describe("BackupSchedulerService — dispatch + boot enrolment of the base family", () => {
  function make(dbExists: boolean, dbs: Array<Record<string, unknown>> = []) {
    const prisma = {
      database: {
        findUnique: jest.fn().mockResolvedValue(dbExists ? { id: "db1" } : null),
        findMany: jest.fn().mockResolvedValue(dbs),
      },
    } as unknown as PrismaService;
    const runner = { runBackup: jest.fn().mockResolvedValue(undefined), verifyScheduled: jest.fn().mockResolvedValue(undefined) };
    const baseRunner = { runBaseBackupScheduled: jest.fn().mockResolvedValue(undefined) } as unknown as BaseBackupRunnerService;
    const alerts = { checkDatabases: jest.fn(), checkVerifyLiveness: jest.fn() } as unknown as BackupAlertsService;
    const svc = new BackupSchedulerService({ get: () => "redis://x" } as never, prisma, runner as never, alerts, baseRunner);
    const spies = {
      unschedule: jest.spyOn(svc, "unschedule").mockResolvedValue(undefined),
      unscheduleVerify: jest.spyOn(svc, "unscheduleVerify").mockResolvedValue(undefined),
      unscheduleBase: jest.spyOn(svc, "unscheduleBase").mockResolvedValue(undefined),
      scheduleBase: jest.spyOn(svc, "scheduleBase").mockResolvedValue(undefined),
      scheduleBaseCron: jest.spyOn(svc, "scheduleBaseCron").mockResolvedValue(undefined),
    };
    return { svc, runner, baseRunner, prisma, ...spies };
  }

  it("a base tick runs the scheduled base backup — never a logical backup — and reaps its OWN family when the database is gone", async () => {
    const m = make(true);
    await m.svc.handleBaseJob({ name: "base:db1", data: { databaseId: "db1" } });
    expect(m.baseRunner.runBaseBackupScheduled).toHaveBeenCalledWith("db1");
    expect(m.runner.runBackup).not.toHaveBeenCalled();

    const gone = make(false);
    await gone.svc.handleBaseJob({ name: "base:db1", data: { databaseId: "db1" } });
    expect(gone.baseRunner.runBaseBackupScheduled).not.toHaveBeenCalled();
    expect(gone.unscheduleBase).toHaveBeenCalledWith("db1");
    expect(gone.unschedule).not.toHaveBeenCalled();
    expect(gone.unscheduleVerify).not.toHaveBeenCalled();
  });

  it("a stray base: job on the shared queue is dropped, never run as a logical backup; verify/backup dispatch is unchanged", async () => {
    const m = make(true);
    await m.svc.handleJob({ name: "base:db1", data: { databaseId: "db1" } });
    expect(m.runner.runBackup).not.toHaveBeenCalled();
    expect(m.baseRunner.runBaseBackupScheduled).not.toHaveBeenCalled();
    await m.svc.handleJob({ name: "verify:db1", data: { databaseId: "db1" } });
    expect(m.runner.verifyScheduled).toHaveBeenCalledWith("db1");
    await m.svc.handleJob({ name: "backup:db1", data: { databaseId: "db1" } });
    expect(m.runner.runBackup).toHaveBeenCalledWith("db1");
  });

  it("boot enrolment: cron wins over the interval, a bad cron skips only that database, and only PITR-ACTIVE rows are queried", async () => {
    const m = make(true, [
      { id: "a", baseBackupCron: "0 2 * * *", baseBackupIntervalHours: 24 },
      { id: "b", baseBackupCron: null, baseBackupIntervalHours: 12 },
      { id: "c", baseBackupCron: "bad", baseBackupIntervalHours: null },
    ]);
    m.scheduleBaseCron.mockImplementation((_id: string, cron: string) => (cron === "bad" ? Promise.reject(new Error("bad cron")) : Promise.resolve()));
    const r = await m.svc.enrolBaseSchedules();
    expect(r).toEqual({ ok: 2, total: 3 });
    expect(m.scheduleBaseCron).toHaveBeenCalledWith("a", "0 2 * * *");
    expect(m.scheduleBase).toHaveBeenCalledWith("b", 12 * 3600);
    expect((m.prisma as unknown as { database: { findMany: jest.Mock } }).database.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ baseBackupEnabled: true, pitrEnabled: true, pitrEnabledAt: { not: null } }) }),
    );
  });
});
