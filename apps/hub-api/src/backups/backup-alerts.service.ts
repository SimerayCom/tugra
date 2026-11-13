import { Injectable, Logger } from "@nestjs/common";
import { RestoreKind } from "@prisma/client";
import { parseExpression } from "cron-parser";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { NotificationsService } from "../notifications/notifications.service";

/** Which backup family an alert is about. Database backups, app-volume backups, the restore-verify drill and
 *  the physical base backup all share one state machine (the Redis keys namespace on the kind, so one kind's
 *  failure/throttle state can never collide with another's). */
export type BackupKind = "database" | "volume" | "verify" | "basebackup" | "walship";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Failure state/throttle TTL: long enough to span any realistic failing streak (refreshed on every alert). */
const FAIL_TTL_SEC = 30 * 86_400;
/** `backup_missing` is re-armed after this long even without a recovery (a monthly reminder, not a spam loop). */
const MISSING_TTL_SEC = 30 * 86_400;
/** A schedule is "missing" when no SUCCESS backup exists within WINDOW_FACTOR × its interval. */
export const MISSING_WINDOW_FACTOR = 2;
/** Floor so a 1-hour schedule isn't flagged by a single slow run. */
const MIN_WINDOW_MS = 2 * HOUR_MS;
/** How many upcoming cron fires to sample when estimating a cron schedule's longest gap. */
const CRON_SAMPLES = 12;

const failKey = (kind: BackupKind, id: string) => `backupalert:fail:${kind}:${id}`;
const missingKey = (kind: BackupKind, id: string) => `backupalert:missing:${kind}:${id}`;
const watchKey = (kind: BackupKind, id: string) => `backupalert:watch:${kind}:${id}`;

/**
 * Longest expected gap between two runs of a cron expression, in ms (sampled over the next CRON_SAMPLES
 * fires so "weekdays only" yields the 3-day weekend gap, not 1 day). null for an unparsable expression.
 */
export function cronMaxGapMs(cron: string, from: Date = new Date()): number | null {
  try {
    const it = parseExpression(cron, { currentDate: from });
    let prev = from.getTime();
    let max = 0;
    for (let i = 0; i < CRON_SAMPLES; i++) {
      const next = it.next().toDate().getTime();
      max = Math.max(max, next - prev);
      prev = next;
    }
    return max > 0 ? max : null;
  } catch {
    return null;
  }
}

/** The watchdog window for a schedule: 2× its (max) interval, never below MIN_WINDOW_MS. */
export function missingWindowMs(opts: { intervalHours?: number | null; cron?: string | null }, now: Date = new Date()): number | null {
  let interval: number | null = null;
  if (opts.cron) interval = cronMaxGapMs(opts.cron, now);
  if (interval == null && opts.intervalHours && opts.intervalHours > 0) interval = opts.intervalHours * HOUR_MS;
  if (interval == null) return null;
  return Math.max(interval * MISSING_WINDOW_FACTOR, MIN_WINDOW_MS);
}

/**
 * Backup alert state machine shared by database and volume backups. Three jobs:
 *
 *  1. FAILURE THROTTLE — {@link shouldNotifyFailure}: notify on the FIRST failure, then at most once per
 *     24h while it keeps failing (the last-alert time is the state), never on every scheduled run.
 *  2. RECOVERY — {@link recover}: the first SUCCESS after a notified failure and/or a `backup_missing`
 *     alert clears the state and fires ONE `backup_recovered`.
 *  3. MISSING-BACKUP WATCHDOG — {@link checkDatabases}/{@link checkApps}: for every resource with backups
 *     ENABLED and no SUCCESS inside its window, fire `backup_missing` ONCE (state-deduped, re-armed only by
 *     a success), catching a schedule that silently stopped producing runs at all.
 *
 * State lives in Redis (like the notification dedupe). Failure paths are FAIL-OPEN (a Redis hiccup sends the
 * alert rather than dropping it); the watchdog is FAIL-CLOSED (a hiccup skips this tick — it re-checks next
 * hour — rather than risking an alert on every tick).
 */
