import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Backup, BaseBackup, Database, Restore, RestoreKind, RestoreStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { resolveImage, supportsBackup, type DbEngine } from "../databases/database-script";
import { buildBackupExportUrlScript, buildDeleteBackupScript, buildImportScript, buildRestoreScript } from "./backup-script";
import { baseNs } from "./base-backup-script";
import { parseShareUrl } from "./destination";
import { BackupRunnerService } from "./backup-runner.service";
import { BaseBackupRunnerService } from "./base-backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { planTargets } from "../bulk/bulk.service";
import type { BackupConfigInput, BaseBackupConfigInput, ImportFromUrlInput, VerifyConfigInput } from "./dto";

export const BackupViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  filename: z.string(),
  sizeBytes: z.string().nullable(), // BigInt serialized
  destinationId: z.string().nullable(), // which destination stored it (null = local disk)
  destinationType: z.string().nullable(), // "S3" | "LOCAL" | null — only an S3 backup can export a migration URL
  createdBy: z.string(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
  // Run outcome. exitCode/durationMs are non-sensitive; errorTail (scrubbed command output) is WRITER-ONLY —
  // null for read-only members, exactly like Restore.errorTail.
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  errorTail: z.string().nullable(),
});
export type BackupView = z.infer<typeof BackupViewSchema>;

export const RestoreViewSchema = z.object({
  id: z.string(),
  kind: z.nativeEnum(RestoreKind),
  status: z.nativeEnum(RestoreStatus),
  exitCode: z.number().nullable(),
  errorTail: z.string().nullable(), // writer-only (may hold command error output)
  backupId: z.string().nullable(),
  // Which database the row is homed on and, for cross-database restores, the other side. A PITR replay is homed
  // on the SOURCE and names the NEW database it produced plus the moment and base used.
  databaseId: z.string(),
  sourceDatabaseId: z.string().nullable(),
  targetDatabaseId: z.string().nullable(),
  targetTime: z.date().nullable(),
  baseBackupId: z.string().nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});
export type RestoreView = z.infer<typeof RestoreViewSchema>;

export const BaseBackupViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  filename: z.string(),
  sizeBytes: z.string().nullable(), // BigInt serialized
  destinationId: z.string().nullable(),
  pgVersion: z.string().nullable(),
  startLsn: z.string().nullable(), // WAL anchor for the PITR slices (best-effort; may be null)
  timeline: z.number().nullable(),
  createdBy: z.string(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  errorTail: z.string().nullable(), // writer-only (scrubbed command output)
});
export type BaseBackupView = z.infer<typeof BaseBackupViewSchema>;

