import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DigestService } from "./digest.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { NotificationQueueService } from "./queue.service";

const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

function prismaMock(over: Record<string, unknown> = {}) {
  const g = (v: unknown) => jest.fn().mockResolvedValue(v);
  return {
    teamDigest: { findUnique: g(null), findMany: g([]), upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ ...create, channel: { name: "Ops" } })), updateMany: g({ count: 1 }) },
    notificationChannel: { findUnique: g({ teamId: "t1", locale: "en" }) },
    team: { findUnique: g({ name: "Acme" }) },
    deployment: {
      groupBy: jest.fn().mockImplementation(({ by }: { by: string[] }) =>
        Promise.resolve(by[0] === "status" ? [{ status: "SUCCESS", _count: { _all: 11 } }, { status: "FAILED", _count: { _all: 1 } }] : [{ appId: "a1", _count: { _all: 1 } }]),
      ),
    },
    backup: { groupBy: g([{ status: "SUCCESS", _count: { _all: 20 } }]) },
    volumeBackup: { groupBy: g([{ status: "SUCCESS", _count: { _all: 10 } }]) },
    database: { count: g(0) },
    heartbeat: { count: g(0) },
    server: { findMany: g([{ id: "s1", name: "web-1" }, { id: "s2", name: "db-1" }]) },
    application: { findUnique: g({ name: "Acme API" }) },
    metricRollup: {
      groupBy: g([
        { serverId: "s1", _avg: { avgCpu: 41.6, avgDiskUsed: 50, avgDiskTotal: 100 } },
        { serverId: "s2", _avg: { avgCpu: 12, avgDiskUsed: 95, avgDiskTotal: 100 } },
      ]),
    },
    metric: { groupBy: g([]) },
    ...over,
  } as unknown as PrismaService;
}

const queue = () => ({ enqueue: jest.fn().mockResolvedValue(undefined), deliverNow: jest.fn().mockResolvedValue(undefined) }) as unknown as NotificationQueueService & { enqueue: jest.Mock; deliverNow: jest.Mock };
const access = (over: Partial<TeamAccessService> = {}) => ({ requirePermission: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue("OWNER"), ...over }) as unknown as TeamAccessService;

beforeEach(() => jest.clearAllMocks());
afterAll(() => {
  delete process.env.HUB_TIMEZONE;
});

