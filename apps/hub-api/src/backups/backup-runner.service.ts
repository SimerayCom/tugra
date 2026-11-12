import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { Backup, Database, Restore, RestoreKind, RestoreStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { DatabasesService } from "../databases/databases.service";
import {
  resolveImage,
  supportsBackup,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "../databases/database-script";
import {
  backupFilename,
  buildBackupScript,
  buildDeleteBackupScript,
  buildRestoreScript,
  scrubRestoreOutput,
  scrubRunOutput,
} from "./backup-script";
import { BackupAlertsService } from "./backup-alerts.service";
import { LOCAL_DEST, objectKey, type DestinationSpec } from "./destination";

const BACKUP_TIMEOUT_MS = 300_000; // dumps can be slow
const RESTORE_TIMEOUT_MS = 300_000;

@Injectable()
export class BackupRunnerService {
  private readonly logger = new Logger(BackupRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
    private readonly alerts: BackupAlertsService,
    private readonly databases: DatabasesService,
  ) {}

  /**
   * Run a restore command, recording the attempt + its outcome. A non-zero exit or an offline agent is
   * recorded FAILED, alerted on, and thrown — never silently reported as success. Shared by the user-facing
   * restore / restore-to / import-from-URL paths (via BackupsService) and the verify drill.
   */
  async runRestore(opts: {
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

  /**
   * Restore-verification CORE: prove `backup` actually RESTORES by restoring it into a disposable, faithful
   * throwaway database (same engine/version/image/server as `src`), recording the outcome as a VERIFY Restore
   * row HOMED ON `src` (so the attestation survives the throwaway's teardown — Restore.database is
   * onDelete:Cascade). The throwaway is ALWAYS reaped (via {@link DatabasesService.withSystemThrowaway}). A
   * backup that does not restore is attested FAILED (returned, not thrown); an offline agent surfaces 503.
   *
   * This is the cycle-safe home for the drill: BackupSchedulerService injects this runner, and this runner
   * reaches DatabasesService (which has no backups dependency) — so a scheduled verify never routes through
   * BackupsService. User-facing privilege checks ('backups'/'databases'/'apps:config') are the CALLER's job
   * (BackupsService.verifyBackupNow); `createdBy` is only an audit/actor label, never an authz input.
   */
  async verifyBackup(src: Database, backup: Backup, createdBy: string): Promise<Restore> {
    // Read from the backup's OWN destination — the source's current destination may have changed since.
    const dest = await this.destinationSpecById(backup.destinationId);
    // Faithful throwaway: only forward the image when it is NON-standard (a standard image is left for the
    // throwaway to resolve, exactly the ref the source already uses).
    const standardImage = resolveImage(src.engine as DbEngine, src.version);
    const customImage = src.image !== standardImage ? src.image : undefined;
    let recordId: string | undefined;
    try {
      await this.databases.withSystemThrowaway(
        {
          name: `verify_${src.id}_${Date.now()}`,
          serverId: src.serverId, // SAME server → the LOCAL-backup same-server rule holds and sendCommand reaches it
          engine: src.engine as DbEngine,
          version: src.version,
          image: customImage,
          username: "tugra",
          password: randomBytes(24).toString("base64url"),
          database: "verifydb",
          environmentId: src.environmentId,
        },
        createdBy,
        async (ephDb) => {
          await this.runRestore({
            // Row HOMED ON SOURCE (survives teardown); same server, so sendCommand(src.serverId) reaches the
            // throwaway container, while the restore pipeline targets the throwaway's own spec.
            db: src,
            command: buildRestoreScript(this.toSpec(ephDb), backup.filename, dest, backup.databaseId),
            kind: RestoreKind.VERIFY,
            createdBy,
            backupId: backup.id,
            auditAction: "database.verify",
            auditMeta: { backupId: backup.id, ephemeral: ephDb.id },
            onRecord: (id) => {
              recordId = id;
            },
          });
        },
      );
    } catch (e) {
      // A non-zero restore exit (BadGateway) means the drill RAN and the backup did not restore — a
      // successful verification with a FAILED result, so fall through and return the FAILED VERIFY row.
      // Anything else (agent offline → ServiceUnavailable, provision failure → 503) propagates.
      if (!(e instanceof BadGatewayException)) throw e;
    }
    // Pin to the EXACT row this drill created — a re-query by (databaseId, kind, backupId) could return a
    // concurrent or prior same-backup drill's row and misreport this call's result.
    const row = recordId ? await this.prisma.restore.findUnique({ where: { id: recordId } }) : null;
    if (!row) throw new BadGatewayException("verification did not record a result");
    if (row.status === RestoreStatus.SUCCESS) {
      // Stamp the last-verified time (UI + watchdog reference) and clear any verify_missing/failure state.
      // Best-effort: a stamp/notify failure must not mask a successful verification.
      await this.prisma.database.update({ where: { id: src.id }, data: { lastVerifiedAt: new Date() } }).catch(() => undefined);
      await this.alerts
        .recover("verify", src.id, src.teamId, { dbId: src.id, dbName: src.name, engine: src.engine, version: src.version })
        .catch(() => undefined);
    } else if (row.status === RestoreStatus.FAILED) {
      // Record the verify fail-state so a later SUCCESS fires verify_recovered (after a failure, not only
      // after a watchdog "missing"). The user-facing failure notice is backup_restore_failed, already fired
      // by the restore path; this only arms recovery. Best-effort.
      await this.alerts.shouldNotifyFailure("verify", src.id).catch(() => undefined);
    }
    return row;
  }

  /**
   * The scheduled restore-verify tick: verify the LATEST successful backup of `databaseId`. No-ops when the
   * schedule was disabled since the job was enqueued, the engine lost backup support, or there is no SUCCESS
   * backup yet (the liveness watchdog, not this, alerts on a drill that never runs). An offline agent / failed
   * provision is swallowed (logged) so the repeatable is not retry-spammed — the watchdog catches a drill that
   * stops producing attestations. A RAN-but-FAILED drill is recorded + alerted inside {@link verifyBackup}.
   */
  async verifyScheduled(databaseId: string): Promise<void> {
    const src = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!src || !src.verifyEnabled || !supportsBackup(src.engine as DbEngine)) return;
    const backup = await this.prisma.backup.findFirst({
      where: { databaseId, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    });
    if (!backup) return;
    try {
      await this.verifyBackup(src, backup, "scheduler");
    } catch (e) {
      this.logger.warn(`scheduled verify for database ${databaseId} could not run: ${e instanceof Error ? e.message : e}`);
    }
  }

  toSpec(db: Database): DbSpec {
    const creds = JSON.parse(this.crypto.decrypt(db.credentials)) as DbCredentials;
    return {
      id: db.id,
      engine: db.engine as DbEngine,
      image: db.image,
      port: db.port,
      hostPort: db.hostPort,
      credentials: creds,
    };
  }

  /** Resolve a database's configured backup destination (or LOCAL by default). */
  async destinationSpec(db: Database): Promise<DestinationSpec> {
    return this.destinationSpecById(db.backupDestinationId);
  }

  /** Resolve a destination by id (or LOCAL when none). Used by cross-resource restore
   *  to read the backup from the destination it was WRITTEN to, not the target's. */
  async destinationSpecById(destinationId: string | null): Promise<DestinationSpec> {
    if (!destinationId) return LOCAL_DEST;
    const d = await this.prisma.backupDestination.findUnique({
      where: { id: destinationId },
    });
    if (!d) return LOCAL_DEST;
    // Encryption is configurable on LOCAL destinations too (the dump is gpg-encrypted on the server's own
    // disk). Carry it through for every type — collapsing a non-S3 destination to the unencrypted LOCAL_DEST
    // silently dropped encryptionEnabled/encryptionKey, so a "LOCAL + encrypted" backup was stored in cleartext.
    const encryption = {
      enabled: d.encryptionEnabled,
      key: d.encryptionKey ? this.crypto.decrypt(d.encryptionKey) : "",
    };
    if (d.type !== "S3") {
      return { type: "LOCAL", encryption };
    }
    return {
      type: "S3",
      s3: {
        bucket: d.s3Bucket ?? "",
        region: d.s3Region ?? "",
        endpoint: d.s3Endpoint ?? "",
        accessKey: d.s3AccessKey ? this.crypto.decrypt(d.s3AccessKey) : "",
        secretKey: d.s3SecretKey ? this.crypto.decrypt(d.s3SecretKey) : "",
        prefix: d.s3Prefix ?? "",
      },
      encryption,
    };
  }

  /** Run a dump for the database, record it, then prune to the retention limit. */
  async runBackup(databaseId: string, actor = "scheduler"): Promise<Backup> {
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db) throw new Error("database not found");
    if (!supportsBackup(db.engine as DbEngine)) {
      throw new Error(`backup not supported for ${db.engine}`);
    }

    const dest = await this.destinationSpec(db);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = backupFilename(db.engine as DbEngine, ts, dest);
    const path = `/etc/tugra/backups/${db.id}/${filename}`;
    const key = dest.type === "S3" && dest.s3 ? objectKey(dest.s3, db.id, filename) : null;
    const backup = await this.prisma.backup.create({
      data: {
        databaseId: db.id,
        status: "RUNNING",
        filename,
        path,
        destinationId: db.backupDestinationId,
        objectKey: key,
        createdBy: actor,
      },
    });

    // Everything the run was handed that must never reach the persisted/notified output.
    let dbPassword: string | undefined;
    try {
      dbPassword = this.toSpec(db).credentials.password;
    } catch {
      /* undecryptable creds → the dump below fails and is recorded; nothing to redact */
    }
    const secrets = [dbPassword, dest.s3?.accessKey, dest.s3?.secretKey, dest.encryption?.key];
    const startedAt = Date.now();
    let succeeded = false;
    let errorText = "";
    let exitCode: number | null = null;
    let sizeBytes: bigint | null = null;
    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        buildBackupScript(this.toSpec(db), filename, dest),
        "backup",
        BACKUP_TIMEOUT_MS,
      );
      succeeded = r.exitCode === 0;
      exitCode = r.exitCode;
      if (!succeeded) errorText = r.output;
      sizeBytes = succeeded ? parseSize(r.output) : null;
      const completedAt = new Date();
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          status: succeeded ? "SUCCESS" : "FAILED",
          sizeBytes,
          exitCode,
          errorTail: succeeded ? null : scrubRunOutput(errorText, secrets),
          durationMs: completedAt.getTime() - startedAt,
          completedAt,
        },
      });
    } catch (e) {
      // Reaching here with succeeded already true means the dump ran (exit 0) but persisting the SUCCESS
      // row threw — the backup is now recorded FAILED, so force succeeded=false to fire backup_failed (not
      // a false backup_success for a FAILED row).
      succeeded = false;
      errorText = e instanceof Error ? e.message : String(e);
      const completedAt = new Date();
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          status: "FAILED",
          exitCode,
          errorTail: scrubRunOutput(errorText, secrets),
          durationMs: completedAt.getTime() - startedAt,
          completedAt,
        },
      });
    }
    await this.audit.log({ actor, action: "database.backup", target: db.id });
    if (!succeeded) {
      // Don't let a silent backup failure go unnoticed (best-effort). Scrub the agent output the same
      // way restore does (pg/mysql can echo row data / connection detail); only bucket/region — never
      // secrets — reach the ctx.
      // Throttled: first failure, then at most daily while it keeps failing (recovery is announced on the
      // next success). The persisted errorTail above is unaffected — every failed run is still recorded.
      if (await this.alerts.shouldNotifyFailure("database", db.id)) {
        await this.notifications
          .fireForEvent(db.teamId, "backup_failed", {
            dbId: db.id,
            dbName: db.name,
            engine: db.engine,
            version: db.version,
            destType: dest.type,
            bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
            region: dest.type === "S3" && dest.s3 ? dest.s3.region : "",
            errorTail: scrubRunOutput(errorText, secrets),
          })
          .catch(() => undefined);
      }
    } else {
      // sizeBytes is a Prisma BigInt — stringify before it reaches the notification queue's JSON payload
      // (JSON.stringify throws on a raw BigInt). No agent output in ctx on success (nothing to scrub).
      await this.notifications
        .fireForEvent(db.teamId, "backup_success", {
          dbId: db.id,
          dbName: db.name,
          engine: db.engine,
          version: db.version,
          destType: dest.type,
          bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
          region: dest.type === "S3" && dest.s3 ? dest.s3.region : "",
          sizeBytes: sizeBytes != null ? sizeBytes.toString() : "",
        })
        .catch(() => undefined);
      // First success after a notified failure / missing-backup alert → one recovery notice.
      await this.alerts
        .recover("database", db.id, db.teamId, { dbId: db.id, dbName: db.name, engine: db.engine, version: db.version })
        .catch(() => undefined);
    }
    await this.prune(db);
    return this.prisma.backup.findUnique({ where: { id: backup.id } }) as Promise<Backup>;
  }

  /** Prune successful backups: delete any beyond the newest `backupRetention` (count) OR — when
   *  backupRetentionDays is set — older than that many days. The single newest backup is always kept. */
  async prune(db: Database): Promise<void> {
    const all = await this.prisma.backup.findMany({
      where: { databaseId: db.id, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    });
    const cutoff = db.backupRetentionDays != null ? Date.now() - db.backupRetentionDays * 86_400_000 : null;
    const stale = all.filter(
      (b, i) => i !== 0 && (i >= db.backupRetention || (cutoff != null && b.createdAt.getTime() < cutoff)),
    );
    for (const b of stale) {
      // Each stale backup may live in a different destination — delete from its own.
      const spec = await this.destinationSpecById(b.destinationId);
      await this.agentWs
        .sendCommand(db.serverId, buildDeleteBackupScript(db.id, b.filename, spec), "backup")
        .catch(() => undefined);
      await this.prisma.backup.delete({ where: { id: b.id } });
    }
  }
}

/**
 * The backup script's last line is the size: `stat -c %s` (a number) for LOCAL,
 * or `mc stat --json` (a JSON object with a numeric `size`) for S3.
 */
export function parseSize(output: string): bigint | null {
  const text = output.trim();
  const m = text.match(/"size"\s*:\s*(\d+)/);
  if (m) return BigInt(m[1]);
  const last = text.split(/\s+/).filter(Boolean).pop();
  return last && /^\d+$/.test(last) ? BigInt(last) : null;
}
