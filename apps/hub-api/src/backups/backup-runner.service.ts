import { Injectable, Logger } from "@nestjs/common";
import { Backup, Database } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import {
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "../databases/database-script";
import {
  backupFilename,
  buildBackupScript,
  buildDeleteBackupScript,
} from "./backup-script";

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

  /** Run a dump for the database, record it, then prune to the retention limit. */
  async runBackup(databaseId: string, actor = "scheduler"): Promise<Backup> {
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db) throw new Error("database not found");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = backupFilename(db.engine as DbEngine, ts);
    const path = `/etc/tugra/backups/${db.id}/${filename}`;
    const backup = await this.prisma.backup.create({
      data: { databaseId: db.id, status: "RUNNING", filename, path, createdBy: actor },
    });

    try {
      const r = await this.agentWs.sendCommand(
        db.serverId,
        buildBackupScript(this.toSpec(db), filename),
        BACKUP_TIMEOUT_MS,
      );
      const ok = r.exitCode === 0;
      const size = ok ? parseSize(r.output) : null;
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          sizeBytes: size,
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
      await this.agentWs
        .sendCommand(db.serverId, buildDeleteBackupScript(db.id, b.filename))
        .catch(() => undefined);
      await this.prisma.backup.delete({ where: { id: b.id } });
    }
  }
}

/** The backup script prints `stat -c %s <file>` as its last line. */
function parseSize(output: string): bigint | null {
  const lines = output.trim().split(/\s+/).filter(Boolean);
  const last = lines[lines.length - 1];
  return last && /^\d+$/.test(last) ? BigInt(last) : null;
}