describe("DigestService settings", () => {
  it("any member may read; a stranger gets 404", async () => {
    const svc = new DigestService(prismaMock(), access(), audit, queue());
    expect(await svc.get("u1", "t1")).toMatchObject({ enabled: false, channelId: null, hour: 8 });
    const nobody = new DigestService(prismaMock(), access({ teamRole: jest.fn().mockResolvedValue(null) }), audit, queue());
    await expect(nobody.get("u1", "t1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("enabling needs a channel of the same team", async () => {
    const svc = new DigestService(prismaMock(), access(), audit, queue());
    await expect(svc.update("u1", "t1", { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    const other = new DigestService(prismaMock({ notificationChannel: { findUnique: jest.fn().mockResolvedValue({ teamId: "t2", locale: "en" }) } }), access(), audit, queue());
    await expect(other.update("u1", "t1", { enabled: true, channelId: "cX" })).rejects.toThrow(/this team's channels/);
  });

  it("turning it on mid-week claims this week so nothing fires at once", async () => {
    const prisma = prismaMock();
    const svc = new DigestService(prisma, access(), audit, queue());
    const view = await svc.update("u1", "t1", { enabled: true, channelId: "c1" });
    const create = (prisma.teamDigest.upsert as jest.Mock).mock.calls[0][0].create;
    expect(create.lastSentAt).toBeInstanceOf(Date);
    expect(view).toMatchObject({ enabled: true, channelId: "c1", channelName: "Ops" });
  });

  it("requires the integrations permission", async () => {
    const svc = new DigestService(prismaMock(), access({ requirePermission: jest.fn().mockRejectedValue(new Error("forbidden")) }), audit, queue());
    await expect(svc.update("u1", "t1", { enabled: false })).rejects.toThrow("forbidden");
    await expect(svc.sendNow("u1", "t1")).rejects.toThrow("forbidden");
  });
});

describe("DigestService.collect / buildEvent", () => {
  it("gathers the week and turns it into suggestions", async () => {
    const svc = new DigestService(prismaMock(), access(), audit, queue());
    const ev = await svc.buildEvent("t1", "en", new Date("2026-11-23T08:00:00Z"));
    expect(ev).toMatchObject({ type: "weekly_digest", teamId: "t1", locale: "en" });
    expect(ev.ctx).toMatchObject({
      teamName: "Acme",
      deploys: { total: 12, failed: 1 },
      backups: { total: 30, failed: 0 },
      incidents: 0,
      busiestServer: { name: "web-1", cpuPct: 41.6 },
    });
    // db-1's disk averages 95% → the one suggestion this week
    expect((ev.ctx.suggestions as Array<{ code: string }>).map((s) => s.code)).toEqual(["disk_high"]);
  });

  it("falls back to raw samples when there are no rollups yet", async () => {
    const prisma = prismaMock({
      metricRollup: { groupBy: jest.fn().mockResolvedValue([]) },
      metric: { groupBy: jest.fn().mockResolvedValue([{ serverId: "s2", _avg: { cpu: 70, diskUsed: 10, diskTotal: 100 } }]) },
    });
    const stats = await new DigestService(prisma, access(), audit, queue()).collect("t1", new Date());
    expect(stats.busiestServer).toEqual({ name: "db-1", cpuPct: 70 });
  });

  it("scopes every query to the team", async () => {
    const prisma = prismaMock();
    await new DigestService(prisma, access(), audit, queue()).collect("t9", new Date());
    expect((prisma.deployment.groupBy as jest.Mock).mock.calls[0][0].where.application).toEqual({ teamId: "t9" });
    expect((prisma.backup.groupBy as jest.Mock).mock.calls[0][0].where.database).toEqual({ teamId: "t9" });
    expect((prisma.server.findMany as jest.Mock).mock.calls[0][0].where).toEqual({ teamId: "t9" });
    expect((prisma.heartbeat.count as jest.Mock).mock.calls[0][0].where.monitor).toEqual({ teamId: "t9" });
  });
});

describe("DigestService.runDue", () => {
  const MONDAY = new Date("2026-11-23T08:10:00Z");
  const row = (over = {}) => ({ teamId: "t1", enabled: true, channelId: "c1", lastSentAt: new Date("2026-11-16T08:05:00Z"), channel: { locale: "en", enabled: true }, ...over });

  it("sends a due digest through the durable queue, bypassing the channel policy", async () => {
    const q = queue();
    const prisma = prismaMock({ teamDigest: { findMany: jest.fn().mockResolvedValue([row()]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });
    process.env.HUB_TIMEZONE = "UTC";
    expect(await new DigestService(prisma, access(), audit, q).runDue(MONDAY)).toBe(1);
    expect(q.enqueue).toHaveBeenCalledWith("c1", expect.objectContaining({ type: "weekly_digest" }), { bypassPolicy: true });
    // claimed by compare-and-set on the previous lastSentAt
    expect((prisma.teamDigest.updateMany as jest.Mock).mock.calls[0][0]).toMatchObject({ where: { teamId: "t1", lastSentAt: new Date("2026-11-16T08:05:00Z") }, data: { lastSentAt: MONDAY } });
  });

  it("does nothing when this week's was already sent, or it is not Monday morning yet", async () => {
    process.env.HUB_TIMEZONE = "UTC";
    const q = queue();
    const sent = prismaMock({ teamDigest: { findMany: jest.fn().mockResolvedValue([row({ lastSentAt: new Date("2026-11-23T08:01:00Z") })]), updateMany: jest.fn() } });
    expect(await new DigestService(sent, access(), audit, q).runDue(MONDAY)).toBe(0);
    const early = prismaMock({ teamDigest: { findMany: jest.fn().mockResolvedValue([row()]), updateMany: jest.fn() } });
    expect(await new DigestService(early, access(), audit, q).runDue(new Date("2026-11-23T07:00:00Z"))).toBe(0);
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it("loses the race gracefully: another hub claimed the week first", async () => {
    process.env.HUB_TIMEZONE = "UTC";
    const q = queue();
    const prisma = prismaMock({ teamDigest: { findMany: jest.fn().mockResolvedValue([row()]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) } });
    expect(await new DigestService(prisma, access(), audit, q).runDue(MONDAY)).toBe(0);
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it("one team failing does not stop the others", async () => {
    process.env.HUB_TIMEZONE = "UTC";
    const q = queue();
    q.enqueue.mockRejectedValueOnce(new Error("redis down")).mockResolvedValue(undefined);
    const prisma = prismaMock({ teamDigest: { findMany: jest.fn().mockResolvedValue([row(), row({ teamId: "t2", channelId: "c2" })]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });
    const update = prisma.teamDigest.updateMany as jest.Mock;
    expect(await new DigestService(prisma, access(), audit, q).runDue(MONDAY)).toBe(1);
    // the failed team's claim was handed back (restored to its previous lastSentAt)
    expect(update.mock.calls.some(([a]) => a.where.lastSentAt?.getTime() === MONDAY.getTime() && a.data.lastSentAt.getTime() === new Date("2026-11-16T08:05:00Z").getTime())).toBe(true);
  });

  it("send-now delivers synchronously to the chosen channel and leaves the schedule alone", async () => {
    const q = queue();
    const prisma = prismaMock({ teamDigest: { findUnique: jest.fn().mockResolvedValue({ teamId: "t1", channelId: "c1" }), updateMany: jest.fn() } });
    await new DigestService(prisma, access(), audit, q).sendNow("u1", "t1");
    expect(q.deliverNow).toHaveBeenCalledWith("c1", expect.objectContaining({ type: "weekly_digest" }));
    expect(prisma.teamDigest.updateMany as jest.Mock).not.toHaveBeenCalled();
    const none = new DigestService(prismaMock(), access(), audit, q);
    await expect(none.sendNow("u1", "t1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
