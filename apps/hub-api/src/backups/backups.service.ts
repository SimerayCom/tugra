import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Backup, Database, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildDeleteBackupScript, buildRestoreScript } from "./backup-script";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import type { BackupConfigInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

export interface BackupView {
  id: string;
  status: string;
  filename: string;
  sizeBytes: string | null; // BigInt serialized
  createdBy: string;
  createdAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class BackupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: BackupRunnerService,
    private readonly scheduler: BackupSchedulerService,
  ) {}

  async backupNow(userId: string, dbId: string): Promise<BackupView> {
    await this.requireWrite(userId, dbId);
    const backup = await this.runner.runBackup(dbId, userId);
    return this.view(backup);
  }

  async list(userId: string, dbId: string): Promise<BackupView[]> {
    await this.require(userId, dbId);
    const backups = await this.prisma.backup.findMany({
      where: { databaseId: dbId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return backups.map((b) => this.view(b));
  }

  async restore(userId: string, dbId: string, backupId: string): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    const backup = await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: dbId } });
    if (!backup) throw new NotFoundException("backup not found");
    await this.agentWs.sendCommand(
      db.serverId,
      buildRestoreScript(this.runner.toSpec(db), backup.filename),
      300_000,
    );
    await this.audit.log({ actor: userId, action: "database.restore", target: dbId, meta: { backupId } });
  }

  async removeBackup(userId: string, dbId: string, backupId: string): Promise<void> {
    const db = await this.requireWrite(userId, dbId);
    const backup = await this.prisma.backup.findFirst({ where: { id: backupId, databaseId: dbId } });
    if (!backup) throw new NotFoundException("backup not found");
    await this.agentWs
      .sendCommand(db.serverId, buildDeleteBackupScript(dbId, backup.filename))
      .catch(() => undefined);
    await this.prisma.backup.delete({ where: { id: backup.id } });
    await this.audit.log({ actor: userId, action: "database.backup.remove", target: dbId });
  }

  async setSchedule(userId: string, dbId: string, cfg: BackupConfigInput): Promise<Database> {
    await this.requireWrite(userId, dbId);
    const db = await this.prisma.database.update({
      where: { id: dbId },
      data: {
        backupEnabled: cfg.enabled,
        backupIntervalHours: cfg.intervalHours ?? null,
        backupRetention: cfg.retention ?? undefined,
      },
    });
    if (db.backupEnabled && db.backupIntervalHours) {
      await this.scheduler.schedule(dbId, db.backupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(dbId);
    }
    await this.audit.log({ actor: userId, action: "database.backup.schedule", target: dbId });
    return db;
  }

  // ── helpers ──
  private view(b: Backup): BackupView {
    return {
      id: b.id,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
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
    return db;
  }

  private async requireWrite(userId: string, dbId: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id: dbId } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requireRole(userId, db.teamId, WRITE);
    return db;
  }
}
