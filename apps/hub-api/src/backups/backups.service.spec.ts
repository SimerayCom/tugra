import { BadGatewayException, BadRequestException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
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
import { DatabasesService } from "../databases/databases.service";
import { BackupConfigSchema } from "./dto";

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

const audit = { log: jest.fn() } as unknown as AuditService;

// OWNER/ADMIN hold every granular permission; VIEWER holds none.
const ALL_PERMS = new Set([
  "apps:deploy", "apps:config", "databases", "backups", "servers:manage",
  "servers:ops", "terminal", "bulk", "monitors", "projects", "integrations", "variables",
]);

const db = { id: "db1", teamId: "t1", serverId: "s1", engine: "POSTGRES", backupIntervalHours: 6, backupRetention: 7 };

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  runner: Partial<BackupRunnerService> = {},
  scheduler: Partial<BackupSchedulerService> = {},
  agentWs: Partial<AgentWsServer> = {},
  notifications: Partial<NotificationsService> = { fireForEvent: jest.fn().mockResolvedValue(undefined) },
  databases: Partial<DatabasesService> = {},
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
    databases as DatabasesService,
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

  it("imports from a URL by sending a curl restore command to the agent", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      restore: { create: jest.fn().mockResolvedValue({ id: "r1" }), update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = {
      toSpec: jest.fn().mockReturnValue({ id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: "pw", database: "appdb" } }),
    } as unknown as BackupRunnerService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const svc = make(prisma, access, runner, {}, { sendCommand } as unknown as AgentWsServer);
    await svc.importFromUrl("u1", "db1", { url: "https://x/d.sql.gz", gzip: true, encrypted: false });
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("curl -fsSL 'https://x/d.sql.gz'"), "backup", expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.import" }));
  });

  it("imports for a Dragonfly database (now supported) — dispatches a DFLY LOAD restore", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue({ ...db, engine: "DRAGONFLY" }) },
      restore: { create: jest.fn().mockResolvedValue({ id: "r1" }), update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = {
      toSpec: jest.fn().mockReturnValue({ id: "db1", engine: "DRAGONFLY", image: "x", port: 6379, hostPort: null, credentials: { username: "tugra", password: "pw", database: "appdb" } }),
    } as unknown as BackupRunnerService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    await make(prisma, access, runner, {}, { sendCommand } as unknown as AgentWsServer).importFromUrl("u1", "db1", { url: "https://x/d.rdb.gz", gzip: true, encrypted: false });
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("DFLY LOAD"), "backup", expect.any(Number));
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
    const runner = { toSpec: jest.fn().mockReturnValue({ engine: "POSTGRES", credentials: { username: "u", password: "p", database: "d" } }), destinationSpecById } as unknown as BackupRunnerService;
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

