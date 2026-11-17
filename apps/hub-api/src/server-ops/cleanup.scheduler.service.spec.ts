import { ConfigService } from "@nestjs/config";
import { ServerStatus } from "@prisma/client";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

const NOW = new Date("2026-11-26T12:00:00Z");
const hot = { ts: new Date(NOW.getTime() - 30_000), diskUsed: 90n, diskTotal: 100n };

function make(opts: {
  servers: Array<Record<string, unknown>>;
  metric?: unknown;
  repeatables?: string[];
  redisSet?: jest.Mock;
}) {
  const findMany = jest.fn().mockImplementation(async (args: { where: Record<string, unknown> }) =>
    opts.servers.filter((s) => (args.where.cleanupEnabled === true ? s.cleanupEnabled === true : true) && (args.where.cleanupThresholdPct ? s.cleanupThresholdPct != null : true)),
  );
  const prisma = {
    server: { findMany },
    metric: { findFirst: jest.fn().mockResolvedValue(opts.metric === undefined ? hot : opts.metric) },
  } as unknown as PrismaService;
  const runCleanup = jest.fn().mockResolvedValue({ ok: true, reclaimed: "", output: "" });
  const runner = { runCleanup } as unknown as CleanupRunnerService;
  // Atomic SET NX EX: first claim per key wins, later ones get null — like Redis.
  const claimed = new Set<string>();
  const set = opts.redisSet ?? jest.fn().mockImplementation(async (k: string) => (claimed.has(k) ? null : (claimed.add(k), "OK")));
  const redis = { client: { set } } as unknown as RedisService;
  const svc = new CleanupSchedulerService({ get: () => "redis://x" } as unknown as ConfigService, prisma, runner, redis);
  const added: Array<{ name: string; opts: unknown }> = [];
  const removed: string[] = [];
  const repeatables = (opts.repeatables ?? []).map((n) => ({ name: n, key: `k:${n}` }));
  (svc as unknown as { queue: unknown }).queue = {
    add: jest.fn().mockImplementation(async (name: string, _d: unknown, o: unknown) => void added.push({ name, opts: o })),
    getRepeatableJobs: jest.fn().mockResolvedValue(repeatables),
    removeRepeatableByKey: jest.fn().mockImplementation(async (k: string) => void removed.push(k)),
  };
  return { svc, runCleanup, added, removed, set, findMany };
}

const srv = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: ServerStatus.ONLINE, cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupIntervalHours: null, cleanupThresholdPct: 80, timezone: null, ...over,
});

describe("CleanupSchedulerService.registerAll (boot + reconcile)", () => {
  it("boot (force) registers every enabled server; disabled servers are never scheduled (explicit-off respected)", async () => {
    const { svc, added, findMany } = make({ servers: [srv("a"), srv("b", { cleanupEnabled: false })] });
    const r = await svc.registerAll(true);
    expect(findMany.mock.calls[0][0].where).toEqual({ cleanupEnabled: true });
    expect(added.map((a) => a.name)).toEqual(["cleanup:a"]);
    expect(r).toEqual({ ok: 1, total: 1 });
  });

  it("registers a default-on server with no cron/interval using the default daily cron", async () => {
    const { svc, added } = make({ servers: [srv("a", { cleanupCron: null })] });
    await svc.registerAll(true);
    expect(added[0]).toEqual({ name: "cleanup:a", opts: { repeat: { pattern: "0 3 * * *" } } });
  });

  it("reconcile (non-force) adds only servers missing a repeatable, e.g. created after boot", async () => {
    const { svc, added } = make({ servers: [srv("old"), srv("new")], repeatables: ["cleanup:old"] });
    const r = await svc.registerAll(false);
    expect(added.map((a) => a.name)).toEqual(["cleanup:new"]);
    expect(r).toEqual({ ok: 2, total: 2 });
  });

  it("a bad stored cron skips that server and keeps scheduling the rest", async () => {
    const { svc, added } = make({ servers: [srv("bad"), srv("good")] });
    const q = (svc as unknown as { queue: { add: jest.Mock } }).queue;
    q.add.mockImplementationOnce(async () => { throw new Error("bad cron"); });
    // first unschedule() lookup is fine; the first add throws.
    const r = await svc.registerAll(true);
    expect(r).toEqual({ ok: 1, total: 2 });
    expect(added.map((a) => a.name)).toEqual(["cleanup:good"]);
  });
});

