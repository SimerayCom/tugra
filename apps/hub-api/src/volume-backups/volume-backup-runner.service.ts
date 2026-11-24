import { Injectable, Logger } from "@nestjs/common";
import { Application, VolumeBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { appVolumeName, type AppVolume } from "../deploy/deploy-script";
import { LOCAL_DEST, objectKey, type DestinationSpec } from "../backups/destination";
import { resolveDestinationSpec } from "../backups/destination-resolver";
import { gpgMissingTail, scrubRunOutput } from "../backups/backup-script";
import { GIB, MIGRATION_SNAPSHOT_PREFIX, planRetention, type RetentionRow } from "../backups/retention";
import { SHARED_POOL, isCarvedOut, policyAlertId, poolBudgetGb, poolKeyOf } from "./policy";
import { BackupAlertsService } from "../backups/backup-alerts.service";
import { AppMoveInProgressException, findActiveMove } from "../common/app-move-guard";
import {
  buildVolumeBackupScript,
  buildVolumeDeleteScript,
  volumeBackupFilename,
  volumeBackupPath,
} from "./volume-backup-script";

const BACKUP_TIMEOUT_MS = 300_000;

@Injectable()
export class VolumeBackupRunnerService {
  private readonly logger = new Logger(VolumeBackupRunnerService.name);

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
    return resolveDestinationSpec(this.prisma, this.crypto, destinationId);
  }

  /**
   * Back up the app's named volumes, then prune to retention. No `opts` backs up ALL volumes (manual "Back up
   * now"). `only` restricts to those volume names (a per-volume policy job); `excludePolicied` skips volumes
   * carved out of the app-wide job (disabled or running their own schedule).
   */
  async runBackup(
    appId: string,
    actor = "scheduler",
    opts?: { only?: string[]; excludePolicied?: boolean },
  ): Promise<VolumeBackup[]> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new Error("app not found");
    // An app move is copying these volumes: a backup now would tar a half-moved volume. The schedule just skips
    // this tick (the next one runs normally); a manual run is told why.
    if (await findActiveMove(this.prisma, appId)) {
      if (actor === "scheduler") return [];
      throw new AppMoveInProgressException();
    }
    let vols = this.volumesOf(app);
    if (opts?.only) vols = vols.filter((v) => opts.only!.includes(v.name));
    if (opts?.excludePolicied) {
      const carved = new Set(
        (await this.prisma.volumeBackupPolicy.findMany({ where: { appId } })).filter(isCarvedOut).map((p) => p.volumeName),
      );
      vols = vols.filter((v) => !carved.has(v.name));
    }
    // A per-volume run keys its alert state on app+volume so two jobs of one app can never flap a shared key.
    const alertId = opts?.only && opts.only.length === 1 ? policyAlertId(app.id, opts.only[0]) : app.id;
    // A destination that cannot be resolved (encryption key missing/unreadable) fails closed. A manual run is told
    // why (a typed 422); a scheduled one has no caller, so it is recorded as a FAILED row per volume (against the
    // implicit LOCAL path, no key involved) and goes through the normal failure alert instead of dying silently.
    let dest: DestinationSpec;
    let destError: string | null = null;
    try {
      dest = await this.destinationSpec(app);
    } catch (e) {
      if (actor !== "scheduler") throw e;
      destError = e instanceof Error ? e.message : String(e);
      dest = LOCAL_DEST;
      this.logger.warn(`scheduled volume backup of app ${app.id} cannot resolve its destination: ${destError}`);
    }
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
        if (destError) throw new Error(destError);
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
            errorTail: ok ? null : gpgMissingTail(r.output, r.exitCode, dest.encryption.enabled, secrets) ?? scrubRunOutput(r.output, secrets),
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
        if (await this.alerts.shouldNotifyFailure("volume", alertId)) {
          await this.notifications.fireForEvent(app.teamId, "volume_backup_failed", ctx).catch(() => undefined);
        }
      } else {
        await this.notifications.fireForEvent(app.teamId, "volume_backup_success", ctx).catch(() => undefined);
        await this.alerts.recover("volume", alertId, app.teamId, { appId: app.id, appName: app.name }).catch(() => undefined);
      }
    }
    return out;
  }

  /**
   * Prune the WHOLE app (whichever run triggered it) by keep-N, age and total size, via the shared planner.
   * Per-volume policies override keep/age per volume; a volume whose policy sets its own `maxSizeGb` is its own
   * size pool, every other volume shares the app pool. The newest SUCCESS of each volume is never removed.
   */
  async prune(app: Application): Promise<void> {
    const declared = new Set(this.volumesOf(app).map((v) => v.name));
    const rows = (
      await this.prisma.volumeBackup.findMany({ where: { appId: app.id, status: "SUCCESS", NOT: { createdBy: { startsWith: MIGRATION_SNAPSHOT_PREFIX } } }, orderBy: { createdAt: "desc" } })
    ).filter((b) => declared.has(b.volumeName));
    if (!rows.length) return;
    const policies = new Map((await this.prisma.volumeBackupPolicy.findMany({ where: { appId: app.id } })).map((p) => [p.volumeName, p]));
    const pools = new Map<string, typeof rows>();
    for (const b of rows) {
      const k = poolKeyOf(policies, b.volumeName);
      pools.set(k, [...(pools.get(k) ?? []), b]);
    }
    const byId = new Map(rows.map((b) => [b.id, b]));
    for (const [pool, poolRows] of pools) {
      const gb = poolBudgetGb(pool, app.volumeBackupMaxSizeGb, policies);
      const plan = planRetention(
        poolRows.map<RetentionRow>((b) => ({ id: b.id, series: b.volumeName, createdAt: b.createdAt, sizeBytes: b.sizeBytes })),
        { keep: app.volumeBackupRetention, maxAgeDays: app.volumeBackupRetentionDays, maxBytes: gb != null ? BigInt(gb) * GIB : null },
        Date.now(),
        (series) => {
          const p = policies.get(series);
          return { keep: p?.retention ?? app.volumeBackupRetention, maxAgeDays: p?.retentionDays ?? app.volumeBackupRetentionDays };
        },
      );
      if (plan.overBudget) this.logger.warn(`volume backups of app ${app.id} (${pool === SHARED_POOL ? "app" : `volume ${pool}`}) exceed the ${gb} GiB budget with only protected backups left`);
      for (const { id } of plan.remove) {
        const b = byId.get(id)!;
        // Each stale backup may live in its own destination — delete from it. A destination that cannot be
        // resolved (e.g. its key is gone) leaves the row + object alone rather than orphaning silently.
        let spec: DestinationSpec;
        try {
          spec = await this.destinationSpecById(b.destinationId);
        } catch (e) {
          this.logger.warn(`prune skipped backup ${b.id}: ${e instanceof Error ? e.message : e}`);
          continue;
        }
        await this.agentWs
          .sendCommand(app.serverId, buildVolumeDeleteScript(app.id, b.volumeName, b.filename, spec), "backup")
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
