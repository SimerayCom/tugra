import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Application, VolumeBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { loadProjectCtx } from "../common/resource-project";
import { assertNoActiveMove } from "../common/app-move-guard";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { appVolumeName } from "../deploy/deploy-script";
import { buildVolumeDeleteScript, buildVolumeExportUrlScript, buildVolumeImportScript, buildVolumeRestoreScript, parseShareUrl } from "./volume-backup-script";
import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";
import { BackupAlertsService } from "../backups/backup-alerts.service";
import { GIB, planRetention } from "../backups/retention";
import { nextRuns } from "../common/cron";
import type { VolumeBackupConfigInput, VolumeImportFromUrlInput, VolumePolicyInput } from "./dto";
import { SHARED_POOL, policyAlertId, poolBudgetGb, poolKeyOf } from "./policy";

export const VolumeBackupViewSchema = z.object({
  id: z.string(),
  volumeName: z.string(),
  status: z.string(),
  filename: z.string(),
  sizeBytes: z.string().nullable(),
  destinationId: z.string().nullable(), // which destination stored it (null = local disk)
  destinationType: z.string().nullable(), // "S3" | "LOCAL" | null — only an S3 one can export a migration URL
  hostServerId: z.string().nullable(), // LOCAL backups: the server whose disk holds the file; null = the app's current server
  onOtherServer: z.boolean(), // a LOCAL backup stranded on a previous server after an app move: it cannot be restored here
  createdBy: z.string(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
  // Run outcome. exitCode/durationMs are non-sensitive; errorTail (scrubbed command output) is WRITER-ONLY —
  // null for read-only members, exactly like Restore.errorTail.
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  errorTail: z.string().nullable(),
});
export type VolumeBackupView = z.infer<typeof VolumeBackupViewSchema>;

export const VolumePolicyViewSchema = z.object({
  volumeName: z.string(),
  enabled: z.boolean(),
  intervalHours: z.number().nullable(),
  cron: z.string().nullable(),
  retention: z.number().nullable(),
  retentionDays: z.number().nullable(),
  maxSizeGb: z.number().nullable(),
});
export type VolumePolicyView = z.infer<typeof VolumePolicyViewSchema>;

// GET apps/:appId/volume-backups/config — the app-wide schedule + retention, its per-volume policies, and the
// storage meter per size pool. No secrets. (Deliberately NOT folded into the huge Application view.)
export const VolumeBackupConfigViewSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().nullable(),
  cron: z.string().nullable(),
  retention: z.number(),
  retentionDays: z.number().nullable(),
  maxSizeGb: z.number().nullable(),
  destinationId: z.string().nullable(),
  // null = the implicit server-disk path (unencrypted); else whether the chosen destination encrypts.
  destinationEncrypted: z.boolean().nullable(),
  policies: z.array(VolumePolicyViewSchema),
  usage: z.array(
    z.object({
      pool: z.string(), // "app" (the shared pool) or a volume name that has its own size budget
      volume: z.string().nullable(), // null = the shared app pool; else the volume that owns this pool (disambiguates a volume named "app")
      usedBytes: z.string(),
      backupCount: z.number(),
      unknownSizeCount: z.number(),
      budgetGb: z.number().nullable(),
      overBudget: z.boolean(),
    }),
  ),
  nextRun: z.string().nullable(), // next cron fire (ISO); null for an interval schedule
});
export type VolumeBackupConfigView = z.infer<typeof VolumeBackupConfigViewSchema>;

