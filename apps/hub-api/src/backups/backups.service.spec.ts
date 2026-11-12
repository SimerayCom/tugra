import { BadGatewayException, BadRequestException, ForbiddenException } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { resolveImage } from "../databases/database-script";
import { BackupRunnerService } from "./backup-runner.service";
import type { BackupAlertsService } from "./backup-alerts.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupConfigSchema, VerifyConfigSchema } from "./dto";

describe("BackupConfigSchema — cron + age retention", () => {
  const ok = (o: Record<string, unknown>) => BackupConfigSchema.safeParse({ enabled: true, ...o }).success;
  it("accepts a 5-field cron, retentionDays, and null to clear", () => {
    expect(ok({ cron: "0 3 * * *", retentionDays: 30 })).toBe(true);
    expect(ok({ cron: null, retentionDays: null })).toBe(true);
    expect(ok({ intervalHours: 6, retention: 5 })).toBe(true);
  });
  it("rejects a non-5-field cron and out-of-range retentionDays", () => {
    expect(ok({ cron: "0 3 * *" })).toBe(false); // 4 fields
    expect(ok({ cron: "every day" })).toBe(false);
    expect(ok({ retentionDays: 0 })).toBe(false);
    expect(ok({ retentionDays: 99999 })).toBe(false);
  });
  it("rejects a 5-field cron whose fields are out of range (would crash BullMQ at schedule time)", () => {
    expect(ok({ cron: "0 25 * * *" })).toBe(false); // hour 25
    expect(ok({ cron: "60 * * * *" })).toBe(false); // minute 60
    expect(ok({ cron: "foo bar baz qux quux" })).toBe(false); // 5 tokens, all garbage
  });
});

describe("VerifyConfigSchema — 12h floor, cron, no retention/destination", () => {
  const ok = (o: Record<string, unknown>) => VerifyConfigSchema.safeParse({ enabled: true, ...o }).success;
  it("accepts a cron, an interval ≥ the 12h floor, and a bare enabled/disabled", () => {
    expect(ok({ cron: "0 4 * * 0" })).toBe(true);
    expect(ok({ intervalHours: 12 })).toBe(true);
    expect(ok({ intervalHours: 24 })).toBe(true);
    expect(VerifyConfigSchema.safeParse({ enabled: false }).success).toBe(true);
  });
  it("floors the interval FAR above the backup minimum (each run provisions a real DB)", () => {
    expect(ok({ intervalHours: 1 })).toBe(false);
    expect(ok({ intervalHours: 11 })).toBe(false);
  });
  it("floors the cron too, so a too-frequent cron cannot bypass the 12h minimum", () => {
    expect(ok({ cron: "0 4 * * 0" })).toBe(true); // weekly
    expect(ok({ cron: "0 */12 * * *" })).toBe(true); // every 12h — exactly the floor
    expect(ok({ cron: "* * * * *" })).toBe(false); // every minute — the bypass
    expect(ok({ cron: "0 */6 * * *" })).toBe(false); // every 6h — below the floor
  });
  it("rejects an out-of-range cron and does not accept retention/destination keys as meaningful", () => {
    expect(ok({ cron: "0 25 * * *" })).toBe(false);
    // retention/destination are not part of the verify schema (ignored by zod's default strip).
    const parsed = VerifyConfigSchema.parse({ enabled: true, intervalHours: 24, retention: 5, destinationId: "d1" } as never);
    expect("retention" in parsed).toBe(false);
    expect("destinationId" in parsed).toBe(false);
  });
});

const audit = { log: jest.fn() } as unknown as AuditService;

// OWNER/ADMIN hold every granular permission; VIEWER holds none.
const ALL_PERMS = new Set([
  "apps:deploy", "apps:config", "databases", "backups", "servers:manage",
  "servers:ops", "terminal", "bulk", "monitors", "projects", "integrations", "variables",
]);

