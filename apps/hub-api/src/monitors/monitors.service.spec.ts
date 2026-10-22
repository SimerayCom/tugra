import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { MonitorsService } from "./monitors.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { MonitorRunnerService } from "./runner.service";
import { MonitorSchedulerService } from "./scheduler.service";

const audit = { log: jest.fn() } as unknown as AuditService;

// OWNER/ADMIN hold every granular permission; VIEWER holds none.
const ALL_PERMS = new Set<string>([
  "apps:deploy", "apps:config", "databases", "backups", "servers:manage",
  "servers:ops", "terminal", "bulk", "monitors", "projects", "integrations", "variables",
]);

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

describe("MonitorsService.list scoping", () => {
  it("hides monitors for apps outside a restricted member's granted projects (standalone hidden too)", async () => {
    const rows = [
      { ...monitor, id: "m-ok", appId: "a-ok" },
      { ...monitor, id: "m-hidden", appId: "a-hidden" },
      { ...monitor, id: "m-standalone", appId: null }, // no app → not in any granted project
    ];
    const prisma = {
      monitor: { findMany: jest.fn().mockResolvedValue(rows) },
      application: { findMany: jest.fn().mockResolvedValue([
        { id: "a-ok", environmentId: "e-ok" },
        { id: "a-hidden", environmentId: "e-secret" },
      ]) },
      environment: { findMany: jest.fn().mockResolvedValue([
        { id: "e-ok", name: "production", project: { id: "p-ok", name: "Ok" } },
        { id: "e-secret", name: "production", project: { id: "p-secret", name: "Secret" } },
      ]) },
    } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.VIEWER, restrictedAccess: true, accessedProjects: ["p-ok"], accessedResources: [] }]])),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set<string>()]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access, {}).list("u1");
    expect(out.map((m) => m.id)).toEqual(["m-ok"]);
  });

  it("shows every monitor to an unrestricted member (owner bypass, no project lookup needed)", async () => {
    const rows = [{ ...monitor, id: "m1", appId: null }, { ...monitor, id: "m2", appId: "a1" }];
    const appFindMany = jest.fn().mockResolvedValue([{ id: "a1", environmentId: "e1" }]);
    const prisma = {
      monitor: { findMany: jest.fn().mockResolvedValue(rows) },
      application: { findMany: appFindMany },
      environment: { findMany: jest.fn().mockResolvedValue([{ id: "e1", name: "production", project: { id: "p1", name: "P" } }]) },
    } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access, {}).list("u1");
    expect(out.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });
});

describe("MonitorsService.update", () => {
  it("forbids a non-writer", async () => {
    const prisma = { monitor: { findUnique: jest.fn().mockResolvedValue(monitor) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
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
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    await make(prisma, access, { schedule, unschedule }).update("u1", "m1", { intervalSec: 60 });
    expect(unschedule).toHaveBeenCalledWith("m1");
    expect(schedule).toHaveBeenCalledWith("m1", 60);
  });

  it("re-links channels when channelIds is provided", async () => {
    const deleteMany = jest.fn().mockResolvedValue({});
    const createMany = jest.fn().mockResolvedValue({});
    const prisma = {
      monitor: { findUnique: jest.fn().mockResolvedValue(monitor), update: jest.fn().mockResolvedValue(monitor) },
      notificationChannel: { findMany: jest.fn().mockResolvedValue([{ id: "c1" }, { id: "c2" }]) },
      monitorChannel: { deleteMany, createMany },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    await make(prisma, access, { schedule: jest.fn(), unschedule: jest.fn() }).update("u1", "m1", { channelIds: ["c1", "c2"] });
    expect(deleteMany).toHaveBeenCalledWith({ where: { monitorId: "m1" } });
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [{ monitorId: "m1", channelId: "c1" }, { monitorId: "m1", channelId: "c2" }] }));
  });

  it("rejects channelIds that belong to another team (no cross-team spam)", async () => {
    const createMany = jest.fn();
    const prisma = {
      monitor: { findUnique: jest.fn().mockResolvedValue(monitor), update: jest.fn() },
      notificationChannel: { findMany: jest.fn().mockResolvedValue([]) }, // c9 is not owned by team t1
      monitorChannel: { deleteMany: jest.fn(), createMany },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, { schedule: jest.fn(), unschedule: jest.fn() }).update("u1", "m1", { channelIds: ["c9"] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("MonitorsService.create authz (cross-team targets)", () => {
  it("rejects a serverId that belongs to another team and creates nothing", async () => {
    const create = jest.fn();
    const prisma = {
      server: { findFirst: jest.fn().mockResolvedValue(null) }, // s9 is not in team t1
      monitor: { create },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, { schedule: jest.fn() }).create("u1", {
        teamId: "t1", name: "x", type: "METRIC", metric: "CPU", thresholdPct: 90, serverId: "s9",
      } as unknown as Parameters<MonitorsService["create"]>[1]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a channelId that belongs to another team and creates nothing", async () => {
    const create = jest.fn();
    const prisma = {
      notificationChannel: { findMany: jest.fn().mockResolvedValue([]) }, // c9 not owned by t1
      monitor: { create },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, { schedule: jest.fn() }).create("u1", {
        teamId: "t1", name: "x", type: "HTTP", target: "https://x.com", channelIds: ["c9"],
      } as unknown as Parameters<MonitorsService["create"]>[1]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("MonitorsService.setChannelsBulk (fleet alert)", () => {
  it("applies same-team channels to writable monitors, skipping the rest", async () => {
    const $transaction = jest.fn().mockResolvedValue([]);
    const prisma = {
      monitor: {
        // m1=t1 (OWNER, has a t1 channel) · m2=t2 (VIEWER, skip) · m3=t3 (OWNER, but no t3 channel)
        findMany: jest.fn().mockResolvedValue([
          { id: "m1", teamId: "t1" },
          { id: "m2", teamId: "t2" },
          { id: "m3", teamId: "t3" },
        ]),
      },
      notificationChannel: { findMany: jest.fn().mockResolvedValue([{ id: "c1", teamId: "t1" }]) },
      monitorChannel: { deleteMany: jest.fn().mockReturnValue({}), createMany: jest.fn().mockReturnValue({}) },
      $transaction,
    } as unknown as PrismaService;
    const access = {
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([
        ["t1", new Set(ALL_PERMS)],
        ["t2", new Set<string>()],
        ["t3", new Set(ALL_PERMS)],
      ])),
    } as unknown as TeamAccessService;

    const res = await make(prisma, access, {}).setChannelsBulk("u1", ["m1", "m2", "m3"], ["c1"]);

    expect(res.applied).toEqual(["m1"]);
    expect(res.skipped.sort()).toEqual(["m2", "m3"]);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "monitor.channels.bulk" }));
  });

  it("applies nothing when no monitor is writable", async () => {
    const $transaction = jest.fn().mockResolvedValue([]);
    const prisma = {
      monitor: { findMany: jest.fn().mockResolvedValue([{ id: "m2", teamId: "t2" }]) },
      notificationChannel: { findMany: jest.fn().mockResolvedValue([{ id: "c2", teamId: "t2" }]) },
      monitorChannel: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction,
    } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t2", new Set<string>()]])) } as unknown as TeamAccessService;
    const res = await make(prisma, access, {}).setChannelsBulk("u1", ["m2"], ["c2"]);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual(["m2"]);
    expect($transaction).not.toHaveBeenCalled();
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
