import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { StatusPageService } from "./status-page.service";
import { StatusSubscribersService } from "./status-subscribers.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const config = { get: () => "https://panel.example.com" } as unknown as ConfigService;
const subscribers = {
  emailAvailable: () => true,
  counts: jest.fn().mockResolvedValue({ confirmed: 2, pending: 1 }),
  notifyMaintenance: jest.fn().mockResolvedValue(undefined),
} as unknown as StatusSubscribersService;

function make(prisma: unknown, access: Partial<TeamAccessService> = {}) {
  const acc = { teamRole: jest.fn().mockResolvedValue("OWNER"), requirePermission: jest.fn().mockResolvedValue(undefined), ...access } as unknown as TeamAccessService;
  return new StatusPageService(prisma as PrismaService, acc, audit, config, subscribers);
}

const now = Date.now();
const page = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  slug: "acme",
  title: "Acme status",
  description: null,
  enabled: true,
  monitors: [
    { monitorId: "m1", label: null, position: 0, monitor: { id: "m1", name: "Website", status: "UP", enabled: true, target: "https://secret.internal/health" } },
    { monitorId: "m2", label: "API", position: 1, monitor: { id: "m2", name: "api-prod-eu-1", status: "DOWN", enabled: true, target: "10.0.0.5:443" } },
  ],
  maintenance: [{ id: "x1", title: "Database upgrade", body: "Short outage", startsAt: new Date(now + 3_600_000), endsAt: new Date(now + 7_200_000) }],
  ...over,
});

describe("StatusPageService.publicView", () => {
  const prismaWith = (p: unknown) => ({
    statusPage: { findFirst: jest.fn().mockResolvedValue(p) },
    $queryRaw: jest.fn().mockResolvedValue([
      { monitorId: "m1", day: new Date(now), total: BigInt(100), up: BigInt(99) },
      { monitorId: "m2", day: new Date(now), total: BigInt(10), up: BigInt(0) },
    ]),
    heartbeat: {
      findMany: jest.fn().mockResolvedValue([
        { monitorId: "m2", status: "DOWN", important: true, ts: new Date(now - 600_000) },
        { monitorId: "m1", status: "DOWN", important: true, ts: new Date(now - 7_200_000) },
        { monitorId: "m1", status: "UP", important: true, ts: new Date(now - 6_000_000) },
      ]),
    },
  });

  it("shows only labels, states, uptime, incident times and maintenance", async () => {
    const view = await make(prismaWith(page())).publicView("acme");
    expect(view.overall).toBe("partial");
    expect(view.monitors.map((m) => [m.name, m.status])).toEqual([["Website", "up"], ["API", "down"]]);
    expect(view.monitors[0].uptime).toBe(99);
    expect(view.monitors[0].days).toHaveLength(30);
    expect(view.incidents.map((i) => [i.monitor, i.resolvedAt === null])).toEqual([["API", true], ["Website", false]]);
    expect(view.maintenance[0]).toMatchObject({ title: "Database upgrade", state: "scheduled" });
    const json = JSON.stringify(view);
    for (const secret of ["secret.internal", "10.0.0.5", "api-prod-eu-1", "m1", "m2", "teamId"]) expect(json).not.toContain(secret);
  });

  it("is a banner of 'maintenance' while a window is running", async () => {
    const p = page({ maintenance: [{ id: "x", title: "Now", body: null, startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000) }] });
    expect((await make(prismaWith(p)).publicView("acme")).overall).toBe("maintenance");
  });

  it("404s an unknown or unpublished page and caches a hit", async () => {
    await expect(make(prismaWith(null)).publicView("nope")).rejects.toThrow(NotFoundException);
    const prisma = prismaWith(page());
    const svc = make(prisma);
    await svc.publicView("acme");
    await svc.publicView("acme");
    expect(prisma.statusPage.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.statusPage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: "acme", enabled: true } }));
  });

  it("renders valid, escaped RSS", async () => {
    const p = page({ title: "Acme <&> status" });
    const xml = await make(prismaWith(p)).rss("acme");
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<title>Acme &lt;&amp;&gt; status</title>");
    expect(xml).toContain("API is having issues");
    expect(xml).toContain("Planned maintenance: Database upgrade");
    expect(xml).toContain("https://panel.example.com/status/acme");
    expect(xml).not.toContain("secret.internal");
  });
});

describe("StatusPageService management", () => {
  const input = { slug: "acme", title: "Acme", enabled: true, monitors: [{ monitorId: "m1", label: null }, { monitorId: "m2", label: "API" }] };

  it("requires the monitors permission and only team monitors", async () => {
    const denied = make({}, { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient permission for this team")) });
    await expect(denied.update("u1", "t1", input)).rejects.toThrow(/insufficient permission/);
    const prisma = { monitor: { count: jest.fn().mockResolvedValue(1) } };
    await expect(make(prisma).update("u1", "t1", input)).rejects.toThrow(BadRequestException);
    expect(prisma.monitor.count).toHaveBeenCalledWith({ where: { id: { in: ["m1", "m2"] }, teamId: "t1" } });
  });

  it("creates the page with its ordered monitors, and reports a taken address", async () => {
    const tx = { statusPage: { create: jest.fn() } };
    const prisma = {
      monitor: { count: jest.fn().mockResolvedValue(2) },
      statusPage: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(null) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    await make(prisma).update("u1", "t1", input);
    expect(tx.statusPage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ teamId: "t1", slug: "acme", monitors: { create: [{ monitorId: "m1", label: null, position: 0 }, { monitorId: "m2", label: "API", position: 1 }] } }),
    });
    prisma.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    await expect(make(prisma).update("u1", "t1", input)).rejects.toThrow(ConflictException);
  });

  it("a non-member cannot read the settings", async () => {
    const svc = make({}, { teamRole: jest.fn().mockResolvedValue(null) });
    await expect(svc.get("u1", "t1")).rejects.toThrow(NotFoundException);
  });

  it("maintenance needs an existing page and announces to subscribers when published", async () => {
    const noPage = { statusPage: { findUnique: jest.fn().mockResolvedValue(null) } };
    const w = { title: "Upgrade", startsAt: new Date(now + 1000).toISOString(), endsAt: new Date(now + 5000).toISOString() };
    await expect(make(noPage).addMaintenance("u1", "t1", w)).rejects.toThrow(NotFoundException);
    const prisma = {
      statusPage: { findUnique: jest.fn().mockResolvedValue({ id: "p1", slug: "acme", title: "Acme", enabled: true, monitors: [], maintenance: [], description: null }) },
      statusMaintenance: { create: jest.fn().mockResolvedValue({ id: "x1", title: "Upgrade", body: null, startsAt: new Date(now + 1000), endsAt: new Date(now + 5000) }) },
    };
    await make(prisma).addMaintenance("u1", "t1", w);
    expect(subscribers.notifyMaintenance).toHaveBeenCalled();
  });
});