const db = { id: "db1", teamId: "t1", serverId: "s1", engine: "POSTGRES", version: "16", image: resolveImage("POSTGRES", "16"), backupIntervalHours: 6, backupRetention: 7 };

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  runner: Partial<BackupRunnerService> = {},
  scheduler: Partial<BackupSchedulerService> = {},
  agentWs: Partial<AgentWsServer> = {},
  notifications: Partial<NotificationsService> = { fireForEvent: jest.fn().mockResolvedValue(undefined) },
) {
  return new BackupsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    agentWs as AgentWsServer,
    runner as BackupRunnerService,
    scheduler as BackupSchedulerService,
    notifications as NotificationsService,
    { onScheduleChanged: jest.fn().mockResolvedValue(undefined) } as unknown as BackupAlertsService,
  );
}

describe("BackupsService", () => {
  it("forbids backing up a database the user can't write to", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await expect(svc.backupNow("u1", "db1")).rejects.toThrow(/nope/);
  });

  it("runs an on-demand backup via the runner and returns a view", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = {
      runBackup: jest.fn().mockResolvedValue({
        id: "b1", status: "SUCCESS", filename: "t.sql", sizeBytes: 12345n,
        createdBy: "u1", createdAt: new Date(), completedAt: new Date(),
      }),
    } as unknown as BackupRunnerService;
    const svc = make(prisma, access, runner);
    const view = await svc.backupNow("u1", "db1");
    expect(runner.runBackup).toHaveBeenCalledWith("db1", "u1");
    expect(view.status).toBe("SUCCESS");
    expect(view.sizeBytes).toBe("12345"); // BigInt serialized to string
  });

  it("schedules a repeatable backup when enabled, unschedules otherwise", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, backupEnabled: true, backupIntervalHours: 6 });
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await svc.setSchedule("u1", "db1", { enabled: true, intervalHours: 6, retention: 5 });
    expect(scheduler.schedule).toHaveBeenCalledWith("db1", 6 * 3600);
  });

  it("a cron schedule drives scheduleCron and overrides the interval", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, backupEnabled: true, backupIntervalHours: 6, backupCron: "0 3 * * *" });
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), scheduleCron: jest.fn(), unschedule: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await svc.setSchedule("u1", "db1", { enabled: true, cron: "0 3 * * *", intervalHours: 6, retention: 5, retentionDays: 30 });
    expect(scheduler.scheduleCron).toHaveBeenCalledWith("db1", "0 3 * * *");
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data).toMatchObject({ backupCron: "0 3 * * *", backupRetentionDays: 30 });
  });

  it("refuses to enable a schedule for an engine with no backup pipeline (libSQL) and never persists it", async () => {
    const update = jest.fn();
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue({ ...db, engine: "LIBSQL" }), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await expect(svc.setSchedule("u1", "db1", { enabled: true, intervalHours: 6 })).rejects.toThrow(/not supported/);
    expect(update).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it("arms a verify schedule when enabled, gated on 'backups' AND 'databases'", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, verifyEnabled: true, verifyIntervalHours: 24 });
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const scheduler = { scheduleVerify: jest.fn(), scheduleVerifyCron: jest.fn(), unscheduleVerify: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, { requirePermission } as unknown as TeamAccessService, {}, scheduler);
    await svc.setVerifySchedule("u1", "db1", { enabled: true, intervalHours: 24 });
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "backups");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "databases");
    expect(scheduler.scheduleVerify).toHaveBeenCalledWith("db1", 24 * 3600);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.verify.schedule" }));
  });

  it("a verify cron drives scheduleVerifyCron and overrides the interval", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, verifyEnabled: true, verifyIntervalHours: 24, verifyCron: "0 4 * * 0" });
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { scheduleVerify: jest.fn(), scheduleVerifyCron: jest.fn(), unscheduleVerify: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await svc.setVerifySchedule("u1", "db1", { enabled: true, cron: "0 4 * * 0", intervalHours: 24 });
    expect(scheduler.scheduleVerifyCron).toHaveBeenCalledWith("db1", "0 4 * * 0");
    expect(scheduler.scheduleVerify).not.toHaveBeenCalled();
  });

  it("disabling the verify schedule unschedules its repeatable", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, verifyEnabled: false });
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { scheduleVerify: jest.fn(), scheduleVerifyCron: jest.fn(), unscheduleVerify: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await svc.setVerifySchedule("u1", "db1", { enabled: false });
    expect(scheduler.unscheduleVerify).toHaveBeenCalledWith("db1");
  });

  it("refuses to enable verify for an engine with no backup pipeline and never persists it", async () => {
    const update = jest.fn();
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue({ ...db, engine: "LIBSQL" }), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { scheduleVerify: jest.fn(), unscheduleVerify: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await expect(svc.setVerifySchedule("u1", "db1", { enabled: true, intervalHours: 24 })).rejects.toThrow(/not supported/);
    expect(update).not.toHaveBeenCalled();
    expect(scheduler.scheduleVerify).not.toHaveBeenCalled();
  });

  it("denying 'databases' blocks arming the verify schedule (no persist, no schedule)", async () => {
    const update = jest.fn();
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
    const requirePermission = jest.fn().mockImplementation((_u: string, _t: string, p: string) => (p === "databases" ? Promise.reject(new ForbiddenException("nope")) : Promise.resolve(undefined)));
    const scheduler = { scheduleVerify: jest.fn(), scheduleVerifyCron: jest.fn(), unscheduleVerify: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, { requirePermission } as unknown as TeamAccessService, {}, scheduler);
    await expect(svc.setVerifySchedule("u1", "db1", { enabled: true, intervalHours: 24 })).rejects.toThrow(/nope/);
    expect(update).not.toHaveBeenCalled();
    expect(scheduler.scheduleVerify).not.toHaveBeenCalled();
  });

  it("arming verify on a CUSTOM-image source requires apps:config, and a denial blocks it", async () => {
    const update = jest.fn();
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue({ ...db, image: "ghcr.io/acme/pg:custom" }), update } } as unknown as PrismaService;
    const requirePermission = jest.fn().mockImplementation((_u: string, _t: string, p: string) => (p === "apps:config" ? Promise.reject(new ForbiddenException("nope")) : Promise.resolve(undefined)));
    const scheduler = { scheduleVerify: jest.fn(), scheduleVerifyCron: jest.fn(), unscheduleVerify: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, { requirePermission } as unknown as TeamAccessService, {}, scheduler);
    await expect(svc.setVerifySchedule("u1", "db1", { enabled: true, intervalHours: 24 })).rejects.toThrow(/nope/);
    expect(update).not.toHaveBeenCalled();
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
  });

  it("imports from a URL by delegating a curl restore command to the runner", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runRestore = jest.fn().mockResolvedValue(undefined);
    const runner = {
      toSpec: jest.fn().mockReturnValue({ id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: "pw", database: "appdb" } }),
      runRestore,
    } as unknown as BackupRunnerService;
    await make(prisma, access, runner).importFromUrl("u1", "db1", { url: "https://x/d.sql.gz", gzip: true, encrypted: false });
    expect(runRestore).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining("curl -fsSL 'https://x/d.sql.gz'"),
      kind: "IMPORT_URL",
      auditAction: "database.import",
    }));
  });

  it("imports for a Dragonfly database (now supported) — delegates a DFLY LOAD restore", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue({ ...db, engine: "DRAGONFLY" }) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runRestore = jest.fn().mockResolvedValue(undefined);
    const runner = {
      toSpec: jest.fn().mockReturnValue({ id: "db1", engine: "DRAGONFLY", image: "x", port: 6379, hostPort: null, credentials: { username: "tugra", password: "pw", database: "appdb" } }),
      runRestore,
    } as unknown as BackupRunnerService;
    await make(prisma, access, runner).importFromUrl("u1", "db1", { url: "https://x/d.rdb.gz", gzip: true, encrypted: false });
    expect(runRestore).toHaveBeenCalledWith(expect.objectContaining({ command: expect.stringContaining("DFLY LOAD"), kind: "IMPORT_URL" }));
  });
});

