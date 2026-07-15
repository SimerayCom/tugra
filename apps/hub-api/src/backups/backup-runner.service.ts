import { Injectable, Logger } from "@nestjs/common";
import { Backup, Database } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import {
  supportsBackup,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "../databases/database-script";
import {
  backupFilename,
  buildBackupScript,
  buildDeleteBackupScript,
  scrubRestoreOutput,
} from "./backup-script";
import { LOCAL_DEST, objectKey, type DestinationSpec } from "./destination";

const BACKUP_TIMEOUT_MS = 300_000; // dumps can be slow

@Injectable()
export class BackupRunnerService {
  private readonly logger = new Logger(BackupRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
  ) {}

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
    if (!d || d.type !== "S3") return LOCAL_DEST;
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
      encryption: {
        enabled: d.encryptionEnabled,
        key: d.encryptionKey ? this.crypto.decrypt(d.encryptionKey) : "",
      },
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

    let succeeded = false;
    let errorText = "";
    let sizeBytes: bigint | null = null;
    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        buildBackupScript(this.toSpec(db), filename, dest),
        "backup",
        BACKUP_TIMEOUT_MS,
      );
      succeeded = r.exitCode === 0;
      if (!succeeded) errorText = r.output;
      sizeBytes = succeeded ? parseSize(r.output) : null;
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          status: succeeded ? "SUCCESS" : "FAILED",
          sizeBytes,
          completedAt: new Date(),
        },
      });
    } catch (e) {
      // Reaching here with succeeded already true means the dump ran (exit 0) but persisting the SUCCESS
      // row threw — the backup is now recorded FAILED, so force succeeded=false to fire backup_failed (not
      // a false backup_success for a FAILED row).
      succeeded = false;
      errorText = e instanceof Error ? e.message : String(e);
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: { status: "FAILED", completedAt: new Date() },
      });
    }
    await this.audit.log({ actor, action: "database.backup", target: db.id });
    if (!succeeded) {
      // Don't let a silent backup failure go unnoticed (best-effort). Scrub the agent output the same
      // way restore does (pg/mysql can echo row data / connection detail); only bucket/region — never
      // secrets — reach the ctx.
      await this.notifications
        .fireForEvent(db.teamId, "backup_failed", {
          dbId: db.id,
          dbName: db.name,
          engine: db.engine,
          version: db.version,
          destType: dest.type,
          bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
          region: dest.type === "S3" && dest.s3 ? dest.s3.region : "",
          errorTail: scrubRestoreOutput(errorText),
        })
        .catch(() => undefined);
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
    }
    await this.prune(db);
    return this.prisma.backup.findUnique({ where: { id: backup.id } }) as Promise<Backup>;
  }

  /** Keep the newest `backupRetention` successful backups; delete older files + rows. */
  async prune(db: Database): Promise<void> {
    const all = await this.prisma.backup.findMany({
      where: { databaseId: db.id, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    });
    const stale = all.slice(db.backupRetention);
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
function parseSize(output: string): bigint | null {
  const text = output.trim();
  const m = text.match(/"size"\s*:\s*(\d+)/);
  if (m) return BigInt(m[1]);
  const last = text.split(/\s+/).filter(Boolean).pop();
  return last && /^\d+$/.test(last) ? BigInt(last) : null;
}
