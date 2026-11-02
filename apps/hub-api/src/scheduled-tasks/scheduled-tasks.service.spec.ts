import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ScheduledTasksService } from "./scheduled-tasks.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { ScheduledTasksSchedulerService } from "./scheduled-tasks.scheduler.service";
import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  scheduler: Partial<ScheduledTasksSchedulerService>,
  runner: Partial<ScheduledTaskRunnerService> = { runTask: jest.fn().mockResolvedValue(undefined) },
) {
  return new ScheduledTasksService(
    prisma as PrismaService,
    access as TeamAccessService,
    scheduler as ScheduledTasksSchedulerService,
    audit,
    runner as ScheduledTaskRunnerService,
  );
}

const app = { id: "app1", teamId: "t1" };

describe("ScheduledTasksService", () => {
  it("forbids a non-writer from creating a task", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {}).create("u1", "app1", { name: "x", schedule: "0 2 * * *", command: "echo" }),
    ).rejects.toThrow(/nope/);
  });

  it("list propagates a per-resource scoping denial (restricted member, ungranted app)", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = {
      teamRole: jest.fn().mockResolvedValue(Role.VIEWER),
      requireResourceAccess: jest.fn().mockRejectedValue(new ForbiddenException("no access to this resource")),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access, {}).list("u1", "app1")).rejects.toThrow(/no access/);
  });

  it("creates an enabled task and schedules it", async () => {
    const created = { id: "tk1", appId: "app1", name: "x", schedule: "0 2 * * *", command: "echo", enabled: true, lastRunAt: null };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      scheduledTask: { create: jest.fn().mockResolvedValue(created) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as ScheduledTasksSchedulerService;
    const v = await make(prisma, access, scheduler).create("u1", "app1", { name: "x", schedule: "0 2 * * *", command: "echo" });
    expect(scheduler.schedule).toHaveBeenCalledWith("tk1", "0 2 * * *");
    expect(v.enabled).toBe(true);
  });

  it("unschedules when a task is disabled on update", async () => {
    const updated = { id: "tk1", appId: "app1", name: "x", schedule: "0 2 * * *", command: "echo", enabled: false, lastRunAt: null };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      scheduledTask: {
        findFirst: jest.fn().mockResolvedValue({ id: "tk1", appId: "app1" }),
        update: jest.fn().mockResolvedValue(updated),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as ScheduledTasksSchedulerService;
    await make(prisma, access, scheduler).update("u1", "app1", "tk1", { enabled: false });
    expect(scheduler.unschedule).toHaveBeenCalledWith("tk1");
  });

  it("unschedules and deletes on remove", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      scheduledTask: {
        findFirst: jest.fn().mockResolvedValue({ id: "tk1", appId: "app1" }),
        delete: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as ScheduledTasksSchedulerService;
    await make(prisma, access, scheduler).remove("u1", "app1", "tk1");
    expect(scheduler.unschedule).toHaveBeenCalledWith("tk1");
  });

  it("runNow requires write, finds the task, and fires a forced run", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      scheduledTask: { findFirst: jest.fn().mockResolvedValue({ id: "tk1", appId: "app1" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as ScheduledTasksSchedulerService;
    const runner = { runTask: jest.fn().mockResolvedValue(undefined) } as unknown as ScheduledTaskRunnerService;
    await make(prisma, access, scheduler, runner).runNow("u1", "app1", "tk1");
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(runner.runTask).toHaveBeenCalledWith("tk1", { force: true });
  });

  it("runNow 404s a task that belongs to another app", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      scheduledTask: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as ScheduledTasksSchedulerService;
    const runner = { runTask: jest.fn() } as unknown as ScheduledTaskRunnerService;
    await expect(make(prisma, access, scheduler, runner).runNow("u1", "app1", "nope")).rejects.toThrow(/not found/);
    expect(runner.runTask).not.toHaveBeenCalled();
  });
});
