import { Injectable } from "@nestjs/common";
import { Application, VolumeBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { appVolumeName, type AppVolume } from "../deploy/deploy-script";
import { LOCAL_DEST, objectKey, type DestinationSpec } from "../backups/destination";
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
  ) {}

  volumesOf(app: Application): AppVolume[] {
    return Array.isArray(app.volumes) ? (app.volumes as unknown as AppVolume[]) : [];
  }

  async destinationSpec(app: Application): Promise<DestinationSpec> {
    if (!app.volumeBackupDestinationId) return LOCAL_DEST;
    const d = await this.prisma.backupDestination.findUnique({ where: { id: app.volumeBackupDestinationId } });
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
      try {
        const r = await this.agentWs.sendCommand(
          app.serverId,
          buildVolumeBackupScript(app.id, v.name, appVolumeName(app, v.name), filename, dest),
          "backup",
          BACKUP_TIMEOUT_MS,
        );
        const ok = r.exitCode === 0;
        await this.prisma.volumeBackup.update({
          where: { id: row.id },
          data: { status: ok ? "SUCCESS" : "FAILED", sizeBytes: ok ? parseSize(r.output) : null, completedAt: new Date() },
        });
      } catch {
        await this.prisma.volumeBackup.update({ where: { id: row.id }, data: { status: "FAILED", completedAt: new Date() } });
      }
      out.push((await this.prisma.volumeBackup.findUnique({ where: { id: row.id } }))!);
    }

    await this.prune(app, dest);
    await this.audit.log({ actor, action: "app.volume_backup", target: app.id });
    return out;
  }

  /** Keep the newest `volumeBackupRetention` SUCCESS backups per volume. */
  async prune(app: Application, dest?: DestinationSpec): Promise<void> {
    const spec = dest ?? (await this.destinationSpec(app));
    for (const v of this.volumesOf(app)) {
      const all = await this.prisma.volumeBackup.findMany({
        where: { appId: app.id, volumeName: v.name, status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
      });
      for (const b of all.slice(app.volumeBackupRetention)) {
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
