import { Injectable, Logger } from "@nestjs/common";
import { Backup, Database } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
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
    if (!db.backupDestinationId) return LOCAL_DEST;
    const d = await this.prisma.backupDestination.findUnique({
      where: { id: db.backupDestinationId },
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

    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        buildBackupScript(this.toSpec(db), filename, dest),
        BACKUP_TIMEOUT_MS,
      );
      const ok = r.exitCode === 0;
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          sizeBytes: ok ? parseSize(r.output) : null,
          completedAt: new Date(),
        },
      });
    } catch {
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: { status: "FAILED", completedAt: new Date() },
      });
    }
    await this.audit.log({ actor, action: "database.backup", target: db.id });
    await this.prune(db, dest);
    return this.prisma.backup.findUnique({ where: { id: backup.id } }) as Promise<Backup>;
  }

  /** Keep the newest `backupRetention` successful backups; delete older files + rows. */
  async prune(db: Database, dest?: DestinationSpec): Promise<void> {
    const spec = dest ?? (await this.destinationSpec(db));
    const all = await this.prisma.backup.findMany({
      where: { databaseId: db.id, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
    });
    const stale = all.slice(db.backupRetention);
    for (const b of stale) {
      await this.agentWs
        .sendCommand(db.serverId, buildDeleteBackupScript(db.id, b.filename, spec))
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