/** A LOCAL backup file stranded on a previous server (stamped by an app move's cutover; NULL = the current server). */
function onOtherServer(b: { hostServerId?: string | null }, currentServerId: string): boolean {
  return b.hostServerId != null && b.hostServerId !== currentServerId;
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
    private readonly alerts: BackupAlertsService,
  ) {}

  // In-flight restores keyed by `${appId}:${volumeName}` — a second restore to the same volume is rejected
  // (two concurrent wipe+extracts into one volume corrupt each other). Single-hub, in-memory by design.
  private readonly restoreInFlight = new Set<string>();

  async backupNow(userId: string, appId: string): Promise<VolumeBackupView[]> {
    const app = await this.requireWrite(userId, appId);
    const rows = await this.runner.runBackup(appId, userId);
    return this.toViews(rows, true, app.serverId); // requireWrite above → the caller is a writer
  }

  async list(userId: string, appId: string): Promise<VolumeBackupView[]> {
    const app = await this.require(userId, appId);
    const rows = await this.prisma.volumeBackup.findMany({
      where: { appId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // errorTail is command output → writers only (same gate as requireWrite).
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    return this.toViews(rows, perms?.has("backups") ?? false, app.serverId);
  }

  /** Project rows to views, resolving each backup's destination TYPE (so the UI can offer export
   *  only for S3-stored backups) with a single batched lookup (no per-row query, no cred decrypt). */
  private async toViews(rows: VolumeBackup[], canWrite: boolean, currentServerId: string): Promise<VolumeBackupView[]> {
    const ids = [...new Set(rows.map((r) => r.destinationId).filter((x): x is string => !!x))];
    const dests = ids.length
      ? await this.prisma.backupDestination.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } })
      : [];
    const typeById = new Map(dests.map((d) => [d.id, d.type]));
    return rows.map((b) => this.view(b, b.destinationId ? typeById.get(b.destinationId) ?? null : null, canWrite, currentServerId));
  }

  async restore(userId: string, appId: string, backupId: string): Promise<void> {
    const app = await this.requireWrite(userId, appId);
    await assertNoActiveMove(this.prisma, appId); // a move is copying these volumes: a restore would race the copy
    const backup = await this.prisma.volumeBackup.findFirst({ where: { id: backupId, appId } });
    if (!backup) throw new NotFoundException("backup not found");
    // One restore per (app, volume) at a time — two concurrent wipe+extracts into the same volume corrupt
    // each other.
    const lockKey = `${appId}:${backup.volumeName}`;
    if (this.restoreInFlight.has(lockKey)) throw new ConflictException("a restore is already running for this volume");
    this.restoreInFlight.add(lockKey);
    try {
      // Read from the backup's OWN destination, not the app's current one.
      const dest = await this.runner.destinationSpecById(backup.destinationId);
      // A LOCAL file lives on the disk of the server that ran the backup; after an app move that is no longer this
      // app's server, so the file cannot be read here (an S3 backup is unaffected).
      if (dest.type !== "S3" && onOtherServer(backup, app.serverId)) {
        throw new ConflictException({ statusCode: 409, message: `this local backup was made on another server (${backup.hostServerId}) and is not on this app's current server`, code: "backup_on_other_server" });
      }
      const restoreId = randomUUID().replace(/-/g, "");
      const rbVolume = `tugra_restore_rb_${restoreId}`;
      // Scale the timeout with the backup size (min 10 min, +1 min / 100 MB) so a large restore — which now
      // also snapshots the live volume — is not SIGKILLed mid-extract. The agent uses this same value as
      // its kill timer.
      const timeoutMs = 600_000 + Math.ceil(Number(backup.sizeBytes ?? 0) / (100 * 1024 * 1024)) * 60_000;
      let r: { exitCode: number; output: string };
      try {
        r = await this.agentWs.sendCommand(
          app.serverId,
          buildVolumeRestoreScript(app.id, backup.volumeName, appVolumeName(app, backup.volumeName), backup.filename, dest, restoreId),
          "backup",
          timeoutMs,
        );
      } catch (e) {
        // Agent offline / hub timeout / disconnect: the outcome is unknown and is NOT a success. A timeout
        // after dispatch may have left the volume mid-restore (the snapshot volume survives for recovery).
        await this.audit.log({ actor: userId, action: "app.volume_restore_failed", target: appId, meta: { backupId, restoreId, rbVolume, error: "dispatch" } });
        throw e;
      }
      // A failed restore must NEVER be recorded as success. The script exits 0 ONLY from its success branch
      // (every failure exits 70/71/72, or is SIGKILLed to a non-zero code), so the hub keys off the EXIT
      // CODE — not an end-of-output marker the agent's output cap could truncate away.
      if (r.exitCode !== 0) {
        await this.audit.log({ actor: userId, action: "app.volume_restore_failed", target: appId, meta: { backupId, restoreId, rbVolume, exitCode: r.exitCode } });
        // 72 = aborted before the wipe; 71 = rolled back from the snapshot — both leave the old data intact.
        // Any other code (70 rollback-also-failed, -1/137 SIGKILL, unexpected) means the outcome is uncertain.
        const preserved = r.exitCode === 71 || r.exitCode === 72;
        throw new BadGatewayException(
          preserved
            ? "volume restore failed; the existing volume data was preserved"
            : `volume restore failed and the outcome is uncertain — the volume may be partially restored; recover from docker volume ${rbVolume} if it is present`,
        );
      }
      await this.audit.log({ actor: userId, action: "app.volume_restore", target: appId, meta: { backupId } });
    } finally {
      this.restoreInFlight.delete(lockKey);
    }
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
   * `opts.timeoutMs` lets the migration ingest scale the restore window to the artifact size (default 5 min).
   */
  async importFromUrl(userId: string, appId: string, input: VolumeImportFromUrlInput, opts: { timeoutMs?: number; maxDecodedBytes?: number } = {}): Promise<void> {
    const res = await this.importFromUrlDetailed(userId, appId, input, opts);
    if (!res.ok) throw new BadGatewayException("volume import failed");
  }

  /**
   * Same as {@link importFromUrl} but RETURNS the outcome instead of throwing on a non-zero exit, so the
   * migration ingest can record a useful (capped) failure reason on its data task rather than a bare
   * "volume import failed". The caller MUST scrub the returned `tail` before persisting it anywhere the
   * untrusted source host can read (it may echo the signed URL curl printed on error).
   */
  async importFromUrlDetailed(
    userId: string,
    appId: string,
    input: VolumeImportFromUrlInput,
    opts: { timeoutMs?: number; maxDecodedBytes?: number } = {},
  ): Promise<{ ok: boolean; exitCode: number; tail: string }> {
    const app = await this.requireWrite(userId, appId);
    await assertNoActiveMove(this.prisma, appId); // the import overwrites a volume a move may be copying
    const declared =
      Array.isArray(app.volumes) &&
      (app.volumes as Array<{ name?: string }>).some((v) => v?.name === input.volumeName);
    if (!declared) throw new BadRequestException("unknown volume for this app");
    const r = await this.agentWs.sendCommand(
      app.serverId,
      buildVolumeImportScript(appVolumeName(app, input.volumeName), input.url, randomUUID().replace(/-/g, ""), {
        encrypted: input.encrypted,
        key: input.encryptionKey ?? "",
        gzip: input.gzip,
        maxDecodedBytes: opts.maxDecodedBytes, // untrusted-tarball decoded cap (migration ingest only)
      }),
      "backup",
      opts.timeoutMs ?? 300_000,
    );
    // sendCommand resolves even on a non-zero exit (it only rejects on agent offline/timeout). A failed
    // import must NOT be reported as success — the script stages to a temp file so the volume is untouched
    // on a fetch/decode failure (see buildVolumeImportScript); surface the failure so the caller/UI learns.
    if (r.exitCode !== 0) {
      await this.audit.log({ actor: userId, action: "app.volume_import_failed", target: appId, meta: { volumeName: input.volumeName } });
      return { ok: false, exitCode: r.exitCode, tail: (r.output ?? "").slice(0, 2000) };
    }
    await this.audit.log({ actor: userId, action: "app.volume_import", target: appId, meta: { volumeName: input.volumeName } });
    return { ok: true, exitCode: 0, tail: "" };
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
    const cur = await this.requireWrite(userId, appId);
    // The destination must belong to the app's team (a foreign destination id would store this team's data in
    // another team's bucket).
    if (cfg.destinationId) {
      const dest = await this.prisma.backupDestination.findFirst({ where: { id: cfg.destinationId, teamId: cur.teamId }, select: { id: true } });
      if (!dest) throw new BadRequestException("backup destination not found in this team");
    }
    // cron / retentionDays / maxSizeGb: absent leaves the stored value, null clears it. intervalHours keeps its
    // historical "absent = cleared" semantics. A cron wins over the interval.
    const cron = cfg.cron !== undefined ? cfg.cron : cur.volumeBackupCron;
    const intervalHours = cfg.intervalHours ?? null;
    if (cfg.enabled && !cron && !intervalHours) {
      throw new BadRequestException("an enabled schedule needs intervalHours or cron");
    }
    const app = await this.prisma.application.update({
      where: { id: appId },
      data: {
        volumeBackupEnabled: cfg.enabled,
        volumeBackupIntervalHours: intervalHours,
        ...(cfg.cron !== undefined ? { volumeBackupCron: cfg.cron } : {}),
        volumeBackupRetention: cfg.retention ?? undefined,
        ...(cfg.retentionDays !== undefined ? { volumeBackupRetentionDays: cfg.retentionDays } : {}),
        ...(cfg.maxSizeGb !== undefined ? { volumeBackupMaxSizeGb: cfg.maxSizeGb } : {}),
        ...(cfg.destinationId !== undefined ? { volumeBackupDestinationId: cfg.destinationId || null } : {}),
      },
    });
    if (app.volumeBackupEnabled && app.volumeBackupCron) {
      await this.scheduler.scheduleCron(appId, app.volumeBackupCron);
    } else if (app.volumeBackupEnabled && app.volumeBackupIntervalHours) {
      await this.scheduler.schedule(appId, app.volumeBackupIntervalHours * 3600);
    } else {
      await this.scheduler.unschedule(appId);
    }
    // Per-volume jobs follow the app's enabled flag and their own policy rows.
    await this.scheduler.syncPolicyJobs(appId);
    // Re-arm the missing-backup watchdog from now + clear stale alerts (see BackupAlertsService.onScheduleChanged).
    await this.alerts.onScheduleChanged("volume", appId);
    await this.audit.log({ actor: userId, action: "app.volume_backup.schedule", target: appId });
    return app;
  }

  /** The app-wide schedule/retention, per-volume policies and per-pool storage usage (read access). */
  async getConfig(userId: string, appId: string): Promise<VolumeBackupConfigView> {
    const app = await this.require(userId, appId);
    const policies = await this.prisma.volumeBackupPolicy.findMany({ where: { appId }, orderBy: { volumeName: "asc" } });
    const declared = new Set(this.runner.volumesOf(app).map((v) => v.name));
    const rows = (await this.prisma.volumeBackup.findMany({ where: { appId, status: "SUCCESS" }, orderBy: { createdAt: "desc" } })).filter((b) => declared.has(b.volumeName));
    const polBy = new Map(policies.map((p) => [p.volumeName, p]));
    const pools = new Map<string, typeof rows>([[SHARED_POOL, []]]);
    for (const p of policies) if (p.maxSizeGb != null && declared.has(p.volumeName)) pools.set(p.volumeName, []);
    for (const b of rows) {
      pools.get(poolKeyOf(polBy, b.volumeName))!.push(b);
    }
    const usage = [...pools].map(([pool, rs]) => {
      const gb = poolBudgetGb(pool, app.volumeBackupMaxSizeGb, polBy);
      const plan = planRetention(
        rs.map((b) => ({ id: b.id, series: b.volumeName, createdAt: b.createdAt, sizeBytes: b.sizeBytes })),
        { keep: app.volumeBackupRetention, maxAgeDays: app.volumeBackupRetentionDays, maxBytes: gb != null ? BigInt(gb) * GIB : null },
        Date.now(),
        (series) => ({ keep: polBy.get(series)?.retention ?? app.volumeBackupRetention, maxAgeDays: polBy.get(series)?.retentionDays ?? app.volumeBackupRetentionDays }),
      );
      const used = rs.reduce((n, b) => n + (b.sizeBytes ?? 0n), 0n);
      return {
        pool: pool === SHARED_POOL ? "app" : pool,
        volume: pool === SHARED_POOL ? null : pool,
        usedBytes: used.toString(),
        backupCount: rs.length,
        unknownSizeCount: rs.filter((b) => b.sizeBytes == null).length,
        budgetGb: gb,
        overBudget: plan.overBudget,
      };
    });
    let destinationEncrypted: boolean | null = null;
    if (app.volumeBackupDestinationId) {
      const d = await this.prisma.backupDestination.findUnique({ where: { id: app.volumeBackupDestinationId }, select: { encryptionEnabled: true } });
      destinationEncrypted = d ? d.encryptionEnabled : null;
    }
    return {
      enabled: app.volumeBackupEnabled,
      intervalHours: app.volumeBackupIntervalHours,
      cron: app.volumeBackupCron,
      retention: app.volumeBackupRetention,
      retentionDays: app.volumeBackupRetentionDays,
      maxSizeGb: app.volumeBackupMaxSizeGb,
      destinationId: app.volumeBackupDestinationId,
      destinationEncrypted,
      policies: policies.map((p) => this.policyView(p)),
      usage,
      nextRun: app.volumeBackupCron ? (nextRuns(app.volumeBackupCron, 1)[0]?.toISOString() ?? null) : null,
    };
  }

  /** Create/replace the per-volume policy. Absent fields mean "inherit the app's" (stored null). */
  async putPolicy(userId: string, appId: string, volumeName: string, input: VolumePolicyInput): Promise<VolumePolicyView> {
    const app = await this.requireWrite(userId, appId);
    if (!this.runner.volumesOf(app).some((v) => v.name === volumeName)) throw new NotFoundException("unknown volume for this app");
    const data = {
      enabled: input.enabled,
      intervalHours: input.intervalHours ?? null,
      cron: input.cron ?? null,
      retention: input.retention ?? null,
      retentionDays: input.retentionDays ?? null,
      maxSizeGb: input.maxSizeGb ?? null,
    };
    const row = await this.prisma.volumeBackupPolicy.upsert({
      where: { appId_volumeName: { appId, volumeName } },
      create: { appId, volumeName, ...data },
      update: data,
    });
    await this.scheduler.syncPolicyJobs(appId);
    await this.alerts.onScheduleChanged("volume", policyAlertId(appId, volumeName));
    await this.audit.log({ actor: userId, action: "app.volume_backup.policy", target: appId, meta: { volumeName } });
    return this.policyView(row);
  }

  /** Remove the per-volume policy (the volume reverts to the app's schedule + retention). */
  async deletePolicy(userId: string, appId: string, volumeName: string): Promise<void> {
    await this.requireWrite(userId, appId);
    const row = await this.prisma.volumeBackupPolicy.findUnique({ where: { appId_volumeName: { appId, volumeName } } });
    if (!row) throw new NotFoundException("no policy for this volume");
    await this.prisma.volumeBackupPolicy.delete({ where: { id: row.id } });
    await this.scheduler.unschedulePolicy(row.id);
    await this.scheduler.syncPolicyJobs(appId);
    await this.alerts.onScheduleChanged("volume", policyAlertId(appId, volumeName));
    await this.audit.log({ actor: userId, action: "app.volume_backup.policy", target: appId, meta: { volumeName, removed: true } });
  }

  private policyView(p: { volumeName: string; enabled: boolean; intervalHours: number | null; cron: string | null; retention: number | null; retentionDays: number | null; maxSizeGb: number | null }): VolumePolicyView {
    return {
      volumeName: p.volumeName,
      enabled: p.enabled,
      intervalHours: p.intervalHours,
      cron: p.cron,
      retention: p.retention,
      retentionDays: p.retentionDays,
      maxSizeGb: p.maxSizeGb,
    };
  }

  private view(b: VolumeBackup, destinationType: string | null, canWrite: boolean, currentServerId: string): VolumeBackupView {
    return {
      id: b.id,
      volumeName: b.volumeName,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      destinationId: b.destinationId,
      destinationType,
      hostServerId: b.hostServerId ?? null,
      onOtherServer: destinationType !== "S3" && onOtherServer(b, currentServerId),
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
      exitCode: b.exitCode,
      durationMs: b.durationMs,
      errorTail: canWrite ? b.errorTail : null,
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
