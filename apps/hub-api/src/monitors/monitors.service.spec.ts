import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { MonitorsService } from "./monitors.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { MonitorRunnerService } from "./runner.service";
import { MonitorSchedulerService } from "./scheduler.service";

const audit = { log: jest.fn() } as unknown as AuditService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, scheduler: Partial<MonitorSchedulerService>) {
  return new MonitorsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    {} as MonitorRunnerService,
    scheduler as MonitorSchedulerService,
  );
}

const monitor = {
  id: "m1",
  teamId: "t1",
  name: "site",
  type: "HTTP",
  target: "https://x.com",
  serverId: null,
  metric: null,
  thresholdPct: null,
  intervalSec: 30,
  retries: 1,
  timeoutMs: 10000,
  resendEvery: 0,
  status: "PENDING",
  enabled: true,
  auto: false,
  appId: null,
  createdAt: new Date(),
};

describe("MonitorsService.update", () => {
  it("forbids a non-writer", async () => {
    const prisma = { monitor: { findUnique: jest.fn().mockResolvedValue(monitor) } } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {}).update("u1", "m1", { intervalSec: 60 })).rejects.toThrow(/nope/);
  });

  it("re-schedules when the interval changes", async () => {
    const schedule = jest.fn();
    const unschedule = jest.fn();
    const prisma = {
      monitor: {
        findUnique: jest.fn().mockResolvedValue(monitor),
        update: jest.fn().mockResolvedValue({ ...monitor, intervalSec: 60 }),
      },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    await make(prisma, access, { schedule, unschedule }).update("u1", "m1", { intervalSec: 60 });
    expect(unschedule).toHaveBeenCalledWith("m1");
    expect(schedule).toHaveBeenCalledWith("m1", 60);
  });

  it("re-links channels when channelIds is provided", async () => {
    const deleteMany = jest.fn().mockResolvedValue({});
    const createMany = jest.fn().mockResolvedValue({});
    const prisma = {
      monitor: { findUnique: jest.fn().mockResolvedValue(monitor), update: jest.fn().mockResolvedValue(monitor) },
      monitorChannel: { deleteMany, createMany },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    await make(prisma, access, { schedule: jest.fn(), unschedule: jest.fn() }).update("u1", "m1", { channelIds: ["c1", "c2"] });
    expect(deleteMany).toHaveBeenCalledWith({ where: { monitorId: "m1" } });
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [{ monitorId: "m1", channelId: "c1" }, { monitorId: "m1", channelId: "c2" }] }));
  });
});

describe("MonitorsService.createForApp / removeForApp", () => {
  const app = { id: "app1", name: "web", teamId: "t1", domain: "x.com", https: true, isPreview: false };

  it("creates an HTTP auto monitor for a domained app and schedules it", async () => {
    const create = jest.fn().mockResolvedValue({ ...monitor, id: "auto1", auto: true, appId: "app1", intervalSec: 30 });
    const schedule = jest.fn();
    const prisma = { monitor: { create } } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, { schedule }).createForApp(app);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: "HTTP", target: "https://x.com", teamId: "t1", appId: "app1", auto: true });
    expect(schedule).toHaveBeenCalledWith("auto1", 30);
  });

  it("is a no-op when the app has no domain or is a preview", async () => {
    const create = jest.fn();
    const prisma = { monitor: { create } } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, { schedule: jest.fn() });
    await svc.createForApp({ ...app, domain: null });
    await svc.createForApp({ ...app, isPreview: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("removeForApp unschedules and deletes the app's auto monitors", async () => {
    const unschedule = jest.fn();
    const deleteMany = jest.fn().mockResolvedValue({});
    const prisma = {
      monitor: { findMany: jest.fn().mockResolvedValue([{ id: "auto1" }]), deleteMany },
    } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, { unschedule }).removeForApp("app1");
    expect(unschedule).toHaveBeenCalledWith("auto1");
    expect(deleteMany).toHaveBeenCalledWith({ where: { appId: "app1", auto: true } });
  });
});
