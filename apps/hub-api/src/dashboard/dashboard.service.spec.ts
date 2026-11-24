import { DashboardService } from "./dashboard.service";

const GB = 1_000_000_000;

function make(opts: { memberships?: Record<string, any>; apps?: any[]; dbs?: any[]; servers?: any[]; latest?: any[]; hourly?: any[]; envProject?: Record<string, string> } = {}) {
  const memberships = opts.memberships ?? { t1: { role: "OWNER", teamRoleId: null, restrictedAccess: false, accessedProjects: [], accessedResources: [] } };
  const access = { accessByTeam: jest.fn().mockResolvedValue(new Map(Object.entries(memberships))) } as any;
  const prisma = {
    application: { findMany: jest.fn().mockResolvedValue(opts.apps ?? []) },
    database: { findMany: jest.fn().mockResolvedValue(opts.dbs ?? []) },
    environment: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.id.in.map((id: string) => ({ id, name: "production", project: { id: opts.envProject?.[id] ?? "p1", name: "P" } }))),
      ),
    },
    backup: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    volumeBackup: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    deployment: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue(opts.hourly ?? []),
  } as any;
  const servers = { listForUser: jest.fn().mockResolvedValue(opts.servers ?? []) } as any;
  const metrics = { latestForServers: jest.fn().mockResolvedValue(opts.latest ?? []) } as any;
  return { svc: new DashboardService(prisma, access, servers, metrics), prisma, access, servers, metrics };
}

