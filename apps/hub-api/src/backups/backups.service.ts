import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { Backup, Database, RestoreKind, RestoreStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { supportsBackup, type DbEngine } from "../databases/database-script";
import { buildBackupExportUrlScript, buildDeleteBackupScript, buildImportScript, buildRestoreScript, scrubRestoreOutput } from "./backup-script";
import { parseShareUrl } from "./destination";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { planTargets } from "../bulk/bulk.service";
import type { BackupConfigInput, ImportFromUrlInput } from "./dto";

const RESTORE_TIMEOUT_MS = 300_000;

export const BackupViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  filename: z.string(),
  sizeBytes: z.string().nullable(), // BigInt serialized
  destinationType: z.string().nullable(), // "S3" | "LOCAL" | null — only an S3 backup can export a migration URL
  createdBy: z.string(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
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
    return (await this.toViews([backup]))[0];
  }

  async list(userId: string, dbId: string): Promise<BackupView[]> {
    await this.require(userId, dbId);
    const backups = await this.prisma.backup.findMany({
      where: { databaseId: dbId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return this.toViews(backups);
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
      command: buildRestoreScript(this.runner.toSpec(db), backup.filename, dest),
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
      command: buildRestoreScript(this.runner.toSpec(target), backup.filename, dest),
      kind: RestoreKind.RESTORE_TO,
      createdBy: userId,
      backupId: backup.id,
      sourceDatabaseId: sourceId,
      auditAction: "database.restore",
      auditMeta: { backupId, from: sourceId },
    });
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
        backupRetention: cfg.retention ?? undefined,
        ...(cfg.destinationId !== undefined ? { backupDestinationId: cfg.destinationId || null } : {}),
      },
    });
    if (db.backupEnabled && db.backupIntervalHours) {
      await this.scheduler.schedule(dbId, db.backupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(dbId);
    }
    return db;
  }

  // ── helpers ──
  /** Project rows to views, resolving each backup's destination TYPE (so the UI offers export only
   *  for S3-stored backups) with a single batched lookup — no per-row query, no cred decrypt. */
  private async toViews(rows: Backup[]): Promise<BackupView[]> {
    const ids = [...new Set(rows.map((r) => r.destinationId).filter((x): x is string => !!x))];
    const dests = ids.length
      ? await this.prisma.backupDestination.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })
      : [];
    const typeById = new Map(dests.map((d) => [d.id, d.type]));
    return rows.map((b) => this.view(b, b.destinationId ? typeById.get(b.destinationId) ?? null : null));
  }

  private view(b: Backup, destinationType: string | null): BackupView {
    return {
      id: b.id,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      destinationType,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
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
