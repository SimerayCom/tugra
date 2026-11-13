import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { BaseBackup, Database, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { type DbEngine } from "../databases/database-script";
import { BackupRunnerService, parseSize } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { baseBackupFilename, baseNs, buildBaseBackupScript, parseBaseMeta } from "./base-backup-script";
import { backupPath, buildDeleteBackupScript, scrubRunOutput } from "./backup-script";
import { objectKey } from "./destination";

const BASE_BACKUP_TIMEOUT_MS = 3_600_000; // a full-cluster physical copy can be large/slow
const FAILED_HISTORY_CAP = 20; // keep the table bounded (FAILED rows are never pruned by retention)
const BASE_RETENTION = 3; // count-only in 5.3 (each -X fetch base is standalone); 5.4 makes it WAL-aware

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
  ) {}

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
    let meta: { startLsn: string | null; timeline: number | null } = { startLsn: null, timeline: null };
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
    await this.audit.log({ actor, action: "database.basebackup", target: db.id });
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
   *  destination); cap FAILED history so the table stays bounded. COUNT-ONLY in 5.3 — 5.4 replaces this with a
   *  WAL-aware rule (a base must outlive the WAL it anchors) before any PITR window is advertised. */
  async pruneBase(db: Database): Promise<void> {
    // Never prune while a point-in-time replay of this database is in flight: it may be streaming one of these
    // base objects right now (a deleted object mid-stream = a failed restore). The next base backup prunes.
    // Bounded by the longest possible replay (14h): a RUNNING row older than that is a hub-restart orphan the PITR
    // sweep resolves, and must never block pruning forever.
    const replaying = await this.prisma.restore.findFirst({
      where: { databaseId: db.id, kind: "PITR", status: "RUNNING", createdAt: { gte: new Date(Date.now() - 14 * 3_600_000) } },
      select: { id: true },
    });
    if (replaying) return;
    const ns = baseNs(db.id);
    const stale = (
      await this.prisma.baseBackup.findMany({ where: { databaseId: db.id, status: "SUCCESS" }, orderBy: { createdAt: "desc" } })
    ).slice(BASE_RETENTION);
    for (const b of stale) {
      const spec = await this.runner.destinationSpecById(b.destinationId);
      await this.agentWs.sendCommand(db.serverId, buildDeleteBackupScript(ns, b.filename, spec), "backup").catch(() => undefined);
      await this.prisma.baseBackup.delete({ where: { id: b.id } });
    }
    const oldFailed = (
      await this.prisma.baseBackup.findMany({ where: { databaseId: db.id, status: "FAILED" }, orderBy: { createdAt: "desc" } })
    ).slice(FAILED_HISTORY_CAP);
    if (oldFailed.length) await this.prisma.baseBackup.deleteMany({ where: { id: { in: oldFailed.map((b) => b.id) } } });
  }
}