describe("BackupsService.setScheduleBulk (fleet)", () => {
  it("applies the schedule to writable databases and skips the rest (role-gated, cross-team)", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, backupEnabled: true, backupIntervalHours: 24 });
    const prisma = {
      database: {
        // d3 unknown; d1=t1 (OWNER, write), d2=t2 (VIEWER, skip)
        findMany: jest.fn().mockResolvedValue([
          { id: "d1", teamId: "t1" },
          { id: "d2", teamId: "t2" },
        ]),
        update,
      },
    } as unknown as PrismaService;
    const access = {
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)], ["t2", new Set()]])),
    } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as BackupSchedulerService;

    const res = await make(prisma, access, {}, scheduler).setScheduleBulk(
      "u1",
      ["d1", "d2", "d3"],
      { enabled: true, intervalHours: 24, retention: 7 },
    );

    expect(res.applied).toEqual(["d1"]);
    expect(res.skipped.sort()).toEqual(["d2", "d3"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1" } }));
    expect(scheduler.schedule).toHaveBeenCalledWith("d1", 24 * 3600);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.backup.config.bulk" }));
  });

  it("applies nothing when no database is writable", async () => {
    const update = jest.fn();
    const prisma = {
      database: { findMany: jest.fn().mockResolvedValue([{ id: "d2", teamId: "t2" }]), update },
    } as unknown as PrismaService;
    const access = {
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t2", new Set()]])),
    } as unknown as TeamAccessService;
    const res = await make(prisma, access).setScheduleBulk("u1", ["d2"], { enabled: false });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual(["d2"]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("BackupsService.restore / removeBackup — use the backup's own destination", () => {
  // The DB's CURRENT destination differs from the one this backup was taken to.
  const backup = { id: "bk", databaseId: "db1", status: "SUCCESS", filename: "old.sql", destinationId: "oldDest" };
  const dbNow = { ...db, backupDestinationId: "newDest" };

  function setup() {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbNow) },
      backup: { findFirst: jest.fn().mockResolvedValue(backup), delete: jest.fn().mockResolvedValue({}) },
      restore: { create: jest.fn().mockResolvedValue({ id: "r1" }), update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const destinationSpecById = jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } });
    const runner = { toSpec: jest.fn().mockReturnValue({ engine: "POSTGRES", credentials: { username: "u", password: "p", database: "d" } }), destinationSpecById, runRestore: jest.fn().mockResolvedValue(undefined) } as unknown as BackupRunnerService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ output: "", exitCode: 0 }) } as unknown as AgentWsServer;
    return { svc: make(prisma, access, runner, {}, agentWs), destinationSpecById };
  }

  it("restore() reads the backup row's destinationId, not the DB's current one", async () => {
    const { svc, destinationSpecById } = setup();
    await svc.restore("u1", "db1", "bk");
    expect(destinationSpecById).toHaveBeenCalledWith("oldDest");
    expect(destinationSpecById).not.toHaveBeenCalledWith("newDest");
  });

  it("removeBackup() deletes from the backup row's own destination", async () => {
    const { svc, destinationSpecById } = setup();
    await svc.removeBackup("u1", "db1", "bk");
    expect(destinationSpecById).toHaveBeenCalledWith("oldDest");
  });
});

