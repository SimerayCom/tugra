import { ServerStatus } from "@prisma/client";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";
import { FakeHub } from "../scheduler/testing/fake-hub";

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
  const findUnique = jest.fn().mockImplementation(async (args: { where: { id: string } }) => {
    const row = opts.servers.find((x) => x.id === args.where.id);
    return row ? { id: row.id, cleanupEnabled: row.cleanupEnabled } : null;
  });
  const prisma = {
    server: { findMany, findUnique },
    metric: { findFirst: jest.fn().mockResolvedValue(opts.metric === undefined ? hot : opts.metric) },
  } as unknown as PrismaService;
  const runCleanup = jest.fn().mockResolvedValue({ ok: true, reclaimed: "1.2GB", output: "Total reclaimed space: 1.2GB" });
  const runner = { runCleanup } as unknown as CleanupRunnerService;
  // Atomic SET NX EX: first claim per key wins, later ones get null — like Redis.
  const claimed = new Set<string>();
  const ttl = new Map<string, number>();
  const set = opts.redisSet ?? jest.fn().mockImplementation(async (k: string, _v: string, _ex: string, sec: number, nx?: string) => {
    if (nx === "NX" && claimed.has(k)) return null;
    claimed.add(k);
    ttl.set(k, sec);
    return "OK";
  });
  const redis = { client: { set } } as unknown as RedisService;
  const ticks = new FakeTicks();
  const svc = new CleanupSchedulerService(new FakeHub().asService(), ticks.asService(), prisma, runner, redis);
  const added: Array<{ name: string; opts: unknown }> = [];
  const removed: string[] = [];
  const repeatables = (opts.repeatables ?? []).map((n) => ({ name: n, key: `k:${n}` }));
  (svc as unknown as { queue: unknown }).queue = {
    add: jest.fn().mockImplementation(async (name: string, _d: unknown, o: unknown) => void added.push({ name, opts: o })),
    getRepeatableJobs: jest.fn().mockResolvedValue(repeatables),
    removeRepeatableByKey: jest.fn().mockImplementation(async (k: string) => void removed.push(k)),
  };
  return { svc, runCleanup, added, removed, set, findMany, ttl, ticks };
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

describe("threshold run that frees nothing backs off", () => {
  const empty = { ok: true, reclaimed: "0B", output: "Total reclaimed space: 0B" };

  it("holds the Redis slot for 6h after a run that reclaimed nothing, and a run that reclaimed something keeps 1h", async () => {
    const a = make({ servers: [srv("a")] });
    a.runCleanup.mockResolvedValue(empty);
    await a.svc.sweep(NOW);
    expect(a.ttl.get("cleanup:threshold:a")).toBe(6 * 3600);
    const b = make({ servers: [srv("a")] });
    await b.svc.sweep(NOW);
    expect(b.ttl.get("cleanup:threshold:a")).toBe(3600);
  });

  it("does not back off for a skipped (deploy running) or failed run", async () => {
    const skipped = make({ servers: [srv("a")] });
    skipped.runCleanup.mockResolvedValue({ ok: true, reclaimed: "", output: "skipped: 1 deploy(s) running on this server" });
    await skipped.svc.sweep(NOW);
    expect(skipped.ttl.get("cleanup:threshold:a")).toBe(3600);
    const failed = make({ servers: [srv("a")] });
    failed.runCleanup.mockResolvedValue({ ok: false, reclaimed: "", output: "boom" });
    await failed.svc.sweep(NOW);
    expect(failed.ttl.get("cleanup:threshold:a")).toBe(3600);
  });

  it("in-process fallback also backs off 6h (not 1h) after an empty run", async () => {
    const { svc, runCleanup } = make({ servers: [srv("a")], metric: { ...hot, ts: new Date(NOW.getTime() + 10 * 3_600_000) }, redisSet: jest.fn().mockRejectedValue(new Error("redis down")) });
    runCleanup.mockResolvedValue(empty);
    await svc.sweep(NOW);
    await svc.sweep(new Date(NOW.getTime() + 61 * 60_000));
    expect(runCleanup).toHaveBeenCalledTimes(1);
    await svc.sweep(new Date(NOW.getTime() + 6 * 3600_000 + 60_000));
    expect(runCleanup).toHaveBeenCalledTimes(2);
  });
});

describe("worker handler (processJob) and sweep registration", () => {
  it("a sweep job reaches sweep(); a per-server job reaches runCleanup as the scheduler actor", async () => {
    const { svc, runCleanup } = make({ servers: [srv("a")] });
    const sweep = jest.spyOn(svc, "sweep");
    await svc.processJob({ name: "cleanup-threshold-sweep", data: {} });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(runCleanup).toHaveBeenCalledTimes(1); // the sweep itself found a hot server
    runCleanup.mockClear();
    await svc.processJob({ name: "cleanup:a", data: { serverId: "a" } });
    expect(runCleanup).toHaveBeenCalledWith("a", "scheduler", { skipIfDeploying: true });
  });

  it("a job for a server that was turned off is unscheduled and does not prune", async () => {
    const { svc, runCleanup, removed } = make({ servers: [srv("a", { cleanupEnabled: false })], repeatables: ["cleanup:a"] });
    await svc.processJob({ name: "cleanup:a", data: { serverId: "a" } });
    expect(runCleanup).not.toHaveBeenCalled();
    expect(removed).toEqual(["k:cleanup:a"]);
  });

  it("a job for a deleted server is unscheduled and does not prune", async () => {
    const { svc, runCleanup, removed } = make({ servers: [], repeatables: ["cleanup:gone"] });
    await svc.processJob({ name: "cleanup:gone", data: { serverId: "gone" } });
    expect(runCleanup).not.toHaveBeenCalled();
    expect(removed).toEqual(["k:cleanup:gone"]);
  });

  it("registerSweep registers the sweep as a shared-scheduler tick every 5 minutes (not a repeatable on the cleanup queue)", async () => {
    const { svc, added, ticks } = make({ servers: [] });
    await svc.registerSweep();
    expect(added).toEqual([]);
    expect(ticks.spec("cleanup-threshold-sweep").every).toBe(300000);
  });

  it("the sweep tick runs the reconcile + threshold sweep", async () => {
    const { svc, ticks, findMany } = make({ servers: [] });
    await svc.registerSweep();
    await ticks.run("cleanup-threshold-sweep");
    expect(findMany).toHaveBeenCalled();
  });
});
