import { Logger } from "@nestjs/common";
import { BackupAlertsService, cronMaxGapMs, missingWindowMs } from "./backup-alerts.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { NotificationsService } from "../notifications/notifications.service";

beforeAll(() => void jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));

const H = 3_600_000;
const DAY = 24 * H;

/** In-memory RedisService stand-in (TTL ignored; firstInWindow = SET NX). */
function fakeRedis() {
  const m = new Map<string, string>();
  return {
    m,
    get: jest.fn(async (k: string) => m.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => void m.set(k, v)),
    del: jest.fn(async (...ks: string[]) => void ks.forEach((k) => m.delete(k))),
    firstInWindow: jest.fn(async (k: string) => {
      if (m.has(k)) return false;
      m.set(k, "1");
      return true;
    }),
  };
}

function make(opts: { dbs?: unknown[]; apps?: unknown[]; lastOk?: unknown; firstRow?: unknown } = {}) {
  const redis = fakeRedis();
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const findFirst = jest.fn(async (args: { where: { status?: string }; orderBy: { createdAt: string } }) =>
    args.where.status === "SUCCESS" ? (opts.lastOk ?? null) : (opts.firstRow ?? null),
  );
  const prisma = {
    database: { findMany: jest.fn().mockResolvedValue(opts.dbs ?? []) },
    application: { findMany: jest.fn().mockResolvedValue(opts.apps ?? []) },
    backup: { findFirst },
    volumeBackup: { findFirst },
  } as unknown as PrismaService;
  const svc = new BackupAlertsService(prisma, redis as unknown as RedisService, { fireForEvent } as unknown as NotificationsService);
  return { svc, redis, fireForEvent, prisma, findFirst };
}

const dbRow = { id: "db1", name: "shop", teamId: "t1", engine: "POSTGRES", version: "16", backupIntervalHours: 24, backupCron: null };
const now = new Date("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("missing-window math", () => {
  it("is 2x the interval, floored at 2h", () => {
    expect(missingWindowMs({ intervalHours: 24 })).toBe(48 * H);
    expect(missingWindowMs({ intervalHours: 1 })).toBe(2 * H);
    expect(missingWindowMs({})).toBeNull();
  });
  it("a cron uses its LONGEST gap (weekday-only cron spans the weekend)", () => {
    const gap = cronMaxGapMs("0 3 * * 1-5", new Date("2026-11-02T00:00:00Z"))!;
    expect(gap).toBe(3 * DAY);
    expect(missingWindowMs({ cron: "0 3 * * 1-5" }, new Date("2026-11-02T00:00:00Z"))).toBe(6 * DAY);
    // a bad cron falls back to the interval
    expect(missingWindowMs({ cron: "nope", intervalHours: 6 })).toBe(12 * H);
  });
});

