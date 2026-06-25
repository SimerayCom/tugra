import { ForbiddenException } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const audit = { log: jest.fn() } as unknown as AuditService;

const db = { id: "db1", teamId: "t1", serverId: "s1", engine: "POSTGRES", backupIntervalHours: 6, backupRetention: 7 };

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  runner: Partial<BackupRunnerService> = {},
  scheduler: Partial<BackupSchedulerService> = {},
  agentWs: Partial<AgentWsServer> = {},
) {
  return new BackupsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    agentWs as AgentWsServer,
    runner as BackupRunnerService,
    scheduler as BackupSchedulerService,
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
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db) } } as unknown as PrismaService;
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