@Injectable()
export class BackupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: BackupRunnerService,
    private readonly scheduler: BackupSchedulerService,
    private readonly notifications: NotificationsService,
    private readonly alerts: BackupAlertsService,
    private readonly baseRunner: BaseBackupRunnerService,
  ) {}

  async listRestores(userId: string, dbId: string): Promise<RestoreView[]> {
    // Writer-only: errorTail may contain command output.
    await this.requireWrite(userId, dbId);
    const rows = await this.prisma.restore.findMany({
      // Also show cross-DB restores this DB initiated (recorded under the target) and PITR replays that produced
      // this DB (recorded under the source).
      where: { OR: [{ databaseId: dbId }, { sourceDatabaseId: dbId }, { targetDatabaseId: dbId }] },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map((r) => this.restoreView(r));
  }

  async backupNow(userId: string, dbId: string): Promise<BackupView> {
    const db = await this.requireWrite(userId, dbId);
    if (!supportsBackup(db.engine as DbEngine)) {
      throw new BadRequestException(`backup not supported for ${db.engine} yet`);
    }
    const backup = await this.runner.runBackup(dbId, userId);
    return (await this.toViews([backup], true))[0]; // requireWrite above → the caller is a writer
  }

  async list(userId: string, dbId: string): Promise<BackupView[]> {
    const db = await this.require(userId, dbId);
    const backups = await this.prisma.backup.findMany({
      where: { databaseId: dbId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // errorTail is command output → writers only (same gate as listRestores / requireWrite).
    const perms = await this.access.membershipPermissions(userId, db.teamId);
    return this.toViews(backups, perms?.has("backups") ?? false);
  }

  async restore(userId: string, dbId: string, backupId: string): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    const backup = await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: dbId } });
    if (!backup) throw new NotFoundException("backup not found");
    // Read from the backup's OWN destination — the DB's current destination may
    // have changed since this backup was taken.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    await this.runner.runRestore({
      db,
      command: buildRestoreScript(this.runner.toSpec(db), backup.filename, dest, backup.databaseId),
      kind: RestoreKind.RESTORE,
      createdBy: userId,
      backupId: backup.id,
      auditAction: "database.restore",
      auditMeta: { backupId },
    });
  }

  /**
   * Restore a backup taken from one database INTO a different, compatible one
   * ("take from A, load into B"). Overwrites the target's data. Requires WRITE
   * on both, same team, matching engine; LOCAL backups can only cross machines
   * via an S3 destination (the file lives on the source server's disk).
   */
  async restoreTo(userId: string, sourceId: string, backupId: string, targetId: string): Promise<void> {
    const source = await this.requireWrite(userId, sourceId);
    const target = await this.requireWrite(userId, targetId);
    const backup = await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: sourceId } });
    if (!backup || backup.status !== "SUCCESS") throw new NotFoundException("backup not found");
    if (source.teamId !== target.teamId) throw new ForbiddenException("cross-team restore is not allowed");
    if (source.engine !== target.engine) {
      throw new BadRequestException(`engine mismatch: ${source.engine} backup cannot restore into ${target.engine}`);
    }
    if (!backup.destinationId && source.serverId !== target.serverId) {
      throw new BadRequestException("cross-server restore needs an S3 backup destination");
    }
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    await this.runner.runRestore({
      db: target,
      // The backup object/file lives under the SOURCE db's id, but we restore into the TARGET container —
      // pass the source id as the storage id so the S3 object key / local path resolves to where it was saved.
      command: buildRestoreScript(this.runner.toSpec(target), backup.filename, dest, backup.databaseId),
      kind: RestoreKind.RESTORE_TO,
      createdBy: userId,
      backupId: backup.id,
      sourceDatabaseId: sourceId,
      auditAction: "database.restore",
      auditMeta: { backupId, from: sourceId },
    });
  }

  /**
   * Restore-verification drill: prove a backup actually RESTORES. Provisions a disposable, faithful
   * throwaway DB (same engine/version/image/server as the source), restores the chosen backup INTO it,
   * and records the outcome as a VERIFY Restore row homed on the SOURCE db — so the attestation survives
   * the throwaway's teardown (Restore.database is onDelete:Cascade). The throwaway is ALWAYS reaped. A
   * backup that does not restore is attested FAILED + alerted, never silently assumed good.
   *
   * Permissions: 'backups' write on the source (requireWrite) AND the 'databases' permission (it
   * provisions a real DB, enforced by createForImport); a source on a NON-standard image additionally
   * needs 'apps:config' (reproducing that image is an image-level privilege). An offline agent surfaces
   * 503 (cannot verify now); a backup that ran but did not restore returns a FAILED VERIFY view — the
   * verification itself succeeded, the backup is simply bad, so that is not an HTTP error.
   */
  async verifyBackupNow(userId: string, dbId: string, backupId?: string): Promise<RestoreView> {
    const src = await this.requireWrite(userId, dbId);
    if (!supportsBackup(src.engine as DbEngine)) {
      throw new BadRequestException(`backup not supported for ${src.engine} yet`);
    }
    const backup = backupId
      ? await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: dbId, status: "SUCCESS" } })
      : await this.prisma.backup.findFirst({ where: { databaseId: dbId, status: "SUCCESS" }, orderBy: { createdAt: "desc" } });
    if (!backup) throw new BadRequestException("no successful backup to verify");
    // The drill provisions a real throwaway DB through the ungated system seam (runner.verifyBackup →
    // DatabasesService.withSystemThrowaway), so the user-facing privilege checks that createForImport used to
    // enforce implicitly must be asserted HERE: 'databases' always, plus 'apps:config' when reproducing a
    // NON-standard source image (running a custom image is an app-image-level privilege).
    await this.access.requirePermission(userId, src.teamId, "databases");
    if (src.image !== resolveImage(src.engine as DbEngine, src.version)) {
      await this.access.requirePermission(userId, src.teamId, "apps:config");
    }
    const row = await this.runner.verifyBackup(src, backup, userId);
    return this.restoreView(row);
  }

  private restoreView(r: Restore): RestoreView {
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      exitCode: r.exitCode,
      errorTail: r.errorTail,
      backupId: r.backupId,
      databaseId: r.databaseId,
      sourceDatabaseId: r.sourceDatabaseId,
      targetDatabaseId: r.targetDatabaseId,
      targetTime: r.targetTime,
      baseBackupId: r.baseBackupId,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }

  /** Import an external dump from a URL into the database (overwrites current data). */
  async importFromUrl(userId: string, dbId: string, input: ImportFromUrlInput): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    if (!supportsBackup(db.engine as DbEngine)) {
      throw new BadRequestException(`import not supported for ${db.engine}`);
    }
    await this.runner.runRestore({
      db,
      command: buildImportScript(this.runner.toSpec(db), input.url, {
        encrypted: input.encrypted,
        key: input.encryptionKey ?? "",
        gzip: input.gzip,
        pgFormat: input.pgFormat,
      }),
      kind: RestoreKind.IMPORT_URL,
      createdBy: userId,
      auditAction: "database.import",
    });
  }

  /**
   * Produce a short-lived presigned download URL for an S3 database backup, so it can be fed to
   * import-from-URL on another server (migration). S3-only — a LOCAL-disk backup has no presignable
   * object. The URL grants time-limited download of the backup data → returned to the caller but
   * NEVER logged/audited.
   */
  async exportUrl(userId: string, dbId: string, backupId: string, expireHours: number): Promise<{ url: string; expiresAt: Date }> {
    const db = await this.requireWrite(userId, dbId);
    const backup = await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: dbId } });
    if (!backup) throw new NotFoundException("backup not found");
    // Read from the backup's OWN destination, not the DB's current one.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    if (dest.type !== "S3") throw new BadRequestException("a migration URL needs an S3 backup destination");
    const r = await this.agentWs.sendCommand(
      db.serverId,
      buildBackupExportUrlScript(db.id, backup.filename, dest, `${expireHours}h`),
      "backup",
      60_000,
    );
    if (r.exitCode !== 0) throw new BadGatewayException("could not generate a migration URL");
    const url = parseShareUrl(r.output);
    if (!url) throw new BadGatewayException("could not generate a migration URL");
    // Audit the action but NEVER the URL (it grants time-limited download of the backup data).
    await this.audit.log({ actor: userId, action: "database.backup.export", target: dbId, meta: { backupId, expireHours } });
    return { url, expiresAt: new Date(Date.now() + expireHours * 3600_000) };
  }

  async removeBackup(userId: string, dbId: string, backupId: string): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    const backup = await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: dbId } });
    if (!backup) throw new NotFoundException("backup not found");
    // Delete from the backup's OWN destination, not the DB's current one.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    await this.agentWs
      .sendCommand(db.serverId, buildDeleteBackupScript(dbId, backup.filename, dest), "backup")
      .catch(() => undefined);
    await this.prisma.backup.delete({ where: { id: backup.id } });
    await this.audit.log({ actor: userId, action: "database.backup.remove", target: dbId });
  }

  async setSchedule(userId: string, dbId: string, cfg: BackupConfigInput): Promise<Database> {
    const existing = await this.requireWrite(userId, dbId);
    // Don't enable a schedule for an engine with no dump/restore pipeline (e.g. libSQL) — the runner would
    // only fail later. requireWrite already loaded the row, so this is a free check (no extra query).
    if (cfg.enabled && !supportsBackup(existing.engine as DbEngine)) {
      throw new BadRequestException(`scheduled backups are not supported for ${existing.engine} yet`);
    }
    const db = await this.apply(dbId, cfg);
    await this.audit.log({ actor: userId, action: "database.backup.schedule", target: dbId });
    return db;
  }

  /**
   * Arm/disarm the scheduled restore-verify drill. A stricter bar than backup-config: arming it schedules
   * RECURRING system provisioning (each tick spins up + tears down a real DB), so it needs both 'backups'
   * write AND the 'databases' permission — exactly the privileges the on-demand drill enforces.
   */
  async setVerifySchedule(userId: string, dbId: string, cfg: VerifyConfigInput): Promise<Database> {
    const existing = await this.requireWrite(userId, dbId);
    await this.access.requirePermission(userId, existing.teamId, "databases");
    // Mirror the on-demand drill's bar exactly: arming a recurring drill on a NON-standard image means the
    // scheduler will reproduce that image every tick, so require the same 'apps:config' privilege the
    // on-demand drill (verifyBackupNow) demands. Only when enabling — disarming never provisions.
    if (cfg.enabled && existing.image !== resolveImage(existing.engine as DbEngine, existing.version)) {
      await this.access.requirePermission(userId, existing.teamId, "apps:config");
    }
    if (cfg.enabled && !supportsBackup(existing.engine as DbEngine)) {
      throw new BadRequestException(`scheduled verify is not supported for ${existing.engine} yet`);
    }
    const db = await this.applyVerify(dbId, cfg);
    await this.audit.log({ actor: userId, action: "database.verify.schedule", target: dbId });
    return db;
  }

  /**
   * Apply one backup schedule to many databases (fleet bulk op). Each db is
   * gated by the caller's role in its team — non-writable / cross-team / unknown
   * databases are SKIPPED (not an error). destinationId is not touched.
   */
  async setScheduleBulk(
    userId: string,
    dbIds: string[],
    cfg: BackupConfigInput,
  ): Promise<{ applied: string[]; skipped: string[] }> {
    const dbs = await this.prisma.database.findMany({
      where: { id: { in: dbIds } },
      select: { id: true, teamId: true, engine: true },
    });
    const engineById = new Map(dbs.map((d) => [d.id, d.engine]));
    const permsByTeam = await this.access.permissionsByTeam(userId);
    const plan = planTargets(dbIds, dbs, permsByTeam, "backups");
    const applied: string[] = [];
    const engineSkipped: string[] = [];
    for (const target of plan) {
      if (!target.run) continue;
      // Skip (don't fail the batch) engines with no backup pipeline when enabling a schedule.
      if (cfg.enabled && !supportsBackup((engineById.get(target.serverId) ?? "POSTGRES") as DbEngine)) {
        engineSkipped.push(target.serverId);
        continue;
      }
      await this.apply(target.serverId, cfg);
      applied.push(target.serverId);
    }
    const skipped = [...plan.filter((p) => !p.run).map((p) => p.serverId), ...engineSkipped];
    if (applied.length > 0) {
      await this.audit.log({
        actor: userId,
        action: "database.backup.config.bulk",
        target: applied.join(","),
        meta: { count: applied.length },
      });
    }
    return { applied, skipped };
  }

  /** Persist the backup schedule + (re)schedule. Caller handles authz + engine-support; destinationId untouched when absent. */
  private async apply(dbId: string, cfg: BackupConfigInput): Promise<Database> {
    // PITR pins the destination: the WAL chain (and the base backups it anchors to) must live in ONE store, so a
    // destination change while PITR is on would split the chain and break replay. Disable PITR first.
    if (cfg.destinationId !== undefined) {
      const cur = await this.prisma.database.findUnique({ where: { id: dbId }, select: { pitrEnabled: true, backupDestinationId: true } });
      if (cur?.pitrEnabled && (cfg.destinationId || null) !== cur.backupDestinationId) {
        throw new ConflictException("the backup destination cannot change while PITR is enabled; disable PITR first");
      }
    }
    const db = await this.prisma.database.update({
      where: { id: dbId },
      data: {
        backupEnabled: cfg.enabled,
        backupIntervalHours: cfg.intervalHours ?? null,
        ...(cfg.cron !== undefined ? { backupCron: cfg.cron } : {}),
        backupRetention: cfg.retention ?? undefined,
        ...(cfg.retentionDays !== undefined ? { backupRetentionDays: cfg.retentionDays } : {}),
        ...(cfg.destinationId !== undefined ? { backupDestinationId: cfg.destinationId || null } : {}),
      },
    });
    // A cron expression wins over the plain interval when both are set.
    if (db.backupEnabled && db.backupCron) {
      await this.scheduler.scheduleCron(dbId, db.backupCron);
    } else if (db.backupEnabled && db.backupIntervalHours) {
      await this.scheduler.schedule(dbId, db.backupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(dbId);
    }
    // Re-arm the missing-backup watchdog from now + clear stale alerts, so a re-enable / interval change never
    // fires a stale backup_missing against an old success.
    await this.alerts.onScheduleChanged("database", dbId);
    return db;
  }

  /** Persist the verify schedule + (re)schedule its repeatable. Caller handles authz + engine-support. */
  private async applyVerify(dbId: string, cfg: VerifyConfigInput): Promise<Database> {
    const db = await this.prisma.database.update({
      where: { id: dbId },
      data: {
        verifyEnabled: cfg.enabled,
        verifyIntervalHours: cfg.intervalHours ?? null,
        ...(cfg.cron !== undefined ? { verifyCron: cfg.cron } : {}),
      },
    });
    // A cron expression wins over the plain interval when both are set.
    if (db.verifyEnabled && db.verifyCron) {
      await this.scheduler.scheduleVerifyCron(dbId, db.verifyCron);
    } else if (db.verifyEnabled && db.verifyIntervalHours) {
      await this.scheduler.scheduleVerify(dbId, db.verifyIntervalHours * 3600);
    } else {
      await this.scheduler.unscheduleVerify(dbId);
    }
    // Re-arm the verify-liveness watchdog from now + clear stale alerts.
    await this.alerts.onScheduleChanged("verify", dbId);
    return db;
  }

  /**
   * Arm/disarm the scheduled physical base backup (the PITR anchor). Same bar as the verify drill: 'backups' write
   * AND 'databases' (a base is a full-cluster copy on the database's host). Postgres-only.
   */
  async setBaseBackupSchedule(userId: string, dbId: string, cfg: BaseBackupConfigInput): Promise<Database> {
    const existing = await this.requireWrite(userId, dbId);
    await this.access.requirePermission(userId, existing.teamId, "databases");
    if ((existing.engine as DbEngine) !== "POSTGRES") {
      throw new BadRequestException("scheduled base backups are supported only for Postgres");
    }
    // The schedule is owned by PITR (bases are its anchors; disabling PITR clears it): arming needs PITR ACTIVE.
    if (cfg.enabled && (!existing.pitrEnabled || !existing.pitrEnabledAt)) {
      throw new ConflictException("enable PITR on this database before scheduling base backups");
    }
    const db = await this.applyBase(dbId, cfg);
    await this.audit.log({ actor: userId, action: "database.basebackup.schedule", target: dbId });
    return db;
  }

  /** Persist the base backup schedule + (re)schedule its repeatable. Caller handles authz + engine. */
  private async applyBase(dbId: string, cfg: BaseBackupConfigInput): Promise<Database> {
    const db = await this.prisma.database.update({
      where: { id: dbId },
      data: {
        baseBackupEnabled: cfg.enabled,
        baseBackupIntervalHours: cfg.intervalHours ?? null,
        ...(cfg.cron !== undefined ? { baseBackupCron: cfg.cron } : {}),
      },
    });
    if (db.baseBackupEnabled && db.baseBackupCron) {
      await this.scheduler.scheduleBaseCron(dbId, db.baseBackupCron);
    } else if (db.baseBackupEnabled && db.baseBackupIntervalHours) {
      await this.scheduler.scheduleBase(dbId, db.baseBackupIntervalHours * 3600);
    } else {
      await this.scheduler.unscheduleBase(dbId);
    }
    await this.alerts.onScheduleChanged("basebackup", dbId);
    return db;
  }

  // ── physical base backups (pg_basebackup) — the PITR base image. A SIBLING family: recorded in BaseBackup,
  //    never in Backup, so the logical backup / verify / prune / watchdog paths are untouched. Postgres-only. ──

  async baseBackupNow(userId: string, dbId: string): Promise<BaseBackupView> {
    const db = await this.requireWrite(userId, dbId);
    if ((db.engine as DbEngine) !== "POSTGRES") {
      throw new BadRequestException("physical base backups are supported only for Postgres");
    }
    const row = await this.baseRunner.runBaseBackup(dbId, userId);
    return this.baseView(row, true); // requireWrite above → the caller is a writer
  }

  async listBaseBackups(userId: string, dbId: string): Promise<BaseBackupView[]> {
    const db = await this.require(userId, dbId);
    // errorTail is command output → writers only (same gate as list()).
    const perms = await this.access.membershipPermissions(userId, db.teamId);
    const canWrite = perms?.has("backups") ?? false;
    const rows = await this.prisma.baseBackup.findMany({ where: { databaseId: dbId }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map((r) => this.baseView(r, canWrite));
  }

  async removeBaseBackup(userId: string, dbId: string, baseId: string): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    const row = await this.prisma.baseBackup.findFirst({ where: { id: baseId, databaseId: dbId } });
    if (!row) throw new NotFoundException("base backup not found");
    // Refuse while it is still RUNNING: deleting the row + its half-written object would make the in-flight
    // runner's completion update throw (record gone) and strand the finished artifact. Let it finish first.
    if (row.status === "RUNNING") throw new ConflictException("this base backup is still running — wait for it to finish");
    // Delete from the base's OWN destination (same free-form namespace helper the runner stores under).
    const dest = await this.runner.destinationSpecById(row.destinationId);
    await this.agentWs.sendCommand(db.serverId, buildDeleteBackupScript(baseNs(dbId), row.filename, dest), "backup").catch(() => undefined);
    await this.prisma.baseBackup.delete({ where: { id: row.id } });
    await this.audit.log({ actor: userId, action: "database.basebackup.remove", target: dbId });
  }

  private baseView(b: BaseBackup, canWrite: boolean): BaseBackupView {
    return {
      id: b.id,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      destinationId: b.destinationId,
      pgVersion: b.pgVersion,
      startLsn: b.startLsn,
      timeline: b.timeline,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
      exitCode: b.exitCode,
      durationMs: b.durationMs,
      errorTail: canWrite ? b.errorTail : null,
    };
  }

  // ── helpers ──
  /** Project rows to views, resolving each backup's destination TYPE (so the UI offers export only
   *  for S3-stored backups) with a single batched lookup — no per-row query, no cred decrypt. */
  private async toViews(rows: Backup[], canWrite: boolean): Promise<BackupView[]> {
    const ids = [...new Set(rows.map((r) => r.destinationId).filter((x): x is string => !!x))];
    const dests = ids.length
      ? await this.prisma.backupDestination.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })
      : [];
    const typeById = new Map(dests.map((d) => [d.id, d.type]));
    return rows.map((b) => this.view(b, b.destinationId ? typeById.get(b.destinationId) ?? null : null, canWrite));
  }

  private view(b: Backup, destinationType: string | null, canWrite: boolean): BackupView {
    return {
      id: b.id,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      destinationId: b.destinationId,
      destinationType,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
      exitCode: b.exitCode,
      durationMs: b.durationMs,
      errorTail: canWrite ? b.errorTail : null,
    };
  }

  private async require(userId: string, dbId: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id: dbId } });
    if (!db) throw new NotFoundException("database not found");
    if (!(await this.access.teamRole(userId, db.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    // Per-resource scoping: a restricted member can't read backups of a db they can't access.
    await this.access.requireResourceAccess(userId, db.teamId, {
      resourceId: db.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, db.environmentId).then((c) => c.projectId),
    });
    return db;
  }

  private async requireWrite(userId: string, dbId: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id: dbId } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requirePermission(userId, db.teamId, 'backups');
    return db;
  }
}