describe("BackupsService.restore — result verification + history", () => {
  const backup = { id: "bk", databaseId: "db1", status: "SUCCESS", filename: "t.dump.gz", destinationId: null };
  const dbRow = { id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", backupDestinationId: null };

  function setup(sendResult: { output: string; exitCode: number } | Error) {
    const create = jest.fn().mockResolvedValue({ id: "r1" });
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow) },
      backup: { findFirst: jest.fn().mockResolvedValue(backup) },
      restore: { create, update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = {
      toSpec: jest.fn().mockReturnValue({ engine: "POSTGRES", credentials: { username: "u", password: "p", database: "d" } }),
      destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
    } as unknown as BackupRunnerService;
    const sendCommand = jest.fn(sendResult instanceof Error ? () => Promise.reject(sendResult) : () => Promise.resolve(sendResult));
    const agentWs = { sendCommand } as unknown as AgentWsServer;
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const svc = make(prisma, access, runner, {}, agentWs, { fireForEvent });
    return { svc, create, update, fireForEvent };
  }

  it("records a RUNNING attempt then SUCCESS when the command exits 0", async () => {
    const { svc, create, update, fireForEvent } = setup({ output: "ok", exitCode: 0 });
    await svc.restore("u1", "db1", "bk");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "RESTORE", status: "RUNNING", backupId: "bk", createdBy: "u1" }) }));
    expect(update).toHaveBeenCalledWith({ where: { id: "r1" }, data: expect.objectContaining({ status: "SUCCESS", exitCode: 0 }) });
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("records FAILED, fires backup_restore_failed and throws on a non-zero exit", async () => {
    const { svc, update, fireForEvent } = setup({ output: "ERROR: boom", exitCode: 1 });
    await expect(svc.restore("u1", "db1", "bk")).rejects.toThrow();
    expect(update).toHaveBeenCalledWith({ where: { id: "r1" }, data: expect.objectContaining({ status: "FAILED", exitCode: 1, errorTail: expect.stringContaining("boom") }) });
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.objectContaining({ dbName: expect.stringContaining("shop"), exitCode: 1 }));
  });

  it("records FAILED and throws when the agent is offline (sendCommand rejects)", async () => {
    const { svc, update, fireForEvent } = setup(new Error("agent offline"));
    await expect(svc.restore("u1", "db1", "bk")).rejects.toThrow();
    expect(update).toHaveBeenCalledWith({ where: { id: "r1" }, data: expect.objectContaining({ status: "FAILED", exitCode: null }) });
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.objectContaining({ dbName: expect.stringContaining("shop"), exitCode: null }));
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
  const runner = {
    toSpec: jest.fn().mockReturnValue(targetSpec),
    destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
  } as unknown as BackupRunnerService;

  function setup(overrides: { source?: object; target?: object; backup?: object | null }) {
    const source = { ...dbA, ...overrides.source };
    const target = { ...dbB, ...overrides.target };
    const prisma = {
      database: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(where.id === "A" ? source : target)) },
      backup: { findFirst: jest.fn().mockResolvedValue("backup" in overrides ? overrides.backup : okBackup) },
      restore: { create: jest.fn().mockResolvedValue({ id: "r1" }), update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const sendCommand = jest.fn().mockResolvedValue({ output: "", exitCode: 0 });
    const agentWs = { sendCommand } as unknown as AgentWsServer;
    return { svc: make(prisma, access, runner, {}, agentWs), sendCommand };
  }

  it("restores a backup from A into a compatible B (command goes to B's server)", async () => {
    const { svc, sendCommand } = setup({});
    await svc.restoreTo("u1", "A", "bk", "B");
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "backup", 300_000);
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

describe("BackupsService.verifyBackupNow (restore-verify drill)", () => {
  const version = "16";
  const stdImage = resolveImage("POSTGRES", version);
  const srcRow = { id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", version, image: stdImage, environmentId: "env1", credentials: "c" };
  const ephRow = { id: "eph1", teamId: "t1", serverId: "s1", engine: "POSTGRES", version, image: stdImage, credentials: "c" };
  const okBackup = { id: "bk", databaseId: "db1", status: "SUCCESS", filename: "t.dump.gz", destinationId: null };

  function setup(opts: { sendResult?: { output: string; exitCode: number } | Error; backup?: object | null; srcOverride?: Record<string, unknown>; provisionStatus?: string; provisionThrows?: boolean } = {}) {
    const src = { ...srcRow, ...opts.srcOverride };
    // Id-keyed Restore store: runRestore creates a row (id "r1") and the drill pins its result by that exact
    // id via findUnique — so a concurrent/prior same-backup row can never be returned by mistake.
    const rows: Record<string, Record<string, unknown>> = {};
    let seq = 0;
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const id = `r${++seq}`;
      rows[id] = { id, exitCode: null, errorTail: null, completedAt: null, ...data };
      return Promise.resolve({ id });
    });
    const update = jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (rows[where.id]) Object.assign(rows[where.id], data);
      return Promise.resolve({});
    });
    const restoreFindUnique = jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(rows[where.id] ?? null));
    const prisma = {
      database: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(where.id === "db1" ? src : ephRow)) },
      backup: { findFirst: jest.fn().mockResolvedValue("backup" in opts ? opts.backup : okBackup) },
      restore: { create, update, findUnique: restoreFindUnique },
    } as unknown as PrismaService;
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const access = { requirePermission } as unknown as TeamAccessService;
    const runner = {
      toSpec: jest.fn().mockReturnValue({ id: "eph1", engine: "POSTGRES", image: stdImage, port: 5432, hostPort: null, credentials: { username: "tugra", password: "p", database: "verifydb" } }),
      destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
    } as unknown as BackupRunnerService;
    const sr = opts.sendResult ?? { output: "ok", exitCode: 0 };
    const sendCommand = jest.fn(sr instanceof Error ? () => Promise.reject(sr) : () => Promise.resolve(sr));
    const agentWs = { sendCommand } as unknown as AgentWsServer;
    const createForImport = jest.fn().mockResolvedValue({ id: "eph1" });
    const provision = jest.fn(opts.provisionThrows
      ? () => Promise.reject(new Error("provision boom"))
      : () => Promise.resolve({ id: "eph1", status: opts.provisionStatus ?? "RUNNING" }));
    const remove = jest.fn().mockResolvedValue(undefined);
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const databases = { createForImport, provision, remove } as unknown as DatabasesService;
    const svc = make(prisma, access, runner, {}, agentWs, { fireForEvent }, databases);
    return { svc, createForImport, provision, remove, sendCommand, create, update, fireForEvent, requirePermission, rows };
  }

  it("provisions a faithful throwaway, restores into it, attests SUCCESS on the source, and reaps it", async () => {
    const { svc, createForImport, provision, remove, create, sendCommand } = setup();
    const view = await svc.verifyBackupNow("u1", "db1");
    // Faithful target on the SAME server; a STANDARD image is left for createForImport to resolve (image
    // undefined), so a plain drill does not demand apps:config.
    const arg = createForImport.mock.calls[0][1];
    expect(arg).toMatchObject({ serverId: "s1", engine: "POSTGRES", version, database: "verifydb" });
    expect(arg.image).toBeUndefined();
    expect(provision).toHaveBeenCalledWith("u1", "eph1");
    // Restore command goes to the SOURCE server (same server as the throwaway); the row is kind=VERIFY,
    // homed on the SOURCE db so teardown cannot cascade-delete it.
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "backup", 300_000);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "VERIFY", databaseId: "db1", backupId: "bk", createdBy: "u1" }) }));
    expect(view).toMatchObject({ kind: "VERIFY", status: "SUCCESS" });
    expect(remove).toHaveBeenCalledWith("u1", "eph1", { keepVolume: false });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("forwards a NON-standard source image to the throwaway (reproducing a custom image → apps:config)", async () => {
    const { svc, createForImport } = setup({ srcOverride: { image: "ghcr.io/acme/pg:custom" } });
    await svc.verifyBackupNow("u1", "db1");
    expect(createForImport.mock.calls[0][1].image).toBe("ghcr.io/acme/pg:custom");
  });

  it("returns a FAILED verify view (not an HTTP error) when the backup does not restore, and still reaps the throwaway", async () => {
    const { svc, remove, fireForEvent } = setup({ sendResult: { output: "ERROR: corrupt archive", exitCode: 1 } });
    const view = await svc.verifyBackupNow("u1", "db1");
    expect(view).toMatchObject({ kind: "VERIFY", status: "FAILED", exitCode: 1 });
    expect(view.errorTail).toContain("corrupt archive");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.objectContaining({ exitCode: 1 }));
    expect(remove).toHaveBeenCalledWith("u1", "eph1", { keepVolume: false });
  });

  it("surfaces 503 when the agent is offline (cannot verify now) and still reaps the throwaway", async () => {
    const { svc, remove } = setup({ sendResult: new Error("agent offline") });
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(remove).toHaveBeenCalledWith("u1", "eph1", { keepVolume: false });
  });

  it("rejects with 400 and provisions nothing when there is no successful backup to verify", async () => {
    const { svc, createForImport, provision, remove } = setup({ backup: null });
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toBeInstanceOf(BadRequestException);
    expect(createForImport).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires 'backups' write on the source before doing anything", async () => {
    const { svc, requirePermission } = setup();
    await svc.verifyBackupNow("u1", "db1");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "backups");
  });

  it("surfaces 503 (not a FAILED attestation) when the throwaway fails to provision, and still reaps it", async () => {
    // provision() swallows agent failures and returns a FAILED view without throwing; the drill must not then
    // restore into a non-existent container and blame the backup.
    const { svc, remove, sendCommand, fireForEvent } = setup({ provisionStatus: "FAILED" });
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sendCommand).not.toHaveBeenCalled(); // never attempted the restore
    expect(fireForEvent).not.toHaveBeenCalled(); // no false "backup won't restore" alert
    expect(remove).toHaveBeenCalledWith("u1", "eph1", { keepVolume: false });
  });

  it("still reaps the throwaway when provisioning throws outright", async () => {
    const { svc, remove } = setup({ provisionThrows: true });
    await expect(svc.verifyBackupNow("u1", "db1")).rejects.toThrow();
    expect(remove).toHaveBeenCalledWith("u1", "eph1", { keepVolume: false });
  });

  it("pins the returned attestation to THIS drill's row even when a prior VERIFY row exists for the same backup", async () => {
    const { svc, rows } = setup();
    // Seed a stale prior VERIFY attestation for the same backup (a different, older row).
    rows["stale"] = { id: "stale", kind: "VERIFY", status: "FAILED", databaseId: "db1", backupId: "bk", exitCode: 1, errorTail: "old", completedAt: new Date(), createdAt: new Date() };
    const view = await svc.verifyBackupNow("u1", "db1");
    // The returned view is the row THIS call created (SUCCESS), not the stale FAILED one.
    expect(view.status).toBe("SUCCESS");
    expect(view.id).not.toBe("stale");
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