describe("BackupsService.restore — delegates to the runner + history", () => {
  // runRestore (record RUNNING→SUCCESS/FAILED, fire backup_restore_failed, throw) now lives in
  // BackupRunnerService and is covered by backup-runner.service.spec; here we prove BackupsService resolves
  // the backup's own destination, builds the right command, and delegates with the right shape.
  const backup = { id: "bk", databaseId: "db1", status: "SUCCESS", filename: "t.dump.gz", destinationId: null };
  const dbRow = { id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", backupDestinationId: null };

  function setup(runRestore = jest.fn().mockResolvedValue(undefined)) {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow) },
      backup: { findFirst: jest.fn().mockResolvedValue(backup) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = {
      toSpec: jest.fn().mockReturnValue({ engine: "POSTGRES", credentials: { username: "u", password: "p", database: "d" } }),
      destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
      runRestore,
    } as unknown as BackupRunnerService;
    return { svc: make(prisma, access, runner), runRestore };
  }

  it("delegates a RESTORE to the runner with the backup, kind and audit action", async () => {
    const { svc, runRestore } = setup();
    await svc.restore("u1", "db1", "bk");
    expect(runRestore).toHaveBeenCalledWith(expect.objectContaining({ kind: "RESTORE", backupId: "bk", createdBy: "u1", auditAction: "database.restore" }));
  });

  it("propagates a restore failure thrown by the runner", async () => {
    const { svc } = setup(jest.fn().mockRejectedValue(new BadGatewayException("restore failed")));
    await expect(svc.restore("u1", "db1", "bk")).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("listRestores requires write and returns the history view", async () => {
    const rows = [{ id: "r1", kind: "RESTORE", status: "FAILED", exitCode: 1, errorTail: "boom", backupId: "bk", createdAt: new Date(), completedAt: new Date() }];
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow) },
      restore: { findMany: jest.fn().mockResolvedValue(rows) },
    } as unknown as PrismaService;
    const svc = make(prisma, { requirePermission } as unknown as TeamAccessService);
    const out = await svc.listRestores("u1", "db1");
    expect(requirePermission).toHaveBeenCalled();
    expect(out[0]).toMatchObject({ id: "r1", status: "FAILED", exitCode: 1 });
  });
});