describe("BackupAlertsService.shouldNotifyFailure — first / daily / recovery throttle", () => {
  it("notifies the first failure, suppresses repeats within 24h, notifies again after 24h", async () => {
    const { svc } = make();
    const t0 = 1_000_000_000_000;
    expect(await svc.shouldNotifyFailure("database", "db1", t0)).toBe(true); // first
    expect(await svc.shouldNotifyFailure("database", "db1", t0 + 1 * H)).toBe(false);
    expect(await svc.shouldNotifyFailure("database", "db1", t0 + 23 * H)).toBe(false); // no spam
    expect(await svc.shouldNotifyFailure("database", "db1", t0 + 25 * H)).toBe(true); // daily reminder
    expect(await svc.shouldNotifyFailure("database", "db1", t0 + 26 * H)).toBe(false); // window restarted
  });

  it("is per resource and per kind", async () => {
    const { svc } = make();
    expect(await svc.shouldNotifyFailure("database", "x")).toBe(true);
    expect(await svc.shouldNotifyFailure("database", "y")).toBe(true);
    expect(await svc.shouldNotifyFailure("volume", "x")).toBe(true);
    expect(await svc.shouldNotifyFailure("database", "x")).toBe(false);
  });

  it("a success resets it: recovery fires ONCE, and the next failure is a fresh 'first failure'", async () => {
    const { svc, fireForEvent } = make();
    expect(await svc.shouldNotifyFailure("database", "db1")).toBe(true);
    expect(await svc.shouldNotifyFailure("database", "db1")).toBe(false);
    expect(await svc.recover("database", "db1", "t1", { dbId: "db1", dbName: "shop" })).toBe(true);
    expect(fireForEvent).toHaveBeenCalledTimes(1);
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_recovered", expect.objectContaining({ dbId: "db1", kind: "database", reason: "failed" }));
    // healthy run afterwards: silent (no second recovery)
    expect(await svc.recover("database", "db1", "t1", { dbId: "db1" })).toBe(false);
    expect(fireForEvent).toHaveBeenCalledTimes(1);
    expect(await svc.shouldNotifyFailure("database", "db1")).toBe(true); // first failure again
  });

  it("fails OPEN: a Redis error still sends the failure alert", async () => {
    const { svc, redis } = make();
    redis.get.mockRejectedValueOnce(new Error("redis down"));
    expect(await svc.shouldNotifyFailure("database", "db1")).toBe(true);
  });

  it("a healthy run with no prior state never fires a recovery", async () => {
    const { svc, fireForEvent } = make();
    expect(await svc.recover("volume", "app1", "t1", { appId: "app1" })).toBe(false);
    expect(fireForEvent).not.toHaveBeenCalled();
  });
});