describe("DashboardService.insights", () => {
  it("returns an empty digest for a user in no team (or a team they are not in), touching nothing", async () => {
    const { svc, prisma } = make();
    const out = await svc.insights("u1", "someone-elses-team");
    expect(out).toEqual({ diskForecast: [], backups: { windowDays: 7, ok: 0, failed: 0, running: 0, recent: [] }, deploys: [] });
    expect(prisma.application.findMany).not.toHaveBeenCalled();
    expect(prisma.backup.groupBy).not.toHaveBeenCalled();
  });

  it("scopes every query to the caller's (optionally narrowed) teams", async () => {
    const { svc, prisma, servers } = make({
      memberships: {
        t1: { role: "OWNER", teamRoleId: null, restrictedAccess: false, accessedProjects: [], accessedResources: [] },
        t2: { role: "VIEWER", teamRoleId: null, restrictedAccess: false, accessedProjects: [], accessedResources: [] },
      },
    });
    await svc.insights("u1");
    expect(prisma.application.findMany.mock.calls[0][0].where.teamId).toEqual({ in: ["t1", "t2"] });
    await svc.insights("u1", "t2");
    expect(prisma.application.findMany.mock.calls[1][0].where.teamId).toEqual({ in: ["t2"] });
    expect(prisma.database.findMany.mock.calls[1][0].where.teamId).toEqual({ in: ["t2"] });
    expect(servers.listForUser).toHaveBeenLastCalledWith("u1", { teamId: "t2" });
  });

  it("serves the disk forecast from a short cache per caller and team scope", async () => {
    const { svc, servers } = make();
    await svc.insights("u1");
    await svc.insights("u1");
    expect(servers.listForUser).toHaveBeenCalledTimes(1);
    await svc.insights("u2");
    expect(servers.listForUser).toHaveBeenCalledTimes(2);
  });

  it("hides apps and databases a project-restricted member was not granted from backups and deploys", async () => {
    const { svc, prisma } = make({
      memberships: { t1: { role: "VIEWER", teamRoleId: null, restrictedAccess: true, accessedProjects: ["p-ok"], accessedResources: [] } },
      apps: [{ id: "a1", name: "Granted", teamId: "t1", environmentId: "e1" }, { id: "a2", name: "Hidden", teamId: "t1", environmentId: "e2" }],
      dbs: [{ id: "d1", name: "hidden-db", teamId: "t1", environmentId: "e2" }],
      envProject: { e1: "p-ok", e2: "p-no" },
    });
    await svc.insights("u1");
    expect(prisma.deployment.findMany.mock.calls[0][0].where.appId.in).toEqual(["a1"]);
    expect(prisma.backup.groupBy).not.toHaveBeenCalled(); // the only database is not visible → never queried
    expect(prisma.volumeBackup.groupBy.mock.calls[0][0].where.appId.in).toEqual(["a1"]);
  });

  it("digests backups: counts per status, failed first, resource names resolved", async () => {
    const { svc, prisma } = make({
      apps: [{ id: "a1", name: "Shop", teamId: "t1", environmentId: "e1" }],
      dbs: [{ id: "d1", name: "main-pg", teamId: "t1", environmentId: "e1" }],
    });
    prisma.backup.groupBy.mockResolvedValue([{ status: "SUCCESS", _count: { _all: 5 } }, { status: "FAILED", _count: { _all: 1 } }]);
    prisma.volumeBackup.groupBy.mockResolvedValue([{ status: "SUCCESS", _count: { _all: 2 } }, { status: "RUNNING", _count: { _all: 1 } }]);
    const t = (s: string) => new Date(s);
    prisma.backup.findMany
      .mockResolvedValueOnce([{ id: "b-ok", databaseId: "d1", status: "SUCCESS", createdAt: t("2026-11-24T09:00:00Z"), sizeBytes: 2048n }])
      .mockResolvedValueOnce([{ id: "b-fail", databaseId: "d1", status: "FAILED", createdAt: t("2026-11-22T09:00:00Z"), sizeBytes: null }]);
    const out = await svc.insights("u1");
    expect(out.backups).toMatchObject({ windowDays: 7, ok: 7, failed: 1, running: 1 });
    expect(out.backups.recent.map((r) => [r.id, r.status, r.resourceName, r.sizeBytes])).toEqual([
      ["b-fail", "FAILED", "main-pg", null],
      ["b-ok", "SUCCESS", "main-pg", 2048],
    ]);
    expect(JSON.stringify(out)).not.toContain("errorTail"); // never selects the scrubbed error text
  });

  it("digests the most recent deploys with app names", async () => {
    const { svc, prisma } = make({ apps: [{ id: "a1", name: "Shop", teamId: "t1", environmentId: "e1" }] });
    prisma.deployment.findMany.mockResolvedValue([{ id: "x1", appId: "a1", status: "SUCCESS", trigger: "webhook", createdAt: new Date("2026-11-24T08:00:00Z"), durationMs: 41_000 }]);
    const out = await svc.insights("u1");
    expect(prisma.deployment.findMany.mock.calls[0][0]).toMatchObject({ take: 8, orderBy: { createdAt: "desc" } });
    expect(out.deploys).toEqual([{ id: "x1", appId: "a1", appName: "Shop", status: "SUCCESS", trigger: "webhook", createdAt: "2026-11-24T08:00:00.000Z", durationMs: 41_000 }]);
  });

  it("forecasts disk fill per visible server, soonest first, skipping servers with no disk reading", async () => {
    const base = Date.now() - 3 * 86_400_000;
    const hourly = (id: string, start: number, perDay: number) =>
      Array.from({ length: 72 }, (_, i) => ({ serverId: id, h: new Date(base + i * 3600_000), used: start + (perDay * i) / 24 }));
    const { svc, servers, metrics } = make({
      servers: [{ id: "s-slow", name: "slow" }, { id: "s-fast", name: "fast" }, { id: "s-none", name: "none" }],
      latest: [
        { serverId: "s-slow", sample: { diskUsed: 30 * GB, diskTotal: 100 * GB } },
        { serverId: "s-fast", sample: { diskUsed: 80 * GB, diskTotal: 100 * GB } },
      ],
      hourly: [...hourly("s-slow", 28 * GB, 0.5 * GB), ...hourly("s-fast", 75 * GB, 2 * GB)],
    });
    const out = await svc.insights("u1");
    expect(metrics.latestForServers).toHaveBeenCalledWith(["s-slow", "s-fast", "s-none"]);
    expect(servers.listForUser).toHaveBeenCalledWith("u1", { teamId: undefined });
    expect(out.diskForecast.map((r) => r.serverName)).toEqual(["fast", "slow"]);
    expect(out.diskForecast[0]).toMatchObject({ serverId: "s-fast", usedPct: 80, freeBytes: 20 * GB });
    expect(out.diskForecast[0].daysToFull!).toBeLessThan(out.diskForecast[1].daysToFull!);
  });
});