describe("BackupsService.restoreTo (cross-resource)", () => {
  const dbA = { id: "A", teamId: "t1", serverId: "s1", engine: "POSTGRES", credentials: "c" };
  const dbB = { id: "B", teamId: "t1", serverId: "s1", engine: "POSTGRES", credentials: "c" };
  const okBackup = { id: "bk", databaseId: "A", status: "SUCCESS", filename: "a.sql", destinationId: "s3dest" };

  const targetSpec = { id: "B", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "u", password: "p", database: "d" } };

  function setup(overrides: { source?: object; target?: object; backup?: object | null }) {
    const source = { ...dbA, ...overrides.source };
    const target = { ...dbB, ...overrides.target };
    const prisma = {
      database: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(where.id === "A" ? source : target)) },
      backup: { findFirst: jest.fn().mockResolvedValue("backup" in overrides ? overrides.backup : okBackup) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runRestore = jest.fn().mockResolvedValue(undefined);
    const runner = {
      toSpec: jest.fn().mockReturnValue(targetSpec),
      destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
      runRestore,
    } as unknown as BackupRunnerService;
    return { svc: make(prisma, access, runner), runRestore };
  }

  it("restores a backup from A into a compatible B (delegates with the target db + source link)", async () => {
    const { svc, runRestore } = setup({});
    await svc.restoreTo("u1", "A", "bk", "B");
    expect(runRestore).toHaveBeenCalledWith(expect.objectContaining({ kind: "RESTORE_TO", backupId: "bk", sourceDatabaseId: "A", db: expect.objectContaining({ id: "B" }) }));
  });

  it("rejects an engine mismatch", async () => {
    const { svc } = setup({ target: { engine: "MYSQL" } });
    await expect(svc.restoreTo("u1", "A", "bk", "B")).rejects.toThrow(/engine mismatch/);
  });

  it("rejects a cross-team restore", async () => {
    const { svc } = setup({ target: { teamId: "t2" } });
    await expect(svc.restoreTo("u1", "A", "bk", "B")).rejects.toThrow(/cross-team/);
  });

  it("rejects a LOCAL backup crossing servers (needs S3)", async () => {
    const { svc } = setup({ target: { serverId: "s2" }, backup: { ...okBackup, destinationId: null } });
    await expect(svc.restoreTo("u1", "A", "bk", "B")).rejects.toThrow(/S3/);
  });
});

