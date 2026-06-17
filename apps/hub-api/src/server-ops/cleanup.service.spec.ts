import { ForbiddenException } from "@nestjs/common";
import { CleanupService } from "./cleanup.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  runner: Partial<CleanupRunnerService> = {},
  scheduler: Partial<CleanupSchedulerService> = {},
) {
  return new CleanupService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    runner as CleanupRunnerService,
    scheduler as CleanupSchedulerService,
  );
}

const server = { id: "s1", teamId: "t1", cleanupVolumes: false };

describe("CleanupService", () => {
  it("forbids a viewer from cleaning up", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue("VIEWER") } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await expect(svc.cleanupNow("u1", "s1")).rejects.toThrow(/insufficient role/);
  });

  it("runs cleanup via the runner for a writer", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue("OWNER") } as unknown as TeamAccessService;
    const runner = { runCleanup: jest.fn().mockResolvedValue("reclaimed 1GB") } as unknown as CleanupRunnerService;
    const out = await make(prisma, access, runner).cleanupNow("u1", "s1");
    expect(runner.runCleanup).toHaveBeenCalledWith("s1", "u1");
    expect(out.output).toBe("reclaimed 1GB");
  });

  it("schedules when enabled, unschedules otherwise", async () => {
    const update = jest.fn().mockResolvedValue({ ...server, cleanupEnabled: true, cleanupIntervalHours: 12 });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server), update },
    } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue("OWNER") } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as CleanupSchedulerService;
    await make(prisma, access, {}, scheduler).setConfig("u1", "s1", { enabled: true, intervalHours: 12, volumes: true });
    expect(scheduler.schedule).toHaveBeenCalledWith("s1", 12 * 3600);
  });
});
