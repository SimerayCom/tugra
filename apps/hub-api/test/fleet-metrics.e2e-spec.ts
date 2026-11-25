import { PrismaService } from "../src/prisma/prisma.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { ContainerMetricsService } from "../src/metrics/container-metrics.service";

/**
 * The fleet read paths (latest sample per server, live container inventory, hottest containers) run their
 * "newest per key" selection in SQL. This pins the SQL against a real database: newest wins, scoping holds, ranking
 * and LIMIT are applied by the database, stale samples fall out of the live window.
 */
describe("fleet metrics reads (real database)", () => {
  const prisma = new PrismaService();
  const tag = `fm${Date.now().toString(36)}`;
  const teamId = `${tag}-team`;
  const [s1, s2, s3] = [`${tag}-s1`, `${tag}-s2`, `${tag}-s3`];
  const metrics = new MetricsService(prisma, { client: { publish: async () => 0 } } as never);
  const containers = new ContainerMetricsService(prisma);
  const now = Date.now();

  const metric = (serverId: string, ageSec: number, cpu: number) => ({
    id: `${serverId}-m${ageSec}`, serverId, ts: new Date(now - ageSec * 1000), cpu,
    memUsed: 1n, memTotal: 2n, diskUsed: 3n, diskTotal: 4n, netRx: 0n, netTx: 0n,
  });
  const cm = (serverId: string, containerName: string, ageSec: number, cpu: number) => ({
    id: `${serverId}-${containerName}-${ageSec}`, serverId, containerName, containerId: `${containerName}-id`, ts: new Date(now - ageSec * 1000), cpu,
    memUsed: 10n, memTotal: 20n, memPct: 50, netRx: 1n, netTx: 2n, blkRead: 3n, blkWrite: 4n,
  });

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.team.create({ data: { id: teamId, name: tag } });
    for (const id of [s1, s2, s3]) await prisma.server.create({ data: { id, name: id, teamId, enrollToken: `${id}-tok`, status: "ONLINE" } });
    await prisma.metric.createMany({ data: [metric(s1, 60, 1), metric(s1, 10, 11), metric(s1, 30, 21), metric(s2, 5, 99)] }); // s3: never reported
    await prisma.containerMetric.createMany({
      data: [
        cm(s1, "web", 40, 90), // stale sample of web on s1 (still inside the window) ...
        cm(s1, "web", 5, 10), // ... the NEWEST one (10 %) is what counts
        cm(s1, "db", 8, 50),
        cm(s1, "old", 600, 99), // outside the 90 s live window
        cm(s2, "web", 6, 30),
        cm(s2, "api", 7, 70),
      ],
    });
  });
  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }); // cascades servers + metrics
    await prisma.$disconnect();
  });

  it("latestForServers returns exactly the newest sample of each requested server and skips silent ones", async () => {
    const out = await metrics.latestForServers([s1, s2, s3]);
    const by = new Map(out.map((r) => [r.serverId, r.sample]));
    expect(by.size).toBe(2);
    expect(by.get(s1)).toMatchObject({ cpu: 11, memUsed: 1, diskTotal: 4 }); // 10 s old beats 30 s and 60 s
    expect(by.get(s2)?.cpu).toBe(99);
    expect((await metrics.latestForServers([s1])).map((r) => r.serverId)).toEqual([s1]); // scoped to the ids given
    expect(await metrics.latestForServers([])).toEqual([]);
  });

  it("forServer: newest sample per live container, nothing outside the 90 s window", async () => {
    const out = await containers.forServer(s1);
    expect(out.containers.map((c) => [c.name, c.cpu]).sort()).toEqual([["db", 50], ["web", 10]]);
  });

  it("hottest: newest sample per (server, container), ranked by cpu in SQL, LIMIT applied, scoped to the given servers", async () => {
    const servers = [{ id: s1, name: "one" }, { id: s2, name: "two" }];
    const all = await containers.hottest(servers, 50);
    expect(all.map((r) => [r.serverName, r.containerName, r.cpu])).toEqual([
      ["two", "api", 70],
      ["one", "db", 50],
      ["two", "web", 30],
      ["one", "web", 10], // the newer 10 % sample, not the stale 90 % one
    ]);
    expect((await containers.hottest(servers, 2)).map((r) => r.containerName)).toEqual(["api", "db"]);
    expect((await containers.hottest([servers[0]], 50)).every((r) => r.serverName === "one")).toBe(true);
  });

  describe("chart history is strided in SQL (bounded rows) and keeps real samples", () => {
    const big = `${tag}-big`;
    beforeAll(async () => {
      await prisma.server.create({ data: { id: big, name: big, teamId, enrollToken: `${big}-tok`, status: "ONLINE" } });
      // 12 000 raw host samples 5 s apart (~16.7 h) with a distinctive cpu = index, and 4 containers of 1 400 samples each (15 s apart, ~5.8 h: inside the 6 h container raw retention).
      await prisma.$executeRawUnsafe(`
        INSERT INTO "Metric" ("id","serverId","ts","cpu","memUsed","memTotal","diskUsed","diskTotal","netRx","netTx","diskRead","diskWrite")
        SELECT '${big}-m' || g, '${big}', (now() at time zone 'utc') - g * interval '5 seconds', g, 1, 2, 3, 4, 0, 0, 0, 0 FROM generate_series(0, 11999) g`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "ContainerMetric" ("id","serverId","containerName","containerId","ts","cpu","memUsed","memTotal","memPct","netRx","netTx","blkRead","blkWrite")
        SELECT '${big}-' || n || '#' || g, '${big}', n, 'id', (now() at time zone 'utc') - g * interval '15 seconds', g, 1, 2, 3, 0, 0, 0, 0
        FROM unnest(ARRAY['tugra_app1', 'tugra_app1-web-1', 'tugraXapp1', 'tugra_app12']) n, generate_series(0, 1399) g`);
    });

    it("host history returns <= 1000 points, oldest and newest included, every value a stored sample", async () => {
      const out = await metrics.history(big, "24h");
      expect(out.length).toBeLessThanOrEqual(1000);
      expect(out.length).toBeGreaterThan(900);
      expect(out[0].cpu).toBe(11999); // the oldest row (cpu = its age index)
      expect(out[out.length - 1].cpu).toBe(0); // the newest row
      expect(out.every((p, i) => i === 0 || p.ts > out[i - 1].ts)).toBe(true); // ascending
      expect(out.every((p) => Number.isInteger(p.cpu) && p.cpu >= 0 && p.cpu <= 11999)).toBe(true); // never an invented average
    });

    it("a short series is returned whole (no stride)", async () => {
      const out = await metrics.history(s1, "1h");
      expect(out.map((p) => p.cpu)).toEqual([1, 21, 11]); // 60 s, 30 s, 10 s old, ascending by time
    });

    it("forApp: prefix match is airtight (underscore is not a wildcard), one bounded series per container", async () => {
      const out = await containers.forApp(big, "tugra_app1", "6h");
      expect(out.containers.map((c) => c.name)).toEqual(["tugra_app1", "tugra_app1-web-1"]); // not tugraXapp1, not tugra_app12
      for (const c of out.containers) {
        expect(c.samples.length).toBeLessThanOrEqual(1000);
        expect(c.samples[0].cpu).toBe(1399);
        expect(c.samples[c.samples.length - 1].cpu).toBe(0);
      }
    });
  });
});