describe("CleanupSchedulerService.sweep (disk-threshold trigger)", () => {
  it("runs a cleanup when usage is at/above the threshold, as the 'threshold' actor, skipping deploys", async () => {
    const { svc, runCleanup } = make({ servers: [srv("a")] });
    const r = await svc.sweep(NOW);
    expect(r.triggered).toEqual(["a"]);
    expect(runCleanup).toHaveBeenCalledWith("a", "threshold", { skipIfDeploying: true });
  });

  it("is throttled: a second sweep inside the hour does not run again; the Redis claim is SET NX EX 3600", async () => {
    const { svc, runCleanup, set } = make({ servers: [srv("a")] });
    await svc.sweep(NOW);
    await svc.sweep(new Date(NOW.getTime() + 5 * 60_000));
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith("cleanup:threshold:a", expect.any(String), "EX", 3600, "NX");
  });

  it("does not run below the threshold, when the server is OFFLINE, or with a stale sample", async () => {
    const below = make({ servers: [srv("a")], metric: { ...hot, diskUsed: 50n } });
    await below.svc.sweep(NOW);
    expect(below.runCleanup).not.toHaveBeenCalled();
    const offline = make({ servers: [srv("a", { status: ServerStatus.OFFLINE })] });
    await offline.svc.sweep(NOW);
    expect(offline.runCleanup).not.toHaveBeenCalled();
    const stale = make({ servers: [srv("a")], metric: { ...hot, ts: new Date(NOW.getTime() - 3_600_000) } });
    await stale.svc.sweep(NOW);
    expect(stale.runCleanup).not.toHaveBeenCalled();
  });

  it("explicit-off server (cleanupEnabled=false) is never triggered, however full its disk", async () => {
    const { svc, runCleanup } = make({ servers: [srv("a", { cleanupEnabled: false })], metric: { ...hot, diskUsed: 99n } });
    await svc.sweep(NOW);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("falls back to an in-process hourly throttle when Redis errors (never an unthrottled loop)", async () => {
    // Fresh sample at every tick (ts in the future of all three sweeps) so only the throttle decides.
    const { svc, runCleanup } = make({ servers: [srv("a")], metric: { ...hot, ts: new Date(NOW.getTime() + 2 * 3_600_000) }, redisSet: jest.fn().mockRejectedValue(new Error("redis down")) });
    await svc.sweep(NOW);
    await svc.sweep(new Date(NOW.getTime() + 5 * 60_000));
    expect(runCleanup).toHaveBeenCalledTimes(1);
    await svc.sweep(new Date(NOW.getTime() + 61 * 60_000));
    expect(runCleanup).toHaveBeenCalledTimes(2);
  });

  it("a failing run is swallowed (the sweep keeps going) and still consumes the hourly slot", async () => {
    const { svc, runCleanup } = make({ servers: [srv("a"), srv("b")] });
    runCleanup.mockRejectedValueOnce(new Error("boom"));
    const r = await svc.sweep(NOW);
    expect(r.triggered).toEqual(["a", "b"]);
    await svc.sweep(new Date(NOW.getTime() + 60_000));
    expect(runCleanup).toHaveBeenCalledTimes(2);
  });

  it("also reconciles missing schedules on each tick", async () => {
    const { svc, added } = make({ servers: [srv("new", { cleanupThresholdPct: null })] });
    await svc.sweep(NOW);
    expect(added.map((a) => a.name)).toEqual(["cleanup:new"]);
  });
});
