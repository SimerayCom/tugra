import type { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { QueueHubService } from "../src/scheduler/queue-hub.service";
import { TickSchedulerService, SCHEDULER_QUEUE } from "../src/scheduler/tick-scheduler.service";
import { retireLegacyQueues, RETIRED_QUEUES } from "../src/scheduler/legacy-queues";

/**
 * Real-Redis proof for the consolidated scheduler: nothing here is mocked. It FLUSHES the Redis database it runs on, so
 * it only runs when TEST_REDIS_URL is set explicitly, and that URL must name a non-default database
 * (e.g. redis://localhost:6379/14). Without it the suite is skipped and no Redis is ever touched, so pointing a shell
 * at a shared REDIS_URL cannot wipe anything. The hub's queue plumbing is switched on by stubbing `enabled` (it is off
 * under NODE_ENV=test), without touching the process environment.
 */
const URL = process.env.TEST_REDIS_URL ?? "";
const dbIndex = /\/(\d+)$/.exec(URL)?.[1];
const safe = URL !== "" && dbIndex !== undefined && dbIndex !== "0";
if (URL && !safe) throw new Error("TEST_REDIS_URL must end in a non-default database index, e.g. redis://localhost:6379/14 (the suite flushes it)");
const config = { get: (k: string) => (k === "REDIS_URL" ? URL : undefined) } as unknown as ConfigService;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(safe ? describe : describe.skip)("scheduler on a real Redis (restart safety, legacy cleanup)", () => {
  let enabledSpy: jest.SpyInstance;
  let admin: Redis;
  const booted: QueueHubService[] = [];

  /** One hub "process": its own shared connection, queue hub and tick scheduler. */
  async function bootHub() {
    const hub = new QueueHubService(config);
    booted.push(hub);
    const ticks = new TickSchedulerService(hub);
    await ticks.onApplicationBootstrap();
    return { hub, ticks, stop: () => hub.onModuleDestroy() };
  }

  beforeAll(async () => {
    enabledSpy = jest.spyOn(QueueHubService.prototype, "enabled", "get").mockReturnValue(true);
    admin = new Redis(URL);
    await admin.flushdb();
  });
  afterAll(async () => {
    for (const h of booted) await h.onModuleDestroy().catch(() => undefined);
    await admin.flushdb();
    admin.disconnect();
    enabledSpy.mockRestore();
  });
  beforeEach(async () => {
    await admin.flushdb();
  });
  afterEach(async () => {
    // a failed assertion must not leave a worker consuming the next test's jobs
    await Promise.all(booted.splice(0).map((h) => h.onModuleDestroy().catch(() => undefined)));
  });

  it("one hub keeps 1 shared socket + 1 blocking socket per worker, however many ticks it registers", async () => {
    const ours = async () => String(await admin.client("LIST")).split("\n").filter((l) => /name=(tugra:bullmq|bull:)/.test(l)).length;
    const before = await ours();
    const h = await bootHub();
    for (let i = 0; i < 15; i++) await h.ticks.register({ name: `t${i}`, every: 60_000, run: async () => undefined });
    await sleep(300);
    const after = await ours();
    expect(after - before).toBe(2); // the shared client + the scheduler worker's blocking client
    const probe = new Redis(URL, { maxRetriesPerRequest: null });
    const q = new Queue(SCHEDULER_QUEUE, { connection: probe as never });
    expect((await q.getJobSchedulers()).length).toBe(15);
    await q.close();
    probe.disconnect();
    await h.stop();
  });

  it("a hub restart (and a restart storm) neither loses nor doubles a tick: one scheduler, one pending job, normal cadence, a missed tick is caught up once", async () => {
    const EVERY = 600;
    const runs: number[] = [];
    const run = async () => void runs.push(Date.now());
    const pending = async () => ({ schedulers: await admin.zcard(`bull:${SCHEDULER_QUEUE}:repeat`), delayed: await admin.zcard(`bull:${SCHEDULER_QUEUE}:delayed`) });

    let h = await bootHub();
    await h.ticks.register({ name: "probe", every: EVERY, run });
    await sleep(2000);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    await h.stop();

    // the hub is down for several slots
    const downAt = Date.now();
    const ranWhileDown = runs.length;
    await sleep(2000);
    expect(runs.length).toBe(ranWhileDown); // nothing runs without a worker
    expect(await pending()).toEqual({ schedulers: 1, delayed: 1 }); // the missed tick is still waiting in Redis, not dropped

    // restart: same registration, same scheduler id
    h = await bootHub();
    await h.ticks.register({ name: "probe", every: EVERY, run });
    const restartAt = Date.now();
    expect(await pending()).toEqual({ schedulers: 1, delayed: 1 }); // not a second copy
    await sleep(500);
    expect(runs.filter((t) => t >= restartAt).length).toBeGreaterThanOrEqual(1); // caught up (once), not lost
    expect(runs.filter((t) => t >= restartAt && t < restartAt + 500).length).toBeLessThanOrEqual(2); // ...not a burst for every missed slot (3+ were missed)

    // restart storm
    for (let i = 0; i < 4; i++) {
      await h.stop();
      h = await bootHub();
      await h.ticks.register({ name: "probe", every: EVERY, run });
      expect(await pending()).toEqual({ schedulers: 1, delayed: 1 });
    }

    // steady state after all that: cadence is the configured one (no doubled schedule)
    const from = Date.now();
    const before = runs.length;
    await sleep(3000);
    const n = runs.length - before;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(Math.ceil(3000 / EVERY) + 1);
    expect(downAt).toBeLessThan(from);
    await h.stop();
  }, 30_000);

  it("a changed interval updates the one scheduler in place; disable() (kill switch) removes it and its pending job", async () => {
    const h = await bootHub();
    await h.ticks.register({ name: "update-check", every: 86_400_000, run: async () => undefined });
    await h.ticks.register({ name: "update-check", every: 3_600_000, run: async () => undefined });
    expect(await admin.zcard(`bull:${SCHEDULER_QUEUE}:repeat`)).toBe(1);
    expect(await admin.zcard(`bull:${SCHEDULER_QUEUE}:delayed`)).toBe(1);
    await h.ticks.disable("update-check");
    expect(await admin.zcard(`bull:${SCHEDULER_QUEUE}:repeat`)).toBe(0);
    expect(await admin.zcard(`bull:${SCHEDULER_QUEUE}:delayed`)).toBe(0);
    await h.stop();
  });

  it("one failing tick does not stop the others", async () => {
    const h = await bootHub();
    jest.spyOn((h.ticks as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    let good = 0;
    let bad = 0;
    await h.ticks.register({ name: "bad", every: 300, run: async () => { bad++; throw new Error("boom"); } });
    await h.ticks.register({ name: "good", every: 300, run: async () => void good++ });
    await sleep(1800);
    expect(bad).toBeGreaterThanOrEqual(2);
    expect(good).toBeGreaterThanOrEqual(2);
    await h.stop();
  }, 15_000);

  it("a delayed one-off job (scheduled reboot) fires at its time through the handler, once", async () => {
    const h = await bootHub();
    const seen: string[] = [];
    h.ticks.handle("reboot-due", async (job) => void seen.push((job.data as { rebootId: string }).rebootId));
    await h.ticks.enqueueAt("reboot-due", { rebootId: "r1" }, "reboot-r1", new Date(Date.now() + 600));
    await h.ticks.enqueueAt("reboot-due", { rebootId: "r1" }, "reboot-r1", new Date(Date.now() + 600)); // re-added after a restart: same id
    await sleep(1800);
    expect(seen).toEqual(["r1"]);
    await h.stop();
  }, 15_000);

  it("boot cleanup removes the previous version's repeat keys + pending jobs, carries scheduled reboots over, keeps per-entity schedules, and is idempotent", async () => {
    // Seed what the old (one queue + worker per tick) hub left in Redis.
    const conn = new Redis(URL, { maxRetriesPerRequest: null });
    const old = (name: string) => new Queue(name, { connection: conn as never });
    const seeded: Queue[] = [];
    for (const q of ["metrics-rollup", "retention-prune", "expiry", "wal-ship", "notify-digest"]) {
      const queue = old(q);
      seeded.push(queue);
      await queue.add(q, {}, { repeat: { every: 120_000 } });
    }
    const reboot = old("server-reboot");
    seeded.push(reboot);
    await reboot.add("reboot-tick", {}, { repeat: { every: 10_000 } });
    const fireAt = Date.now() + 600_000;
    await reboot.add("reboot-due", { rebootId: "rb1" }, { jobId: "reboot-rb1", delay: 600_000 });
    const cleanup = old("cleanup");
    seeded.push(cleanup);
    await cleanup.add("cleanup-threshold-sweep", {}, { repeat: { every: 300_000 } });
    await cleanup.add("cleanup:s1", { serverId: "s1" }, { repeat: { every: 86_400_000 } });
    const backups = old("backups");
    seeded.push(backups);
    await backups.add("watchdog", {}, { repeat: { every: 3_600_000 }, jobId: "watchdog" });
    await backups.add("backup:db1", { databaseId: "db1" }, { repeat: { pattern: "0 3 * * *" } });
    const vol = old("volume-backups");
    seeded.push(vol);
    await vol.add("watchdog", {}, { repeat: { every: 3_600_000 }, jobId: "watchdog" });
    const monitors = old("monitors");
    seeded.push(monitors);
    await monitors.add("check:m1", { monitorId: "m1" }, { repeat: { every: 30_000 } });
    for (const q of seeded) await q.close();

    const h = await bootHub(); // the boot hook runs the cleanup
    const r = await h.ticks.legacyCleanupDone();
    expect(r?.retiredQueues.sort()).toEqual(["expiry", "metrics-rollup", "notify-digest", "retention-prune", "server-reboot", "wal-ship"]);
    expect(r?.movedJobs).toBe(1);
    expect(r?.removedRepeatables).toBe(5 + 1 /* reboot-tick */ + 1 /* cleanup sweep */ + 1 /* backups watchdog */ + 1 /* volume watchdog */);

    // retired queues are gone from Redis entirely
    for (const q of RETIRED_QUEUES) expect(await admin.keys(`bull:${q}:*`)).toEqual([]);
    // the scheduled reboot was carried over to the shared queue with the same id and (about) the same fire time
    const sConn = new Redis(URL, { maxRetriesPerRequest: null });
    const s = new Queue(SCHEDULER_QUEUE, { connection: sConn as never });
    const moved = await s.getJob("reboot-rb1");
    expect(moved?.name).toBe("reboot-due");
    expect(moved?.data).toEqual({ rebootId: "rb1" });
    expect(Math.abs(moved!.timestamp + (moved!.opts.delay ?? 0) - fireAt)).toBeLessThan(10_000);
    // moved global ticks left their old queues; per-entity schedules stayed
    const names = async (q: string) => {
      const x = old(q);
      const r = (await x.getRepeatableJobs()).map((j) => j.name).sort();
      await x.close();
      return r;
    };
    expect(await names("cleanup")).toEqual(["cleanup:s1"]);
    expect(await names("backups")).toEqual(["backup:db1"]);
    expect(await names("volume-backups")).toEqual([]);
    expect(await names("monitors")).toEqual(["check:m1"]);
    // running it again finds nothing to do
    expect(await retireLegacyQueues(h.hub, h.ticks)).toEqual({ retiredQueues: [], removedRepeatables: 0, movedJobs: 0 });
    await s.close();
    sConn.disconnect();
    await h.stop();
    conn.disconnect();
  }, 30_000);
});