describe("BackupsService.verifyBackupNow — authz + delegation to the runner", () => {
  // The throwaway lifecycle (provision/restore/reap/pin) now lives in BackupRunnerService.verifyBackup +
  // DatabasesService.withSystemThrowaway (covered by their own specs). Here BackupsService is the authz layer:
  // it resolves the backup, enforces the user-facing privilege gates, and delegates.
  const version = "16";
  const stdImage = resolveImage("POSTGRES", version);
  const srcRow = { id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", version, image: stdImage, environmentId: "env1", credentials: "c" };
  const okBackup = { id: "bk", databaseId: "db1", status: "SUCCESS", filename: "t.dump.gz", destinationId: null };
  const verifyRow = { id: "r1", kind: "VERIFY", status: "SUCCESS", exitCode: 0, errorTail: null, backupId: "bk", createdAt: new Date(), completedAt: new Date() };

  function setup(opts: { backup?: object | null; srcOverride?: Record<string, unknown>; verifyResult?: object } = {}) {
    const src = { ...srcRow, ...opts.srcOverride };
    const findFirst = jest.fn().mockResolvedValue("backup" in opts ? opts.backup : okBackup);
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(src) },
      backup: { findFirst },
    } as unknown as PrismaService;
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const access = { requirePermission } as unknown as TeamAccessService;
    const verifyBackup = jest.fn().mockResolvedValue(opts.verifyResult ?? verifyRow);
    const runner = { verifyBackup } as unknown as BackupRunnerService;
    const svc = make(prisma, access, runner);
    return { svc, verifyBackup, requirePermission, findFirst };
  }

  it("resolves the latest SUCCESS backup, gates on 'backups' + 'databases', delegates, returns the view", async () => {
    const { svc, verifyBackup, requirePermission } = setup();
    const view = await svc.verifyBackupNow("u1", "db1");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "backups");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "databases");
    // A STANDARD source image must NOT demand apps:config.
    expect(requirePermission).not.toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(verifyBackup).toHaveBeenCalledWith(expect.objectContaining({ id: "db1" }), expect.objectContaining({ id: "bk" }), "u1");
    expect(view).toMatchObject({ kind: "VERIFY", status: "SUCCESS" });
  });

  it("requires apps:config when the source runs a NON-standard image", async () => {
    const { svc, requirePermission } = setup({ srcOverride: { image: "ghcr.io/acme/pg:custom" } });
    await svc.verifyBackupNow("u1", "db1");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
  });

  it("does not demand apps:config when verifying a specific backup id on a standard image", async () => {
    const { svc, requirePermission, findFirst } = setup();
    await svc.verifyBackupNow("u1", "db1", "bk");
    // backupId path queries by id + status SUCCESS.
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "bk", status: "SUCCESS" }) }));
    expect(requirePermission).not.toHaveBeenCalledWith("u1", "t1", "apps:config");
  });

  it("rejects with 400 and never delegates when there is no successful backup to verify", async () => {
    const { svc, verifyBackup } = setup({ backup: null });
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toBeInstanceOf(BadRequestException);
    expect(verifyBackup).not.toHaveBeenCalled();
  });

  it("requires 'backups' write on the source before resolving a backup", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(srcRow) }, backup: { findFirst: jest.fn() } } as unknown as PrismaService;
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException("nope"));
    const verifyBackup = jest.fn();
    const svc = make(prisma, { requirePermission } as unknown as TeamAccessService, { verifyBackup } as unknown as BackupRunnerService);
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toThrow(/nope/);
    expect(verifyBackup).not.toHaveBeenCalled();
  });

  it("surfaces a FAILED verify view when the runner attests the backup did not restore", async () => {
    const { svc } = setup({ verifyResult: { id: "r9", kind: "VERIFY", status: "FAILED", exitCode: 1, errorTail: "corrupt archive", backupId: "bk", createdAt: new Date(), completedAt: new Date() } });
    const view = await svc.verifyBackupNow("u1", "db1");
    expect(view).toMatchObject({ kind: "VERIFY", status: "FAILED", exitCode: 1 });
    expect(view.errorTail).toContain("corrupt archive");
  });

  // Gate-RELOCATION guard: 5.2a moved the 'databases'/'apps:config' checks out of createForImport into this
  // wrapper, so a denial of either must BLOCK the drill (not merely "be called") or the privilege bar silently drops.
  const denyOnly = (perm: string) => jest.fn().mockImplementation((_u: string, _t: string, p: string) => (p === perm ? Promise.reject(new ForbiddenException("nope")) : Promise.resolve(undefined)));

  it("denying ONLY 'databases' blocks the drill — runner.verifyBackup is never reached", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(srcRow) }, backup: { findFirst: jest.fn().mockResolvedValue(okBackup) } } as unknown as PrismaService;
    const verifyBackup = jest.fn();
    const svc = make(prisma, { requirePermission: denyOnly("databases") } as unknown as TeamAccessService, { verifyBackup } as unknown as BackupRunnerService);
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toThrow(/nope/);
    expect(verifyBackup).not.toHaveBeenCalled();
  });

  it("denying ONLY 'apps:config' on a custom-image source blocks the drill", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue({ ...srcRow, image: "ghcr.io/acme/pg:custom" }) }, backup: { findFirst: jest.fn().mockResolvedValue(okBackup) } } as unknown as PrismaService;
    const verifyBackup = jest.fn();
    const svc = make(prisma, { requirePermission: denyOnly("apps:config") } as unknown as TeamAccessService, { verifyBackup } as unknown as BackupRunnerService);
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toThrow(/nope/);
    expect(verifyBackup).not.toHaveBeenCalled();
  });
});

