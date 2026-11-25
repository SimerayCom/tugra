import { PrismaService } from "../src/prisma/prisma.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { ContainerMetricsService } from "../src/metrics/container-metrics.service";
import { ServersService } from "../src/servers/servers.service";

/**
 * The batched telemetry writes against a real database: the multi-row INSERTs land every row (Json/BigInt/NULL
 * columns included), the one-statement lastSeenAt flush stores the right UTC instant, never moves a value
 * backwards and ignores deleted servers, and a poison row (a server deleted while its samples were buffered)
 * does not take its neighbours down with it.
 */
describe("batched telemetry ingest (real database)", () => {
  const prisma = new PrismaService();
  const tag = `ib${Date.now().toString(36)}`;
  const teamId = `${tag}-team`;
  const [s1, s2] = [`${tag}-s1`, `${tag}-s2`];
  const metrics = new MetricsService(prisma, { client: { publish: async () => 0 } } as never);
  const containers = new ContainerMetricsService(prisma);
  // flushLastSeen only needs prisma; the rest of the constructor is unused on this path.
  const servers = new ServersService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
  const sample = (ts: number, over: Record<string, unknown> = {}) => ({ ts, cpu: 5, memUsed: 1, memTotal: 2, diskUsed: 3, diskTotal: 4, netRx: 5, netTx: 6, diskRead: 7, diskWrite: 8, ...over });

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.team.create({ data: { id: teamId, name: tag } });
    for (const id of [s1, s2]) await prisma.server.create({ data: { id, name: id, teamId, enrollToken: `${id}-tok`, status: "ONLINE" } });
  });
  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } });
    await prisma.$disconnect();
  });

  it("writes buffered host samples (optional sensors, NULLs, BigInt) as one multi-row insert", async () => {
    const now = Date.now();
    await metrics.ingest(s1, sample(now - 3000, { load1: 0.5, swapUsed: 10, swapTotal: 20 }) as never);
    await metrics.ingest(s1, sample(now - 2000, { temp: 61.5, gpus: [{ name: "g0", util: 40, memUsed: 1, memTotal: 2, temp: 50 }] }) as never);
    await metrics.ingest(s2, sample(now - 1000) as never);
    expect(await prisma.metric.count({ where: { serverId: { in: [s1, s2] } } })).toBe(0); // buffered, not yet written
    await metrics.flush();
    const rows = await prisma.metric.findMany({ where: { serverId: { in: [s1, s2] } }, orderBy: { ts: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ load1: 0.5, swapUsed: 10n, temp: null, detail: null });
    expect(rows[1]).toMatchObject({ temp: 61.5, gpuUtil: 40 });
    expect(rows[1].detail).toMatchObject({ gpus: [{ name: "g0" }] });
    expect(rows[2].serverId).toBe(s2);
  });

  it("writes container samples, and a deleted server's rows are rejected without losing the others", async () => {
    const msg = (names: string[]) => ({
      type: "container_metrics" as const,
      ts: Date.now(),
      samples: names.map((n) => ({ id: `${n}-id`, name: n, cpu: 1, memUsed: 2, memTotal: 3, memPct: 4, netRx: 5, netTx: 6, blkRead: 7, blkWrite: 8 })),
    });
    await containers.ingest(s1, msg(["web", "db"]));
    await containers.ingest(`${tag}-gone`, msg(["ghost"])); // FK violation: this server does not exist
    await containers.ingest(s2, msg(["api"]));
    await containers.flush();
    expect((await prisma.containerMetric.findMany({ where: { serverId: { in: [s1, s2] } } })).map((r) => r.containerName).sort()).toEqual(["api", "db", "web"]);
    expect(containers.ingestStats()).toMatchObject({ buffered: 0, rejected: 1 });
  });

  it("flushLastSeen stores the exact UTC instant in one statement, never moves backwards, skips unknown servers", async () => {
    const future = new Date(Date.now() + 3_600_000);
    await prisma.server.update({ where: { id: s2 }, data: { lastSeenAt: future } });
    const before = Date.now();
    await servers.touch(s1);
    await servers.touch(s2); // older than what is stored → must not overwrite
    await servers.touch(`${tag}-nope`); // no such row → harmless
    await servers.flushLastSeen();
    const a = await prisma.server.findUniqueOrThrow({ where: { id: s1 } });
    const b = await prisma.server.findUniqueOrThrow({ where: { id: s2 } });
    expect(Math.abs(a.lastSeenAt!.getTime() - before)).toBeLessThan(5000); // right instant (no timezone shift)
    expect(b.lastSeenAt!.getTime()).toBe(future.getTime());
    await servers.onModuleDestroy();
  });
});