@Injectable()
export class BackupAlertsService {
  private readonly logger = new Logger(BackupAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  /** True when `backup_failed` should be sent now: first failure, or ≥24h since the last alert. Records the alert. */
  async shouldNotifyFailure(kind: BackupKind, id: string, now: number = Date.now()): Promise<boolean> {
    const key = failKey(kind, id);
    try {
      const v = await this.redis.get(key);
      const last = v ? Number(v) : NaN;
      if (Number.isFinite(last) && now - last < DAY_MS) return false;
      await this.redis.set(key, String(now), FAIL_TTL_SEC);
      return true;
    } catch {
      return true; // fail-open: never drop a failure alert because Redis hiccuped
    }
  }

  /**
   * A run succeeded. If this resource was in a notified-failed and/or missing state, clear it and fire one
   * `backup_recovered` (ctx = the caller's resource ctx + `reason`). A healthy run (no prior state) is silent.
   */
  async recover(kind: BackupKind, id: string, teamId: string, ctx: Record<string, unknown>): Promise<boolean> {
    let failed = false;
    let missing = false;
    try {
      failed = (await this.redis.get(failKey(kind, id))) != null;
      missing = (await this.redis.get(missingKey(kind, id))) != null;
      if (failed || missing) await this.redis.del(failKey(kind, id), missingKey(kind, id));
    } catch {
      return false; // can't read state → stay silent (a missed recovery beats a false one)
    }
    if (!failed && !missing) return false;
    // The verify drill has its own recovery event; database + volume share backup_recovered.
    const event = kind === "verify" ? "verify_recovered" : "backup_recovered";
    await this.notifications
      .fireForEvent(teamId, event, { ...ctx, kind, reason: missing ? "missing" : "failed" })
      .catch(() => undefined);
    return true;
  }

  /** Watchdog for database backups. Returns how many `backup_missing` alerts were fired. */
  async checkDatabases(now: Date = new Date()): Promise<number> {
    const dbs = await this.prisma.database.findMany({
      where: { backupEnabled: true, OR: [{ backupIntervalHours: { not: null } }, { backupCron: { not: null } }] },
      select: { id: true, name: true, teamId: true, engine: true, version: true, backupIntervalHours: true, backupCron: true },
    });
    let fired = 0;
    for (const d of dbs) {
      const window = missingWindowMs({ intervalHours: d.backupIntervalHours, cron: d.backupCron }, now);
      if (window == null) continue;
      const lastOk = await this.prisma.backup.findFirst({
        where: { databaseId: d.id, status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, completedAt: true },
      });
      const first = lastOk
        ? null
        : await this.prisma.backup.findFirst({ where: { databaseId: d.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
      const ref = await this.referenceTime("database", d.id, lastOk, first, now);
      if (ref == null || now.getTime() - ref.getTime() <= window) continue;
      if (!(await this.claimMissing("database", d.id))) continue;
      await this.notifications
        .fireForEvent(d.teamId, "backup_missing", {
          kind: "database",
          dbId: d.id,
          dbName: d.name,
          engine: d.engine,
          version: d.version,
          lastSuccessAt: lastOk ? (lastOk.completedAt ?? lastOk.createdAt).toISOString() : "",
          windowHours: String(Math.round(window / HOUR_MS)),
        })
        .catch(() => undefined);
      fired++;
    }
    if (fired) this.logger.warn(`backup watchdog: ${fired} database(s) with no recent successful backup`);
    return fired;
  }

  /** Watchdog for app volume backups (one alert per app, not per volume). Returns the fired count. */
  async checkApps(now: Date = new Date()): Promise<number> {
    const apps = await this.prisma.application.findMany({
      where: { volumeBackupEnabled: true, volumeBackupIntervalHours: { not: null } },
      select: { id: true, name: true, teamId: true, volumes: true, volumeBackupIntervalHours: true },
    });
    let fired = 0;
    for (const a of apps) {
      // An app with no declared volumes has nothing to back up, so a missing backup is not an anomaly.
      if (!Array.isArray(a.volumes) || a.volumes.length === 0) continue;
      const window = missingWindowMs({ intervalHours: a.volumeBackupIntervalHours }, now);
      if (window == null) continue;
      const lastOk = await this.prisma.volumeBackup.findFirst({
        where: { appId: a.id, status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, completedAt: true },
      });
      const first = lastOk
        ? null
        : await this.prisma.volumeBackup.findFirst({ where: { appId: a.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
      const ref = await this.referenceTime("volume", a.id, lastOk, first, now);
      if (ref == null || now.getTime() - ref.getTime() <= window) continue;
      if (!(await this.claimMissing("volume", a.id))) continue;
      await this.notifications
        .fireForEvent(a.teamId, "backup_missing", {
          kind: "volume",
          appId: a.id,
          appName: a.name,
          lastSuccessAt: lastOk ? (lastOk.completedAt ?? lastOk.createdAt).toISOString() : "",
          windowHours: String(Math.round(window / HOUR_MS)),
        })
        .catch(() => undefined);
      fired++;
    }
    if (fired) this.logger.warn(`backup watchdog: ${fired} app(s) with no recent successful volume backup`);
    return fired;
  }

  /**
   * Watchdog for the scheduled restore-verify drill: for every verify-enabled database whose last VERIFY
   * attempt (any status) is older than its window, fire `verify_missing` ONCE — catching a drill that silently
   * stopped running. Deliberately anchored on the latest ATTEMPT, not the last SUCCESS: a drill that RAN and
   * found the backup bad already fired backup_restore_failed, so anchoring on success would double-alert.
   * Returns how many alerts were fired.
   */
  async checkVerifyLiveness(now: Date = new Date()): Promise<number> {
    const dbs = await this.prisma.database.findMany({
      where: { verifyEnabled: true, OR: [{ verifyIntervalHours: { not: null } }, { verifyCron: { not: null } }] },
      select: { id: true, name: true, teamId: true, engine: true, version: true, verifyIntervalHours: true, verifyCron: true, lastVerifiedAt: true },
    });
    let fired = 0;
    for (const d of dbs) {
      const window = missingWindowMs({ intervalHours: d.verifyIntervalHours, cron: d.verifyCron }, now);
      if (window == null) continue;
      const lastAttempt = await this.prisma.restore.findFirst({
        where: { databaseId: d.id, kind: RestoreKind.VERIFY },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, completedAt: true },
      });
      // referenceTime: latest attempt → its time; none ever → first-seen watch marker (skip the first tick so
      // enabling verify on an old db does not alert instantly).
      const ref = await this.referenceTime("verify", d.id, lastAttempt, null, now);
      if (ref == null || now.getTime() - ref.getTime() <= window) continue;
      if (!(await this.claimMissing("verify", d.id))) continue;
      await this.notifications
        .fireForEvent(d.teamId, "verify_missing", {
          kind: "verify",
          dbId: d.id,
          dbName: d.name,
          engine: d.engine,
          version: d.version,
          lastVerifiedAt: d.lastVerifiedAt ? d.lastVerifiedAt.toISOString() : "",
          windowHours: String(Math.round(window / HOUR_MS)),
        })
        .catch(() => undefined);
      fired++;
    }
    if (fired) this.logger.warn(`verify watchdog: ${fired} database(s) with no recent restore-verify drill`);
    return fired;
  }

  /**
   * The moment the window is measured from: the latest SUCCESS; else the oldest run of any status (a schedule
   * that only ever failed has been "without a good backup" since its first attempt); else — nothing has ever
   * run — the first time the watchdog SAW this resource (so enabling backups on an old resource does not alert
   * instantly). null = just stamped the first-seen marker (or Redis unavailable) → skip this tick.
   */
  private async referenceTime(
    kind: BackupKind,
    id: string,
    lastOk: { createdAt: Date; completedAt: Date | null } | null,
    firstRow: { createdAt: Date } | null,
    now: Date,
  ): Promise<Date | null> {
    let ref: Date | null = null;
    if (lastOk) ref = lastOk.completedAt ?? lastOk.createdAt;
    else if (firstRow) ref = firstRow.createdAt;
    try {
      const v = await this.redis.get(watchKey(kind, id));
      const watchFrom = v ? Number(v) : NaN;
      if (Number.isFinite(watchFrom)) {
        // The window never starts before the last (re)enable / schedule change ({@link onScheduleChanged}),
        // so re-enabling after a long pause (or shortening the interval) does not fire a stale backup_missing.
        if (ref == null || watchFrom > ref.getTime()) ref = new Date(watchFrom);
      } else if (ref == null) {
        // Nothing has ever run and no marker yet → stamp now and skip this tick (don't alert instantly).
        await this.redis.set(watchKey(kind, id), String(now.getTime()));
      }
    } catch {
      if (ref == null) return null; // fail-closed only when we have no other reference
    }
    return ref;
  }

  /** Re-arm when a backup schedule is created/enabled/changed: stamp the watch window from NOW and clear any
   *  stale failed/missing state, so a re-enable or interval change never fires a stale backup_missing and never
   *  leaves an un-cleared alert owed. Best-effort (a Redis error just leaves the prior state). */
  async onScheduleChanged(kind: BackupKind, id: string, now: Date = new Date()): Promise<void> {
    try {
      await this.redis.set(watchKey(kind, id), String(now.getTime()));
      await this.redis.del(failKey(kind, id), missingKey(kind, id));
    } catch {
      /* best-effort */
    }
  }

  /** Atomically claim the right to fire `backup_missing` (true only the first time until a success clears it). */
  private async claimMissing(kind: BackupKind, id: string): Promise<boolean> {
    return this.redis.firstInWindow(missingKey(kind, id), MISSING_TTL_SEC).catch(() => false);
  }
}