describe("BackupAlertsService.checkDatabases — missing-backup watchdog", () => {
  it("only inspects backup-ENABLED databases that have an interval or cron", async () => {
    const { svc, prisma } = make({ dbs: [] });
    await svc.checkDatabases(now);
    expect((prisma.database.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      backupEnabled: true,
      OR: [{ backupIntervalHours: { not: null } }, { backupCron: { not: null } }],
    });
  });

  it("fires backup_missing ONCE when the newest SUCCESS is older than 2x the interval, not on later ticks", async () => {
    const { svc, fireForEvent } = make({ dbs: [dbRow], lastOk: { createdAt: ago(60 * H), completedAt: ago(60 * H) } });
    expect(await svc.checkDatabases(now)).toBe(1);
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "backup_missing",
      expect.objectContaining({ kind: "database", dbId: "db1", dbName: "shop", windowHours: "48", lastSuccessAt: ago(60 * H).toISOString() }),
    );
    expect(await svc.checkDatabases(new Date(now.getTime() + H))).toBe(0); // deduped — no re-fire per tick
    expect(await svc.checkDatabases(new Date(now.getTime() + 5 * H))).toBe(0);
    expect(fireForEvent).toHaveBeenCalledTimes(1);
  });

  it("onScheduleChanged re-arms from NOW: a stale old SUCCESS does NOT fire backup_missing after a re-enable / interval change", async () => {
    const { svc, fireForEvent } = make({ dbs: [dbRow], lastOk: { createdAt: ago(60 * H), completedAt: ago(60 * H) } });
    await svc.onScheduleChanged("database", "db1", now); // stamps watch-from = now, clears stale state
    expect(await svc.checkDatabases(now)).toBe(0); // window measured from the re-enable, not the 60h-old success
    expect(fireForEvent).not.toHaveBeenCalled();
    // once the NEW window elapses with still no success, it fires again
    expect(await svc.checkDatabases(new Date(now.getTime() + 49 * H))).toBe(1);
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_missing", expect.objectContaining({ dbId: "db1" }));
  });

  it("does NOT fire when a SUCCESS is inside the window", async () => {
    const { svc, fireForEvent } = make({ dbs: [dbRow], lastOk: { createdAt: ago(47 * H), completedAt: ago(47 * H) } });
    expect(await svc.checkDatabases(now)).toBe(0);
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("recovery: the next success after a missing alert fires ONE backup_recovered(reason=missing) and re-arms the watchdog", async () => {
    const { svc, fireForEvent, findFirst } = make({ dbs: [dbRow], lastOk: { createdAt: ago(60 * H), completedAt: ago(60 * H) } });
    await svc.checkDatabases(now); // backup_missing
    expect(await svc.recover("database", "db1", "t1", { dbId: "db1", dbName: "shop" })).toBe(true);
    expect(fireForEvent).toHaveBeenLastCalledWith("t1", "backup_recovered", expect.objectContaining({ reason: "missing" }));
    expect(await svc.recover("database", "db1", "t1", { dbId: "db1" })).toBe(false); // once
    // stale again later → a NEW missing alert (the watchdog was re-armed by the success)
    findFirst.mockImplementation(async (a: { where: { status?: string } }) =>
      a.where.status === "SUCCESS" ? { createdAt: ago(100 * H), completedAt: ago(100 * H) } : null,
    );
    expect(await svc.checkDatabases(now)).toBe(1);
    expect(fireForEvent.mock.calls.filter((c) => c[1] === "backup_missing")).toHaveLength(2);
  });

  it("a schedule that only ever FAILED is measured from its first attempt", async () => {
    const { svc, fireForEvent } = make({ dbs: [dbRow], lastOk: null, firstRow: { createdAt: ago(5 * DAY) } });
    expect(await svc.checkDatabases(now)).toBe(1);
    expect(fireForEvent.mock.calls[0][2]).toEqual(expect.objectContaining({ lastSuccessAt: "" }));
  });

  it("no run has ever happened: stamps a first-seen marker (no instant alert), then fires once the window passes", async () => {
    const { svc, fireForEvent } = make({ dbs: [dbRow] });
    expect(await svc.checkDatabases(now)).toBe(0); // marker stamped now
    expect(await svc.checkDatabases(new Date(now.getTime() + 47 * H))).toBe(0);
    expect(await svc.checkDatabases(new Date(now.getTime() + 49 * H))).toBe(1);
    expect(fireForEvent).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED: a Redis error on the claim skips the alert instead of risking one per tick", async () => {
    const { svc, redis, fireForEvent } = make({ dbs: [dbRow], lastOk: { createdAt: ago(60 * H), completedAt: ago(60 * H) } });
    redis.firstInWindow.mockRejectedValue(new Error("redis down"));
    expect(await svc.checkDatabases(now)).toBe(0);
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("skips a schedule whose interval/cron cannot be resolved", async () => {
    const { svc, fireForEvent } = make({ dbs: [{ ...dbRow, backupIntervalHours: null, backupCron: "bad cron" }], lastOk: null, firstRow: { createdAt: ago(9 * DAY) } });
    expect(await svc.checkDatabases(now)).toBe(0);
    expect(fireForEvent).not.toHaveBeenCalled();
  });
});

describe("BackupAlertsService.checkApps — volume watchdog", () => {
  const appRow = { id: "app1", name: "blog", teamId: "t1", volumes: [{ name: "data" }], volumeBackupIntervalHours: 12 };

  it("fires backup_missing (kind=volume) once for a stale app, with appId/appName", async () => {
    const { svc, fireForEvent } = make({ apps: [appRow], lastOk: { createdAt: ago(30 * H), completedAt: null } });
    expect(await svc.checkApps(now)).toBe(1);
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_missing", expect.objectContaining({ kind: "volume", appId: "app1", appName: "blog", windowHours: "24" }));
    expect(await svc.checkApps(now)).toBe(0);
  });

  it("ignores an app with no declared volumes", async () => {
    const { svc, fireForEvent } = make({ apps: [{ ...appRow, volumes: [] }], lastOk: null, firstRow: { createdAt: ago(9 * DAY) } });
    expect(await svc.checkApps(now)).toBe(0);
    expect(fireForEvent).not.toHaveBeenCalled();
  });

  it("a volume success after the missing alert recovers with reason=missing", async () => {
    const { svc, fireForEvent } = make({ apps: [appRow], lastOk: { createdAt: ago(30 * H), completedAt: null } });
    await svc.checkApps(now);
    await svc.recover("volume", "app1", "t1", { appId: "app1", appName: "blog" });
    expect(fireForEvent).toHaveBeenLastCalledWith("t1", "backup_recovered", expect.objectContaining({ kind: "volume", reason: "missing", appId: "app1" }));
  });
});

describe("BackupAlertsService — restore-verify watchdog + recovery", () => {
  function makeVerify(opts: { dbs?: unknown[]; lastAttempt?: unknown } = {}) {
    const redis = fakeRedis();
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      database: { findMany: jest.fn().mockResolvedValue(opts.dbs ?? []) },
      restore: { findFirst: jest.fn().mockResolvedValue(opts.lastAttempt ?? null) },
    } as unknown as PrismaService;
    const svc = new BackupAlertsService(prisma, redis as unknown as RedisService, { fireForEvent } as unknown as NotificationsService);
    return { svc, redis, fireForEvent };
  }
  const vdb = { id: "db1", name: "shop", teamId: "t1", engine: "POSTGRES", version: "16", verifyIntervalHours: 24, verifyCron: null, lastVerifiedAt: null };

  it("fires verify_missing ONCE when the last drill is older than the window (then dedupes)", async () => {
    const t = makeVerify({ dbs: [vdb], lastAttempt: { createdAt: ago(100 * H), completedAt: ago(100 * H) } });
    expect(await t.svc.checkVerifyLiveness(now)).toBe(1);
    expect(t.fireForEvent).toHaveBeenCalledWith("t1", "verify_missing", expect.objectContaining({ dbId: "db1", kind: "verify", windowHours: "48" }));
    // Re-arm is a success's job; a second tick with the same state must not re-fire.
    expect(await t.svc.checkVerifyLiveness(now)).toBe(0);
    expect(t.fireForEvent).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a drill RAN within the window", async () => {
    const t = makeVerify({ dbs: [vdb], lastAttempt: { createdAt: ago(1 * H), completedAt: ago(1 * H) } });
    expect(await t.svc.checkVerifyLiveness(now)).toBe(0);
    expect(t.fireForEvent).not.toHaveBeenCalled();
  });

  it("a never-verified db skips the first tick (stamps the first-seen marker, no instant alert)", async () => {
    const t = makeVerify({ dbs: [vdb], lastAttempt: null });
    expect(await t.svc.checkVerifyLiveness(now)).toBe(0);
    expect(t.fireForEvent).not.toHaveBeenCalled();
    expect(t.redis.m.has("backupalert:watch:verify:db1")).toBe(true);
  });

  it("recover('verify') fires verify_recovered (not backup_recovered) after a missing alert", async () => {
    const t = makeVerify();
    t.redis.m.set("backupalert:missing:verify:db1", "1");
    const out = await t.svc.recover("verify", "db1", "t1", { dbId: "db1", dbName: "shop", engine: "POSTGRES", version: "16" });
    expect(out).toBe(true);
    expect(t.fireForEvent).toHaveBeenCalledWith("t1", "verify_recovered", expect.objectContaining({ kind: "verify", reason: "missing" }));
    expect(t.fireForEvent).not.toHaveBeenCalledWith("t1", "backup_recovered", expect.anything());
  });

  it("recover('verify') fires verify_recovered after a FAILED drill (the fail-state the runner arms)", async () => {
    const t = makeVerify();
    t.redis.m.set("backupalert:fail:verify:db1", String(Date.now())); // runner.verifyBackup arms this on a FAILED attestation
    const out = await t.svc.recover("verify", "db1", "t1", { dbId: "db1", dbName: "shop" });
    expect(out).toBe(true);
    expect(t.fireForEvent).toHaveBeenCalledWith("t1", "verify_recovered", expect.objectContaining({ kind: "verify", reason: "failed" }));
  });
});
