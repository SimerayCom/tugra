import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HubBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService, parseSize } from "../backups/backup-runner.service";
import { backupPath, buildDeleteBackupScript, scrubRestoreOutput } from "../backups/backup-script";
import { objectKey, type DestinationSpec } from "../backups/destination";
import {
  HUB_NS,
  buildHubBackupScript,
  hubBackupFilename,
  hubBackupPassphrase,
  hubComposeProject,
  hubDest,
  parseHubDbTarget,
} from "./hub-backup-script";

const HUB_BACKUP_TIMEOUT_MS = 900_000; // the control-plane DB (metrics/audit) can be large
const FAILED_HISTORY_CAP = 20; // keep the table bounded (FAILED rows are never pruned by retention)

/**
 * Runs a dump of the HUB's own Postgres on the LOCAL agent and records it. Mirrors BackupRunnerService.runBackup
 * but for the single control-plane DB — there is no per-database row, so config comes from HubBackupConfig and
 * history lives in HubBackup. enabled only gates the SCHEDULER; a manual "Run now" works regardless.
 */
@Injectable()
export class HubBackupRunnerService {
  private readonly logger = new Logger(HubBackupRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
    private readonly backups: BackupRunnerService, // reuse destinationSpecById (decrypts S3 creds)
    private readonly config: ConfigService,
  ) {}

  /** The compose ("This machine") server — the only agent that can docker-exec the hub's postgres container. */
  async localServer() {
    return this.prisma.server.findFirst({ where: { isLocal: true } });
  }

  async runBackup(actor = "scheduler"): Promise<HubBackup> {
    // 1. Reap stale RUNNING rows (a dump in flight during a hub crash/restart otherwise stays RUNNING forever).
    await this.prisma.hubBackup.updateMany({
      where: { status: "RUNNING", createdAt: { lt: new Date(Date.now() - 2 * HUB_BACKUP_TIMEOUT_MS) } },
      data: { status: "FAILED", errorTail: "interrupted by a hub restart", completedAt: new Date() },
    });
    // 2. One at a time: a fresh RUNNING row means a dump is already in flight.
    const inflight = await this.prisma.hubBackup.findFirst({ where: { status: "RUNNING" } });
    if (inflight) return inflight;

    const local = await this.localServer();
    if (!local) throw new ConflictException("no local agent: the hub backup needs the 'This machine' server");
    if (!local.capabilities.includes("backup")) {
      throw new ConflictException("the local agent is not granted the 'backup' capability");
    }

    const cfg = await this.prisma.hubBackupConfig.findUnique({ where: { id: "singleton" } });
    const baseDest = await this.backups.destinationSpecById(cfg?.destinationId ?? null);
    const passphrase = hubBackupPassphrase(this.config.get<string>("SECRETS_ENCRYPTION_KEY") ?? "");
    const dest: DestinationSpec = hubDest(baseDest, passphrase); // always gpg-encrypted

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = hubBackupFilename(ts);
    const key = dest.type === "S3" && dest.s3 ? objectKey(dest.s3, HUB_NS, filename) : null;
    const target = { ...parseHubDbTarget(this.config.get<string>("DATABASE_URL") ?? ""), project: hubComposeProject() };

    const row = await this.prisma.hubBackup.create({
      data: { status: "RUNNING", filename, path: backupPath(HUB_NS, filename), destinationId: cfg?.destinationId ?? null, objectKey: key, createdBy: actor },
    });

    let succeeded = false;
    let errorText = "";
    let sizeBytes: bigint | null = null;
    try {
      const r = await this.agentWs.sendCommand(local.id, buildHubBackupScript(target, filename, dest), "backup", HUB_BACKUP_TIMEOUT_MS);
      succeeded = r.exitCode === 0;
      if (!succeeded) errorText = r.output;
      sizeBytes = succeeded ? parseSize(r.output) : null;
      await this.prisma.hubBackup.update({
        where: { id: row.id },
        data: { status: succeeded ? "SUCCESS" : "FAILED", sizeBytes, errorTail: succeeded ? null : scrubRestoreOutput(r.output), completedAt: new Date() },
      });
    } catch (e) {
      // Dump may have run (exit 0) but persisting threw → the row is FAILED now, so force succeeded=false.
      succeeded = false;
      errorText = e instanceof Error ? e.message : String(e);
      await this.prisma.hubBackup.update({ where: { id: row.id }, data: { status: "FAILED", errorTail: scrubRestoreOutput(errorText), completedAt: new Date() } });
    }
    await this.audit.log({ actor, action: "hub.backup", target: "hub" });
    const ctx = {
      dbId: "hub",
      dbName: "Tugra hub database",
      engine: "POSTGRES",
      destType: dest.type,
      bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
      region: dest.type === "S3" && dest.s3 ? dest.s3.region : "",
    };
    await this.notifications
      .fireForEvent(
        local.teamId,
        succeeded ? "backup_success" : "backup_failed",
        succeeded ? { ...ctx, sizeBytes: sizeBytes != null ? sizeBytes.toString() : "" } : { ...ctx, errorTail: scrubRestoreOutput(errorText) },
      )
      .catch(() => undefined);
    await this.prune(cfg?.retention ?? 7, local.id);
    return (await this.prisma.hubBackup.findUnique({ where: { id: row.id } })) as HubBackup;
  }

  /** Keep the newest `retention` SUCCESS backups (delete older objects + rows). FAILED rows are kept for
   *  visibility but capped so the table stays bounded. */
  async prune(retention: number, localServerId: string): Promise<void> {
    const stale = (await this.prisma.hubBackup.findMany({ where: { status: "SUCCESS" }, orderBy: { createdAt: "desc" } })).slice(retention);
    for (const b of stale) {
      const spec = await this.backups.destinationSpecById(b.destinationId);
      await this.agentWs.sendCommand(localServerId, buildDeleteBackupScript(HUB_NS, b.filename, spec), "backup").catch(() => undefined);
      await this.prisma.hubBackup.delete({ where: { id: b.id } });
    }
    const oldFailed = (await this.prisma.hubBackup.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" } })).slice(FAILED_HISTORY_CAP);
    if (oldFailed.length) await this.prisma.hubBackup.deleteMany({ where: { id: { in: oldFailed.map((b) => b.id) } } });
  }
}
