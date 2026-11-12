import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { Backup, Database, DbStatus, RestoreKind, RestoreStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { randomBytes } from "crypto";
import { resolveImage, supportsBackup, type DbEngine } from "../databases/database-script";
import { DatabasesService } from "../databases/databases.service";
import { buildBackupExportUrlScript, buildDeleteBackupScript, buildImportScript, buildRestoreScript, scrubRestoreOutput } from "./backup-script";
import { parseShareUrl } from "./destination";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { planTargets } from "../bulk/bulk.service";
import type { BackupConfigInput, ImportFromUrlInput } from "./dto";

const RESTORE_TIMEOUT_MS = 300_000;

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
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});
export type RestoreView = z.infer<typeof RestoreViewSchema>;

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
    private readonly databases: DatabasesService,
  ) {}

  /**
   * Run a restore command, recording the attempt + its outcome. A non-zero exit
   * or an offline agent is recorded FAILED, alerted on, and thrown — never
   * silently reported as success.
   */
  private async runRestore(opts: {
    db: Database;
    command: string;
    kind: RestoreKind;
    createdBy: string;
    auditAction: string;
    auditMeta?: Record<string, unknown>;
    backupId?: string | null;
    sourceDatabaseId?: string | null;
    // Receives the created Restore row's id as soon as it exists (before the command runs, so it fires on
    // EVERY outcome including a thrown failure). The verify drill uses it to pin the exact attestation row.
    onRecord?: (id: string) => void;
  }): Promise<void> {
    const { db, command, kind, createdBy, auditAction, auditMeta } = opts;
    const rec = await this.prisma.restore.create({
      data: {
        databaseId: db.id,
        backupId: opts.backupId ?? null,
        sourceDatabaseId: opts.sourceDatabaseId ?? null,
        kind,
        status: RestoreStatus.RUNNING,
        createdBy,
      },
    });
    opts.onRecord?.(rec.id);

    let r: { exitCode: number; output: string };
    try {
      r = await this.agentWs.sendCommand(db.serverId, command, "backup", RESTORE_TIMEOUT_MS);
    } catch (e) {
      await this.failRestore(rec.id, db, null, e instanceof Error ? e.message : String(e));
      await this.audit.log({ actor: createdBy, action: auditAction, target: db.id, meta: { ...auditMeta, status: "FAILED" } });
      throw new ServiceUnavailableException("restore could not run (agent offline)");
    }
    if (r.exitCode !== 0) {
      await this.failRestore(rec.id, db, r.exitCode, r.output);
      await this.audit.log({ actor: createdBy, action: auditAction, target: db.id, meta: { ...auditMeta, status: "FAILED", exitCode: r.exitCode } });
      throw new BadGatewayException("restore failed");
    }
    await this.prisma.restore.update({
      where: { id: rec.id },
      data: { status: RestoreStatus.SUCCESS, exitCode: 0, completedAt: new Date() },
    });
    await this.audit.log({ actor: createdBy, action: auditAction, target: db.id, meta: { ...auditMeta, status: "SUCCESS" } });
  }

  private async failRestore(id: string, db: Database, exitCode: number | null, output: string): Promise<void> {
    await this.prisma.restore.update({
      where: { id },
      // Scrub customer row data (pg/mysql echo values in errors) before storing.
      data: { status: RestoreStatus.FAILED, exitCode, errorTail: scrubRestoreOutput(output), completedAt: new Date() },
    });
    // Best-effort: a notification failure must not mask the restore error. Scrub the raw output for
    // the ctx too (pg/mysql echo customer row values).
    await this.notifications
      .fireForEvent(db.teamId, "backup_restore_failed", {
        dbId: db.id,
        dbName: db.name,
        engine: db.engine,
        exitCode,
        errorTail: scrubRestoreOutput(output),
      })
      .catch(() => undefined);
  }

  async listRestores(userId: string, dbId: string): Promise<RestoreView[]> {
    // Writer-only: errorTail may contain command output.
    await this.requireWrite(userId, dbId);
    const rows = await this.prisma.restore.findMany({
      // Also show cross-DB restores this DB initiated (recorded under the target).
      where: { OR: [{ databaseId: dbId }, { sourceDatabaseId: dbId }] },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      exitCode: r.exitCode,
      errorTail: r.errorTail,
      backupId: r.backupId,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    }));
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
    await this.runRestore({
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
    await this.runRestore({
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
    // Read from the backup's OWN destination — the DB's current destination may have changed since.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    // Faithful throwaway. Only pass the image when it is NON-standard: createForImport gates ANY explicit
    // image behind apps:config, so handing it a standard image would force that privilege on every drill.
    // A standard image is left for createForImport to resolve (the same ref the source already uses).
    const standardImage = resolveImage(src.engine as DbEngine, src.version);
    const customImage = src.image !== standardImage ? src.image : undefined;
    const eph = await this.databases.createForImport(userId, {
      name: `verify_${src.id}_${Date.now()}`,
      serverId: src.serverId, // SAME server → the LOCAL-backup same-server rule holds and sendCommand reaches it
      engine: src.engine as DbEngine,
      version: src.version,
      image: customImage,
      username: "tugra",
      password: randomBytes(24).toString("base64url"),
      database: "verifydb",
      environmentId: src.environmentId,
    });
    let recordId: string | undefined;
    try {
      // provision() swallows agent failures and returns a FAILED view WITHOUT throwing, so a throwaway that
      // never came up (image pull failed, disk full, name/port clash) would otherwise let the restore hit a
      // non-existent container and mis-attribute an infra failure to the backup. Bail to a 503 instead.
      const provisioned = await this.databases.provision(userId, eph.id);
      if (provisioned.status !== DbStatus.RUNNING) {
        throw new ServiceUnavailableException("could not provision the verification target — try again");
      }
      // toSpec decrypts credentials off the Database ROW; createForImport returned a VIEW without them.
      const ephDb = await this.prisma.database.findUnique({ where: { id: eph.id } });
      if (!ephDb) throw new BadGatewayException("verification target vanished");
      try {
        await this.runRestore({
          // Row HOMED ON SOURCE (survives teardown); same server, so sendCommand(src.serverId) reaches the
          // throwaway container, while the restore pipeline targets the throwaway's own spec.
          db: src,
          command: buildRestoreScript(this.runner.toSpec(ephDb), backup.filename, dest, backup.databaseId),
          kind: RestoreKind.VERIFY,
          createdBy: userId,
          backupId: backup.id,
          auditAction: "database.verify",
          auditMeta: { backupId: backup.id, ephemeral: eph.id },
          onRecord: (id) => {
            recordId = id;
          },
        });
      } catch (e) {
        // A non-zero restore exit (BadGateway) means the drill RAN and the backup did not restore — a
        // successful verification with a FAILED result, so fall through and return the FAILED VERIFY view.
        // Anything else (agent offline → ServiceUnavailable, or an unexpected error) propagates.
        if (!(e instanceof BadGatewayException)) throw e;
      }
    } finally {
      // Always reap the throwaway (no app links it, so remove() proceeds and deletes the row even if the
      // agent teardown command fails or the agent is offline).
      await this.databases.remove(userId, eph.id, { keepVolume: false }).catch(() => undefined);
    }
    // Pin to the EXACT row this drill created — a re-query by (databaseId, kind, backupId) could return a
    // concurrent or prior same-backup drill's row and misreport this call's result.
    const row = recordId ? await this.prisma.restore.findUnique({ where: { id: recordId } }) : null;
    if (!row) throw new BadGatewayException("verification did not record a result");
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      exitCode: row.exitCode,
      errorTail: row.errorTail,
      backupId: row.backupId,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  /** Import an external dump from a URL into the database (overwrites current data). */
  async importFromUrl(userId: string, dbId: string, input: ImportFromUrlInput): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    if (!supportsBackup(db.engine as DbEngine)) {
      throw new BadRequestException(`import not supported for ${db.engine}`);
    }
    await this.runRestore({
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
