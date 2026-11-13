import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { BaseBackup, Database, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { type DbEngine } from "../databases/database-script";
import { BackupRunnerService, parseSize } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { baseBackupFilename, baseNs, buildBaseBackupScript, parseBaseMeta, SUPPORTED_WAL_SEGMENT_SIZE } from "./base-backup-script";
import { backupPath, buildDeleteBackupScript, scrubRunOutput } from "./backup-script";
import { objectKey, type DestinationSpec } from "./destination";
import { PitrClaimsService } from "./pitr-claims.service";
import {
  buildWalDeleteScript,
  buildWalObjectListScript,
  parseWalDeleted,
  parseWalObjects,
  walGcCandidates,
  walSegmentName,
  type WalObject,
} from "./pitr-restore-script";

const BASE_BACKUP_TIMEOUT_MS = 3_600_000; // a full-cluster physical copy can be large/slow
const FAILED_HISTORY_CAP = 20; // keep the table bounded (FAILED rows are never pruned by retention)
/** Newest SUCCESS bases kept per database. The WAL chain is reclaimed only BEHIND the oldest kept base. */
export const BASE_RETENTION = 3;
/** WAL GC bounds: objects deleted per agent command (one marker line each, well under the 64KB output cap) and a
 *  wall-clock budget per prune run (a huge backlog is drained across runs, never in one multi-hour pass — the
 *  prune runs inline at the end of a base backup, including the synchronous "base backup now" request). */
export const WAL_GC_BATCH = 200;
export const WAL_GC_BUDGET_MS = 5 * 60_000;
/** Pages listed before GC gives up for this run. The listing is name-sorted and stops at the cutoff, so this only
 *  bites when the reclaimable backlog itself exceeds 64 × 400 objects (400 GiB) — drained over later runs. */
export const WAL_GC_LIST_PAGES = 64;
const WAL_GC_LIST_TIMEOUT_MS = 120_000;
const WAL_GC_DELETE_TIMEOUT_MS = 300_000;
/** A RUNNING point-in-time replay older than this is a hub-restart orphan (the PITR sweep resolves it) and must
 *  never block retention forever; a real replay is bounded well below it. */
const REPLAY_GUARD_MS = 14 * 3_600_000;

/**
 * Runs a PHYSICAL base backup (pg_basebackup) of a managed Postgres database and records it in BaseBackup.
 * Mirrors BackupRunnerService.runBackup / HubBackupRunnerService.runBackup but for the sibling physical-base
 * family. It NEVER touches prisma.backup, so the logical backup / verify / prune / watchdog paths are
 * byte-identical. Injects BackupRunnerService (for destinationSpecById/toSpec, and parseSize) — never the
 * reverse — so the DI graph stays acyclic.
 */
@Injectable()
export class BaseBackupRunnerService {
  private readonly logger = new Logger(BaseBackupRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
    private readonly runner: BackupRunnerService,
    private readonly alerts: BackupAlertsService,
    private readonly claims: PitrClaimsService,
  ) {}

  /** Overridable clock (specs pin the GC budget without real time). */
  private now(): number {
    return Date.now();
  }

  /**
   * Scheduler tick (`base:<id>`). Re-checks the stored switches — a stale repeatable after a disable, or a
   * database whose PITR is no longer ACTIVE (the schedule is owned by PITR), must not run a full-cluster copy —
   * and never throws: an offline server / failed run is already recorded + alerted by runBaseBackup, and a
   * throwing tick would only make BullMQ retry a heavy job.
   */
  async runBaseBackupScheduled(databaseId: string): Promise<void> {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: { baseBackupEnabled: true, engine: true, pitrEnabled: true, pitrEnabledAt: true, status: true },
    });
    if (!db || !db.baseBackupEnabled || (db.engine as DbEngine) !== "POSTGRES") return;
    if (!db.pitrEnabled || !db.pitrEnabledAt || db.status !== "RUNNING") return;
    try {
      await this.runBaseBackup(databaseId, "scheduler");
    } catch (e) {
      this.logger.warn(`scheduled base backup for database ${databaseId} did not run: ${e instanceof Error ? e.message : e}`);
    }
  }

  async runBaseBackup(databaseId: string, actor = "scheduler"): Promise<BaseBackup> {
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db) throw new Error("database not found");
    if ((db.engine as DbEngine) !== "POSTGRES") {
      throw new ConflictException("physical base backups are supported only for Postgres");
    }

    // Reap stale RUNNING rows (a base in flight during a hub crash otherwise stays RUNNING forever), then a
    // one-at-a-time guard: a base is heavy (full-cluster checkpoint + IO), so never start a second in parallel.
    await this.prisma.baseBackup.updateMany({
      where: { databaseId, status: "RUNNING", createdAt: { lt: new Date(Date.now() - 2 * BASE_BACKUP_TIMEOUT_MS) } },
      data: { status: "FAILED", errorTail: "interrupted by a hub restart", completedAt: new Date() },
    });
    const inflight = await this.prisma.baseBackup.findFirst({ where: { databaseId, status: "RUNNING" } });
    if (inflight) return inflight;

    const dest = await this.runner.destinationSpecById(db.backupDestinationId);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = baseBackupFilename(ts, dest);
    const ns = baseNs(db.id);
    const key = dest.type === "S3" && dest.s3 ? objectKey(dest.s3, ns, filename) : null;

    let row: BaseBackup;
    try {
      row = await this.prisma.baseBackup.create({
        data: {
          databaseId: db.id,
          status: "RUNNING",
          filename,
          path: backupPath(ns, filename),
          destinationId: db.backupDestinationId,
          objectKey: key,
          pgVersion: db.version,
          createdBy: actor,
        },
      });
    } catch (e) {
      // Lost the create race: the partial unique index (one RUNNING per db) rejected a concurrent second
      // start. Return the winner instead of launching a parallel (heavy) base — the atomic half of the guard.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const winner = await this.prisma.baseBackup.findFirst({ where: { databaseId, status: "RUNNING" } });
        if (winner) return winner;
      }
      throw e;
    }

    // Everything the run was handed that must never reach the persisted/notified output.
    let dbPassword: string | undefined;
    try {
      dbPassword = this.runner.toSpec(db).credentials.password;
    } catch {
      /* undecryptable creds → the backup below fails and is recorded; nothing to redact */
    }
    const secrets = [dbPassword, dest.s3?.accessKey, dest.s3?.secretKey, dest.encryption?.key];
    const startedAt = Date.now();
    let succeeded = false;
    let errorText = "";
    let exitCode: number | null = null;
    let sizeBytes: bigint | null = null;
    let meta: { startLsn: string | null; timeline: number | null; walSegmentSize: string | null } = { startLsn: null, timeline: null, walSegmentSize: null };
    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        buildBaseBackupScript(this.runner.toSpec(db), filename, dest, ts),
        "backup",
        BASE_BACKUP_TIMEOUT_MS,
      );
      succeeded = r.exitCode === 0;
      exitCode = r.exitCode;
      if (!succeeded) errorText = r.output;
      sizeBytes = succeeded ? parseSize(r.output) : null;
      meta = parseBaseMeta(r.output);
      // The anchor (start LSN → segment name) is only trusted for the default segment size: the window, the
      // replay seed and the WAL retention cutoff all derive segment names from it. Anything else (or an unknown
      // size from an older agent script) keeps the base as a plain physical snapshot with no anchor — never a
      // wrong one that could mis-place the retention cutoff.
      if (succeeded && meta.walSegmentSize !== SUPPORTED_WAL_SEGMENT_SIZE && (meta.startLsn || meta.timeline != null)) {
        this.logger.warn(`base backup for database ${db.id}: wal_segment_size ${meta.walSegmentSize ?? "unknown"} is not ${SUPPORTED_WAL_SEGMENT_SIZE}; recorded without a PITR anchor`);
        meta = { ...meta, startLsn: null, timeline: null };
      }
      const completedAt = new Date();
      await this.prisma.baseBackup.update({
        where: { id: row.id },
        data: {
          status: succeeded ? "SUCCESS" : "FAILED",
          sizeBytes,
          exitCode,
          startLsn: meta.startLsn,
          timeline: meta.timeline,
          errorTail: succeeded ? null : scrubRunOutput(errorText, secrets),
          durationMs: completedAt.getTime() - startedAt,
          completedAt,
        },
      });
    } catch (e) {
      // The base may have run (exit 0) but persisting the SUCCESS row threw → the row is FAILED now, so force
      // succeeded=false to fire backup_failed (not a false success for a FAILED row).
      succeeded = false;
      errorText = e instanceof Error ? e.message : String(e);
      const completedAt = new Date();
      await this.prisma.baseBackup.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          exitCode,
          errorTail: scrubRunOutput(errorText, secrets),
          durationMs: completedAt.getTime() - startedAt,
          completedAt,
        },
      });
    }
    if (!succeeded) {
      // Best-effort cleanup of a partial LOCAL file / truncated object (the shared sink has no cleanup trap).
      await this.agentWs
        .sendCommand(db.serverId, buildDeleteBackupScript(ns, filename, dest), "backup")
        .catch(() => undefined);
    }
    await this.audit.log({
      actor,
      action: "database.basebackup",
      target: db.id,
      meta: { baseBackupId: row.id, status: succeeded ? "SUCCESS" : "FAILED", anchored: !!(meta.startLsn && meta.timeline != null), walSegmentSize: meta.walSegmentSize },
    });
    const ctx = {
      dbId: db.id,
      dbName: `${db.name} (base backup)`,
      engine: db.engine,
      version: db.version,
      destType: dest.type,
      bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
      region: dest.type === "S3" && dest.s3 ? dest.s3.region : "",
    };
    if (!succeeded) {
      // Reuse the backup_failed event (no new template); its own 'basebackup' Redis namespace throttles it
      // and never clears/masks the logical backup alert state for the same db.
      if (await this.alerts.shouldNotifyFailure("basebackup", db.id)) {
        await this.notifications
          .fireForEvent(db.teamId, "backup_failed", { ...ctx, errorTail: scrubRunOutput(errorText, secrets) })
          .catch(() => undefined);
      }
    } else {
      await this.notifications
        .fireForEvent(db.teamId, "backup_success", { ...ctx, sizeBytes: sizeBytes != null ? sizeBytes.toString() : "" })
        .catch(() => undefined);
      await this.alerts
        .recover("basebackup", db.id, db.teamId, { dbId: db.id, dbName: ctx.dbName, engine: db.engine, version: db.version })
        .catch(() => undefined);
    }
    await this.pruneBase(db);
    return this.prisma.baseBackup.findUnique({ where: { id: row.id } }) as Promise<BaseBackup>;
  }

  /** Keep the newest BASE_RETENTION SUCCESS bases (delete older objects + rows from each row's OWN
   *  destination); cap FAILED history so the table stays bounded; then reclaim the archived WAL that no KEPT base
   *  can need (WAL-aware: every segment from the oldest kept base's start segment onwards stays — a base must
   *  outlive the WAL it anchors, and the WAL must outlive the base that anchors it). */
  async pruneBase(db: Database): Promise<void> {
    // Never prune while a point-in-time replay of this database is in flight: it may be streaming one of these
    // base objects right now (a deleted object mid-stream = a failed restore). The next base backup prunes.
    // Re-checked before EVERY destructive step below (not once up front): the count prune + WAL GC can take
    // minutes, and a replay that starts meanwhile claims first, then reads its base — so the side that goes
    // second always sees the other (the restore re-reads its base after writing its RUNNING row).
    if (await this.replaying(db.id)) return;
    const ns = baseNs(db.id);
    const stale = (
      await this.prisma.baseBackup.findMany({ where: { databaseId: db.id, status: "SUCCESS" }, orderBy: { createdAt: "desc" } })
    ).slice(BASE_RETENTION);
    for (const b of stale) {
      if (await this.replaying(db.id)) return;
      // Row first, then the object: a replay that picked this base re-reads the row after claiming and fails
      // fast ("just pruned; retry") instead of streaming a vanishing object.
      await this.prisma.baseBackup.delete({ where: { id: b.id } });
      const spec = await this.runner.destinationSpecById(b.destinationId);
      await this.agentWs.sendCommand(db.serverId, buildDeleteBackupScript(ns, b.filename, spec), "backup").catch(() => undefined);
    }
    const oldFailed = (
      await this.prisma.baseBackup.findMany({ where: { databaseId: db.id, status: "FAILED" }, orderBy: { createdAt: "desc" } })
    ).slice(FAILED_HISTORY_CAP);
    if (oldFailed.length) await this.prisma.baseBackup.deleteMany({ where: { id: { in: oldFailed.map((b) => b.id) } } });
    await this.pruneWal(db);
  }

  /** A point-in-time replay of `databaseId` is claimed in-process (start() before any row exists) or RUNNING in
   *  the DB (cross-restart; bounded by REPLAY_GUARD_MS so an orphan never blocks retention forever). */
  private async replaying(databaseId: string): Promise<boolean> {
    if (this.claims.has(databaseId)) return true;
    const running = await this.prisma.restore.findFirst({
      where: { databaseId, kind: "PITR", status: "RUNNING", createdAt: { gte: new Date(this.now() - REPLAY_GUARD_MS) } },
      select: { id: true },
    });
    return !!running;
  }

  /**
   * WAL-aware retention. Cutoff = the start segment of the OLDEST kept SUCCESS base (the minimum over the kept
   * set — never dependent on row order); only segments on that same timeline sorting strictly before it are
   * reclaimed (`walGcCandidates`). Refuses (keeps everything) whenever the cutoff cannot be established with
   * certainty: PITR not ACTIVE on this database, no kept base, a kept base without startLsn/timeline (a pre-5.3
   * row or a non-16MB cluster), kept bases on more than one timeline, or an untrusted listing. The objects live
   * under the database's CURRENT destination — the shipper's target — never a kept base's own destination.
   * Best-effort and budgeted: a failed delete is logged + audited and retried by the next prune; it never fails
   * the base backup that triggered it. Every outcome (reclaim or refusal) is audited so a stalled GC is visible.
   */
  private async pruneWal(db: Database): Promise<void> {
    if (!db.pitrEnabled || !db.pitrEnabledAt) return;
    const kept = await this.prisma.baseBackup.findMany({
      where: { databaseId: db.id, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: BASE_RETENTION,
      select: { id: true, startLsn: true, timeline: true },
    });
    if (kept.length === 0) return;
    const segs: string[] = [];
    for (const b of kept) {
      const s = b.startLsn && b.timeline != null ? walSegmentName(b.startLsn, b.timeline) : null;
      if (!s) {
        this.logger.warn(`wal gc for database ${db.id}: a kept base has no start LSN; keeping all archived WAL`);
        await this.auditGc(db.id, { skipped: "no_start_lsn", baseBackupId: b.id });
        return;
      }
      segs.push(s);
    }
    if (new Set(segs.map((s) => s.slice(0, 8))).size !== 1) {
      this.logger.warn(`wal gc for database ${db.id}: kept bases span more than one timeline; keeping all archived WAL`);
      await this.auditGc(db.id, { skipped: "timelines" });
      return;
    }
    const cutoff = segs.slice().sort()[0];
    let dest: DestinationSpec;
    try {
      dest = await this.runner.destinationSpecById(db.backupDestinationId);
    } catch (e) {
      this.logger.warn(`wal gc for database ${db.id}: destination unavailable: ${e instanceof Error ? e.message : e}`);
      await this.auditGc(db.id, { skipped: "destination", cutoff });
      return;
    }
    const listed = await this.listWal(db, dest, cutoff);
    if (!listed.objects) {
      await this.auditGc(db.id, { skipped: listed.reason, cutoff });
      return;
    }
    const candidates = walGcCandidates(listed.objects, cutoff);
    if (candidates.length === 0) return;
    const started = this.now();
    let deleted = 0;
    let kept2 = 0;
    let attempted = 0;
    let stopped: "budget" | "died" | "error" | "replay" | null = null;
    for (let i = 0; i < candidates.length; i += WAL_GC_BATCH) {
      if (this.now() - started > WAL_GC_BUDGET_MS) {
        stopped = "budget";
        break;
      }
      if (await this.replaying(db.id)) {
        stopped = "replay";
        break;
      }
      const batch = candidates.slice(i, i + WAL_GC_BATCH);
      attempted += batch.length;
      try {
        const r = await this.agentWs.sendCommand(db.serverId, buildWalDeleteScript(db.id, batch, dest), "backup", WAL_GC_DELETE_TIMEOUT_MS);
        const parsed = parseWalDeleted(r.output);
        deleted += parsed.deleted.length;
        kept2 += parsed.kept.length;
        // No trailer = the command died mid-way (output cap / agent drop): stop here, the next prune resumes.
        if (parsed.total == null) {
          stopped = "died";
          break;
        }
      } catch (e) {
        this.logger.warn(`wal gc for database ${db.id}: delete batch failed: ${e instanceof Error ? e.message : e}`);
        stopped = "error";
        break;
      }
    }
    const deferred = candidates.length - attempted + kept2;
    this.logger.log(
      `wal gc for database ${db.id}: cutoff ${cutoff}, ${candidates.length} reclaimable, ${deleted} deleted, ${kept2} kept` +
        (deferred > 0 ? `, ${deferred} deferred to the next run${stopped ? ` (${stopped})` : ""}` : ""),
    );
    await this.auditGc(db.id, { cutoff, reclaimable: candidates.length, deleted, kept: kept2, deferred, stopped });
  }

  private async auditGc(databaseId: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.log({ actor: "system", action: "database.pitr.wal_gc", target: databaseId, meta });
    } catch {
      /* best-effort */
    }
  }

  /** The shipped WAL objects up to (and a little past) `cutoff`, cursor-paged in name order — paging stops once a
   *  page's last name sorts at/after the cutoff, since nothing after it can be a candidate. `objects: null` = the
   *  listing could not be trusted (never "empty"), with the reason. */
  private async listWal(db: Database, dest: DestinationSpec, cutoff: string): Promise<{ objects: WalObject[] | null; reason?: "list_failed" | "list_exceeded" }> {
    const all: WalObject[] = [];
    let after: string | undefined;
    for (let page = 0; page < WAL_GC_LIST_PAGES; page++) {
      let output: string;
      try {
        const r = await this.agentWs.sendCommand(db.serverId, buildWalObjectListScript(db.id, dest, { after }), "backup", WAL_GC_LIST_TIMEOUT_MS);
        if (r.exitCode !== 0) return { objects: null, reason: "list_failed" };
        output = r.output;
      } catch (e) {
        this.logger.warn(`wal gc for database ${db.id}: listing failed: ${e instanceof Error ? e.message : e}`);
        return { objects: null, reason: "list_failed" };
      }
      const parsed = parseWalObjects(output, dest);
      if (!parsed) return { objects: null, reason: "list_failed" };
      all.push(...parsed.objects);
      // `last` is the raw stored name (with its .gz[.gpg] suffix); a suffix never changes how it sorts against a
      // bare segment name, so "last ≥ cutoff" means every later page sorts past the cutoff too.
      if (!parsed.more || parsed.last >= cutoff) return { objects: all };
      after = parsed.last;
    }
    this.logger.warn(`wal gc for database ${db.id}: WAL listing exceeded ${WAL_GC_LIST_PAGES} pages before the cutoff; skipping this run`);
    return { objects: null, reason: "list_exceeded" };
  }
}
