import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ScheduledTasksService } from "./scheduled-tasks.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { ScheduledTasksSchedulerService } from "./scheduled-tasks.scheduler.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, scheduler: Partial<ScheduledTasksSchedulerService>) {
  return new ScheduledTasksService(
    prisma as PrismaService,
    access as TeamAccessService,
    scheduler as ScheduledTasksSchedulerService,
    audit,
  );
}

const app = { id: "app1", teamId: "t1" };

describe("ScheduledTasksService", () => {
  it("forbids a non-writer from creating a task", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {}).create("u1", "app1", { name: "x", schedule: "0 2 * * *", command: "echo" }),
    ).rejects.toThrow(/nope/);
  });

  it("creates an enabled task and schedules it", async () => {
    const created = { id: "tk1", appId: "app1", name: "x", schedule: "0 2 * * *", command: "echo", enabled: true, lastRunAt: null };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      scheduledTask: { create: jest.fn().mockResolvedValue(created) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as ScheduledTasksSchedulerService;
    await make(prisma, access, scheduler).remove("u1", "app1", "tk1");
    expect(scheduler.unschedule).toHaveBeenCalledWith("tk1");
  });
});
