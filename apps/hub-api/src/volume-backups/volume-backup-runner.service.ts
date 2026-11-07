import { Injectable } from "@nestjs/common";
import { Application, VolumeBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { appVolumeName, type AppVolume } from "../deploy/deploy-script";
import { LOCAL_DEST, objectKey, type DestinationSpec } from "../backups/destination";
import { scrubRunOutput } from "../backups/backup-script";
import { BackupAlertsService } from "../backups/backup-alerts.service";
import {
  buildVolumeBackupScript,
  buildVolumeDeleteScript,
  volumeBackupFilename,
  volumeBackupPath,
} from "./volume-backup-script";

const BACKUP_TIMEOUT_MS = 300_000;

@Injectable()
export class VolumeBackupRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
    private readonly alerts: BackupAlertsService,
  ) {}

  volumesOf(app: Application): AppVolume[] {
    return Array.isArray(app.volumes) ? (app.volumes as unknown as AppVolume[]) : [];
  }

  async destinationSpec(app: Application): Promise<DestinationSpec> {
    return this.destinationSpecById(app.volumeBackupDestinationId);
  }

  async destinationSpecById(destinationId: string | null): Promise<DestinationSpec> {
    if (!destinationId) return LOCAL_DEST;
    const d = await this.prisma.backupDestination.findUnique({ where: { id: destinationId } });
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
      encryption: { enabled: d.encryptionEnabled, key: d.encryptionKey ? this.crypto.decrypt(d.encryptionKey) : "" },
    };
  }

  /** Back up every named volume of the app, then prune to retention. */
  async runBackup(appId: string, actor = "scheduler"): Promise<VolumeBackup[]> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new Error("app not found");
    const vols = this.volumesOf(app);
    const dest = await this.destinationSpec(app);
    const out: VolumeBackup[] = [];
    // Aggregate the run so a single notification reports the whole app's backup (one fire per runBackup,
    // not one per volume). Any per-volume failure downgrades the run to failed (conservative).
    let anyFail = false;
    const failedVols: string[] = [];
    let totalSize = 0n;
    // Everything the run was handed that must never reach the persisted/notified output.
    const secrets = [dest.s3?.accessKey, dest.s3?.secretKey, dest.encryption?.key];

    for (const v of vols) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = volumeBackupFilename(ts, dest);
      const path = volumeBackupPath(app.id, v.name, filename);
      const key = dest.type === "S3" && dest.s3 ? objectKey(dest.s3, `${app.id}/${v.name}`, filename) : null;
      const row = await this.prisma.volumeBackup.create({
        data: {
          appId: app.id,
          volumeName: v.name,
          status: "RUNNING",
          filename,
          path,
          destinationId: app.volumeBackupDestinationId,
          objectKey: key,
          createdBy: actor,
        },
      });
      const startedAt = Date.now();
      try {
        const r = await this.agentWs.sendCommand(
          app.serverId,
          buildVolumeBackupScript(app.id, v.name, appVolumeName(app, v.name), filename, dest),
          "backup",
          BACKUP_TIMEOUT_MS,
        );
        const ok = r.exitCode === 0;
        const sz = ok ? parseSize(r.output) : null;
        if (ok) {
          if (sz != null) totalSize += sz;
        } else {
          anyFail = true;
          failedVols.push(v.name);
        }
        const completedAt = new Date();
        await this.prisma.volumeBackup.update({
          where: { id: row.id },
          data: {
            status: ok ? "SUCCESS" : "FAILED",
            sizeBytes: sz,
            exitCode: r.exitCode,
            errorTail: ok ? null : scrubRunOutput(r.output, secrets),
            durationMs: completedAt.getTime() - startedAt,
            completedAt,
          },
        });
      } catch (e) {
        anyFail = true;
        failedVols.push(v.name);
        const completedAt = new Date();
        await this.prisma.volumeBackup.update({
          where: { id: row.id },
          data: {
            status: "FAILED",
            errorTail: scrubRunOutput(e instanceof Error ? e.message : String(e), secrets),
            durationMs: completedAt.getTime() - startedAt,
            completedAt,
          },
        });
      }
      out.push((await this.prisma.volumeBackup.findUnique({ where: { id: row.id } }))!);
    }

    await this.prune(app);
    await this.audit.log({ actor, action: "app.volume_backup", target: app.id });
    if (vols.length) {
      const ctx = {
        appId: app.id,
        appName: app.name,
        volumes: String(vols.length),
        destType: dest.type,
        bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
        // BigInt totalSize → string before the queue's JSON payload (JSON.stringify throws on a raw BigInt).
        // Size is dropped from a failed run (a partial sum would misrepresent it); failedVolumes is empty on
        // success (the template drops empty fields).
        sizeBytes: anyFail ? "" : totalSize.toString(),
        failedVolumes: failedVols.join(", "),
      };
      if (anyFail) {
        // Throttled: first failure, then at most daily while it keeps failing; recovery is announced on the
        // next fully-successful run. Every failed row is still recorded regardless.
        if (await this.alerts.shouldNotifyFailure("volume", app.id)) {
          await this.notifications.fireForEvent(app.teamId, "volume_backup_failed", ctx).catch(() => undefined);
        }
      } else {
        await this.notifications.fireForEvent(app.teamId, "volume_backup_success", ctx).catch(() => undefined);
        await this.alerts.recover("volume", app.id, app.teamId, { appId: app.id, appName: app.name }).catch(() => undefined);
      }
    }
    return out;
  }

  /** Keep the newest `volumeBackupRetention` SUCCESS backups per volume. */
  async prune(app: Application): Promise<void> {
    for (const v of this.volumesOf(app)) {
      const all = await this.prisma.volumeBackup.findMany({
        where: { appId: app.id, volumeName: v.name, status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
      });
      for (const b of all.slice(app.volumeBackupRetention)) {
        // Each stale backup may live in its own destination — delete from it.
        const spec = await this.destinationSpecById(b.destinationId);
        await this.agentWs
          .sendCommand(app.serverId, buildVolumeDeleteScript(app.id, v.name, b.filename, spec), "backup")
          .catch(() => undefined);
        await this.prisma.volumeBackup.delete({ where: { id: b.id } });
      }
    }
  }
}

function parseSize(output: string): bigint | null {
  const text = output.trim();
  const m = text.match(/"size"\s*:\s*(\d+)/);
  if (m) return BigInt(m[1]);
  const last = text.split(/\s+/).filter(Boolean).pop();
  return last && /^\d+$/.test(last) ? BigInt(last) : null;
}
