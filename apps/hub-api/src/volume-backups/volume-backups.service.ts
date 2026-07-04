import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Application, Role, VolumeBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { appVolumeName } from "../deploy/deploy-script";
import { buildVolumeDeleteScript, buildVolumeRestoreScript } from "./volume-backup-script";
import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";
import type { VolumeBackupConfigInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

export interface VolumeBackupView {
  id: string;
  volumeName: string;
  status: string;
  filename: string;
  sizeBytes: string | null;
  createdBy: string;
  createdAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class VolumeBackupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: VolumeBackupRunnerService,
    private readonly scheduler: VolumeBackupSchedulerService,
  ) {}

  async backupNow(userId: string, appId: string): Promise<VolumeBackupView[]> {
    await this.requireWrite(userId, appId);
    const rows = await this.runner.runBackup(appId, userId);
    return rows.map((b) => this.view(b));
  }

  async list(userId: string, appId: string): Promise<VolumeBackupView[]> {
    await this.require(userId, appId);
    const rows = await this.prisma.volumeBackup.findMany({
      where: { appId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((b) => this.view(b));
  }

  async restore(userId: string, appId: string, backupId: string): Promise<void> {
    const app = await this.requireWrite(userId, appId);
    const backup = await this.prisma.volumeBackup.findFirst({ where: { id: backupId, appId } });
    if (!backup) throw new NotFoundException("backup not found");
    // Read from the backup's OWN destination, not the app's current one.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    await this.agentWs.sendCommand(
      app.serverId,
      buildVolumeRestoreScript(app.id, backup.volumeName, appVolumeName(app, backup.volumeName), backup.filename, dest),
      "backup",
      300_000,
    );
    await this.audit.log({ actor: userId, action: "app.volume_restore", target: appId, meta: { backupId } });
  }

  async remove(userId: string, appId: string, backupId: string): Promise<void> {
    const app = await this.requireWrite(userId, appId);
    const backup = await this.prisma.volumeBackup.findFirst({ where: { id: backupId, appId } });
    if (!backup) throw new NotFoundException("backup not found");
    // Delete from the backup's OWN destination, not the app's current one.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    await this.agentWs
      .sendCommand(app.serverId, buildVolumeDeleteScript(app.id, backup.volumeName, backup.filename, dest), "backup")
      .catch(() => undefined);
    await this.prisma.volumeBackup.delete({ where: { id: backup.id } });
    await this.audit.log({ actor: userId, action: "app.volume_backup.remove", target: appId });
  }

  async setSchedule(userId: string, appId: string, cfg: VolumeBackupConfigInput): Promise<Application> {
    await this.requireWrite(userId, appId);
    const app = await this.prisma.application.update({
      where: { id: appId },
      data: {
        volumeBackupEnabled: cfg.enabled,
        volumeBackupIntervalHours: cfg.intervalHours ?? null,
        volumeBackupRetention: cfg.retention ?? undefined,
        ...(cfg.destinationId !== undefined ? { volumeBackupDestinationId: cfg.destinationId || null } : {}),
      },
    });
    if (app.volumeBackupEnabled && app.volumeBackupIntervalHours) {
      await this.scheduler.schedule(appId, app.volumeBackupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(appId);
    }
    await this.audit.log({ actor: userId, action: "app.volume_backup.schedule", target: appId });
    return app;
  }

  private view(b: VolumeBackup): VolumeBackupView {
    return {
      id: b.id,
      volumeName: b.volumeName,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    };
  }

  private async require(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    if (!(await this.access.teamRole(userId, app.teamId))) throw new ForbiddenException("not a member of this team");
    return app;
  }

  private async requireWrite(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    await this.access.requireRole(userId, app.teamId, WRITE);
    return app;
  }
}
