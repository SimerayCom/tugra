import { ForbiddenException } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const audit = { log: jest.fn() } as unknown as AuditService;

const db = { id: "db1", teamId: "t1", serverId: "s1", engine: "POSTGRES", backupIntervalHours: 6, backupRetention: 7 };

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
  );
}

describe("BackupsService", () => {
  it("forbids backing up a database the user can't write to", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await expect(svc.backupNow("u1", "db1")).rejects.toThrow(/nope/);
  });

  it("runs an on-demand backup via the runner and returns a view", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as BackupSchedulerService;
    const svc = make(prisma, access, {}, scheduler);
    await svc.setSchedule("u1", "db1", { enabled: true, intervalHours: 6, retention: 5 });
    expect(scheduler.schedule).toHaveBeenCalledWith("db1", 6 * 3600);
  });

  it("imports from a URL by sending a curl restore command to the agent", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      restore: { create: jest.fn().mockResolvedValue({ id: "r1" }), update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const runner = {
      toSpec: jest.fn().mockReturnValue({ id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: "pw", database: "appdb" } }),
    } as unknown as BackupRunnerService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const svc = make(prisma, access, runner, {}, { sendCommand } as unknown as AgentWsServer);
    await svc.importFromUrl("u1", "db1", { url: "https://x/d.sql.gz", gzip: true, encrypted: false });
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("curl -fsSL 'https://x/d.sql.gz'"), "backup", expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.import" }));
  });

  it("rejects import for an engine without backup support", async () => {
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue({ ...db, engine: "DRAGONFLY" }) } } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access).importFromUrl("u1", "db1", { url: "https://x/d", gzip: true, encrypted: false })).rejects.toThrow(/not supported/);
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
      roleByTeam: jest.fn().mockResolvedValue(new Map([["t1", "OWNER"], ["t2", "VIEWER"]])),
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
      roleByTeam: jest.fn().mockResolvedValue(new Map([["t2", "VIEWER"]])),
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.stringContaining("shop"));
  });

  it("records FAILED and throws when the agent is offline (sendCommand rejects)", async () => {
    const { svc, update, fireForEvent } = setup(new Error("agent offline"));
    await expect(svc.restore("u1", "db1", "bk")).rejects.toThrow();
    expect(update).toHaveBeenCalledWith({ where: { id: "r1" }, data: expect.objectContaining({ status: "FAILED", exitCode: null }) });
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.any(String));
  });

  it("listRestores requires write and returns the history view", async () => {
    const rows = [{ id: "r1", kind: "RESTORE", status: "FAILED", exitCode: 1, errorTail: "boom", backupId: "bk", createdAt: new Date(), completedAt: new Date() }];
    const requireRole = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(dbRow) },
      restore: { findMany: jest.fn().mockResolvedValue(rows) },
    } as unknown as PrismaService;
    const svc = make(prisma, { requireRole } as unknown as TeamAccessService);
    const out = await svc.listRestores("u1", "db1");
    expect(requireRole).toHaveBeenCalled();
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