describe("BackupsService.exportUrl", () => {
  const S3_DEST = { type: "S3", s3: { bucket: "b", region: "r", endpoint: "s3.example.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" }, encryption: { enabled: false, key: "" } };
  const LOCAL_DEST = { type: "LOCAL", encryption: { enabled: false, key: "" } };
  const SHARE_JSON = '{"status":"success","url":"tdest/b/k","share":"https://s3.example.com/b/k?X-Amz-Signature=sig","expiry":86400}';

  function setupExport(dest: unknown, sendResult: { exitCode: number; output: string } = { exitCode: 0, output: SHARE_JSON }) {
    (audit.log as jest.Mock).mockClear();
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      backup: { findFirst: jest.fn().mockResolvedValue({ id: "bk1", databaseId: "db1", filename: "2026.dump.gz", destinationId: (dest as { type: string }).type === "S3" ? "d1" : null }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = { destinationSpecById: jest.fn().mockResolvedValue(dest) } as unknown as BackupRunnerService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue(sendResult) } as unknown as AgentWsServer;
    return { svc: make(prisma, access, runner, {}, agentWs), agentWs };
  }

  it("returns a presigned url + expiry for an S3 backup under the 'backup' capability, url not logged", async () => {
    const t = setupExport(S3_DEST);
    const res = await t.svc.exportUrl("u1", "db1", "bk1", 24);
    const [serverId, cmd, cap] = (t.agentWs.sendCommand as jest.Mock).mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cap).toBe("backup");
    expect(cmd).toContain("mc share download --expire '24h'");
    expect(res.url).toBe("https://s3.example.com/b/k?X-Amz-Signature=sig");
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("X-Amz");
  });

  it("rejects a LOCAL backup (no presignable object) without dispatching", async () => {
    const t = setupExport(LOCAL_DEST);
    await expect(t.svc.exportUrl("u1", "db1", "bk1", 24)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("BadGateway when mc fails, and never logs the presigned url", async () => {
    const t = setupExport(S3_DEST, { exitCode: 1, output: "mc: <ERROR> share failed" });
    await expect(t.svc.exportUrl("u1", "db1", "bk1", 24)).rejects.toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("http");
  });
});

describe("BackupsService.list — run outcome, errorTail is WRITER-ONLY", () => {
  const failed = {
    id: "b1", status: "FAILED", filename: "f.sql", sizeBytes: null, destinationId: null,
    createdBy: "u1", createdAt: new Date(), completedAt: new Date(),
    exitCode: 3, durationMs: 1234, errorTail: "pg_dump: error: scrubbed reason",
  };
  const mk = (perms: string[] | null) => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      backup: { findMany: jest.fn().mockResolvedValue([failed]) },
      backupDestination: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      teamRole: jest.fn().mockResolvedValue("VIEWER"),
      requireResourceAccess: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(perms ? new Set(perms) : null),
    } as unknown as TeamAccessService;
    return make(prisma, access);
  };

  it("a writer (backups permission) sees errorTail, exitCode and durationMs", async () => {
    const [v] = await mk(["backups"]).list("u1", "db1");
    expect(v.errorTail).toBe("pg_dump: error: scrubbed reason");
    expect(v.exitCode).toBe(3);
    expect(v.durationMs).toBe(1234);
    expect(v.destinationId).toBeNull();
  });

  it("a read-only member gets errorTail=null but still sees exitCode/durationMs", async () => {
    const [v] = await mk([]).list("u1", "db1");
    expect(v.errorTail).toBeNull();
    expect(v.exitCode).toBe(3);
    expect(v.durationMs).toBe(1234);
    expect(JSON.stringify(v)).not.toContain("scrubbed reason");
  });

  it("an unresolvable membership is treated as read-only", async () => {
    const [v] = await mk(null).list("u1", "db1");
    expect(v.errorTail).toBeNull();
  });
});
