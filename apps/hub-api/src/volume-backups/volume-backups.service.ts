import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { Application, VolumeBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { appVolumeName } from "../deploy/deploy-script";
import { buildVolumeDeleteScript, buildVolumeExportUrlScript, buildVolumeImportScript, buildVolumeRestoreScript, parseShareUrl } from "./volume-backup-script";
import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";
import type { VolumeBackupConfigInput, VolumeImportFromUrlInput } from "./dto";

export const VolumeBackupViewSchema = z.object({
  id: z.string(),
  volumeName: z.string(),
  status: z.string(),
  filename: z.string(),
  sizeBytes: z.string().nullable(),
  destinationId: z.string().nullable(), // which destination stored it (null = local disk)
  destinationType: z.string().nullable(), // "S3" | "LOCAL" | null — only an S3 one can export a migration URL
  createdBy: z.string(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});
export type VolumeBackupView = z.infer<typeof VolumeBackupViewSchema>;

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
    return this.toViews(rows);
  }

  async list(userId: string, appId: string): Promise<VolumeBackupView[]> {
    await this.require(userId, appId);
    const rows = await this.prisma.volumeBackup.findMany({
      where: { appId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return this.toViews(rows);
  }

  /** Project rows to views, resolving each backup's destination TYPE (so the UI can offer export
   *  only for S3-stored backups) with a single batched lookup (no per-row query, no cred decrypt). */
  private async toViews(rows: VolumeBackup[]): Promise<VolumeBackupView[]> {
    const ids = [...new Set(rows.map((r) => r.destinationId).filter((x): x is string => !!x))];
    const dests = ids.length
      ? await this.prisma.backupDestination.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })
      : [];
    const typeById = new Map(dests.map((d) => [d.id, d.type]));
    return rows.map((b) => this.view(b, b.destinationId ? typeById.get(b.destinationId) ?? null : null));
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

  /**
   * Produce a short-lived presigned download URL for an S3 volume backup, so it can be fed to
   * import-from-URL on another server (migration). S3-only — a LOCAL-disk backup has no presignable
   * object. The URL grants time-limited download of the backup data → it is returned to the caller
   * but NEVER logged/audited.
   */
  async exportUrl(userId: string, appId: string, backupId: string, expireHours: number): Promise<{ url: string; expiresAt: Date }> {
    const app = await this.requireWrite(userId, appId);
    const backup = await this.prisma.volumeBackup.findFirst({ where: { id: backupId, appId } });
    if (!backup) throw new NotFoundException("backup not found");
    // Read from the backup's OWN destination, not the app's current one.
    const dest = await this.runner.destinationSpecById(backup.destinationId);
    if (dest.type !== "S3") throw new BadRequestException("a migration URL needs an S3 backup destination");
    const r = await this.agentWs.sendCommand(
      app.serverId,
      buildVolumeExportUrlScript(app.id, backup.volumeName, backup.filename, dest, `${expireHours}h`),
      "backup",
      60_000,
    );
    if (r.exitCode !== 0) throw new BadGatewayException("could not generate a migration URL");
    const url = parseShareUrl(r.output);
    if (!url) throw new BadGatewayException("could not generate a migration URL");
    // Audit the action but NEVER the URL (it grants time-limited download of the backup data).
    await this.audit.log({ actor: userId, action: "app.volume_export", target: appId, meta: { backupId, expireHours } });
    return { url, expiresAt: new Date(Date.now() + expireHours * 3600_000) };
  }

  /**
   * Import an app volume's data from an external tar(.gz) URL (migrator data-pull).
   * OVERWRITES the target volume. The volume must be one the app declares (no writing to an
   * arbitrary docker volume). The agent fetches the URL on the target server (no hub proxying).
   */
  async importFromUrl(userId: string, appId: string, input: VolumeImportFromUrlInput): Promise<void> {
    const app = await this.requireWrite(userId, appId);
    const declared =
      Array.isArray(app.volumes) &&
      (app.volumes as Array<{ name?: string }>).some((v) => v?.name === input.volumeName);
    if (!declared) throw new BadRequestException("unknown volume for this app");
    const r = await this.agentWs.sendCommand(
      app.serverId,
      buildVolumeImportScript(appVolumeName(app, input.volumeName), input.url, {
        encrypted: input.encrypted,
        key: input.encryptionKey ?? "",
        gzip: input.gzip,
      }),
      "backup",
      300_000,
    );
    // sendCommand resolves even on a non-zero exit (it only rejects on agent offline/timeout). A failed
    // import must NOT be reported as success — the script stages to a temp file so the volume is untouched
    // on a fetch/decode failure (see buildVolumeImportScript); surface the failure so the caller/UI learns.
    if (r.exitCode !== 0) {
      await this.audit.log({ actor: userId, action: "app.volume_import_failed", target: appId, meta: { volumeName: input.volumeName } });
      throw new BadGatewayException("volume import failed");
    }
    await this.audit.log({ actor: userId, action: "app.volume_import", target: appId, meta: { volumeName: input.volumeName } });
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

  private view(b: VolumeBackup, destinationType: string | null): VolumeBackupView {
    return {
      id: b.id,
      volumeName: b.volumeName,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      destinationId: b.destinationId,
      destinationType,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    };
  }

  private async require(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    if (!(await this.access.teamRole(userId, app.teamId))) throw new ForbiddenException("not a member of this team");
    // Per-resource scoping: a restricted member can't read volume backups of an app they can't access.
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  private async requireWrite(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("app not found");
    await this.access.requirePermission(userId, app.teamId, "backups");
    return app;
  }
}
