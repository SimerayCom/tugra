import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { BackupRunnerService, parseSize } from "../backups/backup-runner.service";
import { BackupsService } from "../backups/backups.service";
import { VolumeBackupsService } from "../volume-backups/volume-backups.service";
import { backupFilename, backupPath, buildBackupScript, buildDeleteBackupScript, gpgMissingTail, scrubRunOutput } from "../backups/backup-script";
import { objectKey, type DestinationSpec } from "../backups/destination";
import { MIGRATION_SNAPSHOT_PREFIX } from "../backups/retention";
import { buildVolumeBackupScript, buildVolumeDeleteScript, volumeBackupFilename, volumeBackupPath } from "../volume-backups/volume-backup-script";
import { appVolumeName, type AppVolume } from "../deploy/deploy-script";
import { supportsBackup, type DbEngine } from "../databases/database-script";
import { MIGRATION_RUNS_FACADE, type MigrationRunsFacade, type RunActor } from "../migration-runs/core/run-contract";
import { SNAPSHOT_TTL_DAYS, captureDue, expiryOf, isLive, overallStatus, retryable, runAcceptsSnapshot, type SnapshotItem, type SnapshotStatus } from "./snapshot-logic";
import type { PlanSnapshotInput } from "./snapshot.dto";

const DB_TIMEOUT_MS = 900_000;
const VOLUME_TIMEOUT_MS = 1_800_000;
const CREATED_BY = (runId: string) => `${MIGRATION_SNAPSHOT_PREFIX}${runId}`;
/** A capture that has not touched its row for this long is dead (a restart or crash): the longest single item is the volume timeout. */
const STUCK_AFTER_MS = VOLUME_TIMEOUT_MS + 600_000;

export interface SnapshotView {
  snapshot: {
    status: SnapshotStatus;
    destinationId: string | null;
    destinationName: string | null;
    /** `LOCAL` = the target server's own disk (the UI warns: it is lost with that disk). */
    destinationType: "S3" | "LOCAL";
    items: Array<{ id: string | null; kind: "database" | "volume"; name: string | null; status: "SUCCESS" | "FAILED"; sizeBytes: string | null; error: string | null }>;
    keepDays: number;
    capturedAt: string | null;
    expiresAt: string | null;
    restoredAt: string | null;
    note: string | null;
  } | null;
  destinations: Array<{ id: string; name: string; type: "S3" | "LOCAL" }>;
}

/**
 * The pre-migration safety copy of a run's data (item 93). SCOPE: the hub has no direct reach into the source host's data
 * (only the migrator or the same-host agent does), so the copy is taken ON THE TARGET the moment the final data copy has
 * landed (DATA_FINAL passed). That is the source's frozen state, and it exists off the hosts at the owner's chosen
 * destination (any S3-compatible storage, or the target server's disk with a warning) for 7 days, so it survives writes
 * Tugra makes after the flip and the retirement of the source. It is NOT a capture of the source taken before the first
 * data copy; restoring puts the target's database or volume back to the frozen state. It is recorded as `Backup` /
 * `VolumeBackup` rows (marked by `createdBy`, which normal retention never prunes), so restore is the existing restore.
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);
  private readonly capturing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly backups: BackupRunnerService,
    private readonly dbBackups: BackupsService,
    private readonly volBackups: VolumeBackupsService,
    @Inject(MIGRATION_RUNS_FACADE) private readonly runs: MigrationRunsFacade,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  async view(actor: RunActor, runId: string): Promise<SnapshotView> {
    const run = await this.runs.get(actor, runId); // authorization
    const snap = await this.prisma.migrationSnapshot.findUnique({ where: { runId: run.id } });
    const dests = await this.prisma.backupDestination.findMany({ where: { teamId: run.teamId }, select: { id: true, name: true, type: true }, orderBy: { name: "asc" } });
    const destinations = dests.map((d) => ({ id: d.id, name: d.name, type: d.type as "S3" | "LOCAL" }));
    if (!snap) return { snapshot: null, destinations };
    const dest = snap.destinationId ? dests.find((d) => d.id === snap.destinationId) : undefined;
    const items = (Array.isArray(snap.items) ? (snap.items as unknown as SnapshotItem[]) : []).map((i) => ({ id: i.rowId, kind: i.kind, name: i.volume ? `${i.name ?? i.ref} / ${i.volume}` : i.name, status: i.status, sizeBytes: i.sizeBytes, error: i.error }));
    return {
      snapshot: {
        status: snap.status as SnapshotStatus,
        destinationId: snap.destinationId,
        destinationName: dest?.name ?? null,
        destinationType: snap.destinationId && dest?.type === "S3" ? "S3" : "LOCAL",
        items,
        keepDays: SNAPSHOT_TTL_DAYS,
        capturedAt: snap.capturedAt?.toISOString() ?? null,
        expiresAt: snap.expiresAt?.toISOString() ?? null,
        restoredAt: snap.restoredAt?.toISOString() ?? null,
        note: snap.note,
      },
      destinations,
    };
  }

  // ───────────────────────────── choose the target ─────────────────────────────

  /** Pick where the safety copy goes (or record "no copy"). Allowed until the copy starts. */
  async plan(actor: RunActor, runId: string, input: PlanSnapshotInput): Promise<SnapshotView> {
    const run = await this.runs.get(actor, runId);
    if (!runAcceptsSnapshot(run.status)) throw new ConflictException("this run is over");
    if (input.destinationId) {
      const dest = await this.prisma.backupDestination.findUnique({ where: { id: input.destinationId } });
      if (!dest || dest.teamId !== run.teamId) throw new BadRequestException("backup destination not found in this team");
    }
    const prev = await this.prisma.migrationSnapshot.findUnique({ where: { runId: run.id } });
    if (prev && !(prev.status === "PLANNED" || prev.status === "SKIPPED")) throw new ConflictException("the safety copy already started");
    const data = { destinationId: input.skip ? null : input.destinationId, status: input.skip ? "SKIPPED" : "PLANNED", note: null };
    await this.prisma.migrationSnapshot.upsert({ where: { runId: run.id }, create: { runId: run.id, teamId: run.teamId, createdBy: actor.userId, ...data }, update: data });
    await this.audit.log({ actor: actor.userId, action: "migration.snapshot.plan", target: run.id, meta: { skip: input.skip, local: !input.destinationId } });
    return this.view(actor, runId);
  }

  /** Take the copy now instead of waiting for the final data copy (a retry after FAILED / PARTIAL too). */
  async captureNow(actor: RunActor, runId: string): Promise<SnapshotView> {
    const run = await this.runs.get(actor, runId);
    if (!run.opId) throw new ConflictException("the run has not imported anything yet");
    const snap = await this.prisma.migrationSnapshot.findUnique({ where: { runId: run.id } });
    if (!snap || !retryable(snap.status)) throw new ConflictException("choose where the safety copy goes first");
    await this.capture(snap.id, actor.userId);
    return this.view(actor, runId);
  }

  // ───────────────────────────── capture ─────────────────────────────

  /** One capture of one snapshot row: claimed atomically, so two hub processes never copy twice. */
  async capture(snapshotId: string, actorId = "scheduler"): Promise<void> {
    if (this.capturing.has(snapshotId)) return;
    this.capturing.add(snapshotId);
    try {
      const claimed = await this.prisma.migrationSnapshot.updateMany({ where: { id: snapshotId, status: { in: ["PLANNED", "FAILED", "PARTIAL"] } }, data: { status: "CAPTURING", note: null } });
      if (claimed.count === 0) return;
      const snap = await this.prisma.migrationSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
      const run = await this.prisma.migrationRun.findUnique({ where: { id: snap.runId }, select: { opId: true } });
      const finish = (status: SnapshotStatus, items: SnapshotItem[], note: string | null) =>
        this.prisma.migrationSnapshot.update({ where: { id: snapshotId }, data: { status, items: items as unknown as Prisma.InputJsonValue, note, capturedAt: new Date(), expiresAt: expiryOf(new Date()) } });
      if (!run?.opId) return void (await finish("FAILED", [], "no-import"));

      let dest: DestinationSpec;
      try {
        dest = await this.backups.destinationSpecById(snap.destinationId);
      } catch (e) {
        return void (await finish("FAILED", [], scrubRunOutput(e instanceof Error ? e.message : String(e)).slice(0, 200)));
      }
      const tasks = await this.prisma.bulkTask.findMany({ where: { opId: run.opId, status: "DONE", resourceId: { not: null }, resourceType: { in: ["database", "application"] } }, select: { resourceType: true, resourceId: true } });
      const dbIds = [...new Set(tasks.filter((t) => t.resourceType === "database").map((t) => t.resourceId as string))];
      const appIds = [...new Set(tasks.filter((t) => t.resourceType === "application").map((t) => t.resourceId as string))];
      const items: SnapshotItem[] = [];
      for (const db of await this.prisma.database.findMany({ where: { id: { in: dbIds } } })) {
        if (!supportsBackup(db.engine as DbEngine)) continue;
        items.push(await this.copyDatabase(db, dest, snap));
        await this.heartbeat(snapshotId);
      }
      for (const app of await this.prisma.application.findMany({ where: { id: { in: appIds } } })) {
        const vols = Array.isArray(app.volumes) ? (app.volumes as unknown as AppVolume[]) : [];
        for (const v of vols) {
          items.push(await this.copyVolume(app, v.name, dest, snap));
          await this.heartbeat(snapshotId);
        }
      }
      if (items.length === 0) return void (await this.prisma.migrationSnapshot.update({ where: { id: snapshotId }, data: { status: "SKIPPED", note: "nothing-to-copy", capturedAt: new Date() } }));
      await finish(overallStatus(items), items, null);
      await this.audit.log({ actor: actorId, action: "migration.snapshot.capture", target: snap.runId, meta: { items: items.length, failed: items.filter((i) => i.status === "FAILED").length } });
    } catch (e) {
      this.logger.warn(`snapshot ${snapshotId} failed: ${e instanceof Error ? e.message : e}`);
      await this.prisma.migrationSnapshot.updateMany({ where: { id: snapshotId, status: "CAPTURING" }, data: { status: "FAILED", note: "internal-error" } }).catch(() => undefined);
    } finally {
      this.capturing.delete(snapshotId);
    }
  }

  /** Touch the row between items so a live capture is never mistaken for a dead one. */
  private async heartbeat(snapshotId: string): Promise<void> {
    await this.prisma.migrationSnapshot.updateMany({ where: { id: snapshotId, status: "CAPTURING" }, data: { note: null } }).catch(() => undefined);
  }

  /** A capture left in CAPTURING by a restart or crash is failed (retryable by hand) and its half-written rows are closed. */
  async recoverStuck(now: Date = new Date()): Promise<number> {
    const stuck = await this.prisma.migrationSnapshot.findMany({ where: { status: "CAPTURING", updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } }, take: 20 });
    let n = 0;
    for (const s of stuck) {
      if (this.capturing.has(s.id)) continue;
      const moved = await this.prisma.migrationSnapshot.updateMany({ where: { id: s.id, status: "CAPTURING", updatedAt: s.updatedAt }, data: { status: "FAILED", note: "interrupted", capturedAt: now, expiresAt: expiryOf(now) } });
      if (moved.count === 0) continue;
      const closed = { status: "FAILED" as const, errorTail: "interrupted", completedAt: now };
      await this.prisma.backup.updateMany({ where: { createdBy: CREATED_BY(s.runId), status: "RUNNING" }, data: closed });
      await this.prisma.volumeBackup.updateMany({ where: { createdBy: CREATED_BY(s.runId), status: "RUNNING" }, data: closed });
      n++;
    }
    return n;
  }

  private async copyDatabase(db: Awaited<ReturnType<PrismaService["database"]["findMany"]>>[number], dest: DestinationSpec, snap: { runId: string; destinationId: string | null }): Promise<SnapshotItem> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = backupFilename(db.engine as DbEngine, ts, dest);
    const key = dest.type === "S3" && dest.s3 ? objectKey(dest.s3, db.id, filename) : null;
    const row = await this.prisma.backup.create({ data: { databaseId: db.id, status: "RUNNING", filename, path: backupPath(db.id, filename), destinationId: snap.destinationId, objectKey: key, createdBy: CREATED_BY(snap.runId) } });
    const secrets = [dest.s3?.accessKey, dest.s3?.secretKey, dest.encryption?.key];
    const base = { kind: "database" as const, ref: db.id, name: db.name, rowId: row.id };
    try {
      const r = await this.agentWs.sendCommand(db.serverId, buildBackupScript(this.backups.toSpec(db), filename, dest), "backup", DB_TIMEOUT_MS);
      const ok = r.exitCode === 0;
      const size = ok ? parseSize(r.output) : null;
      const error = ok ? null : (gpgMissingTail(r.output, r.exitCode, dest.encryption.enabled, secrets) ?? scrubRunOutput(r.output, secrets)).slice(-300);
      await this.prisma.backup.update({ where: { id: row.id }, data: { status: ok ? "SUCCESS" : "FAILED", sizeBytes: size, exitCode: r.exitCode, errorTail: error, completedAt: new Date() } });
      return { ...base, status: ok ? "SUCCESS" : "FAILED", sizeBytes: size != null ? size.toString() : null, error };
    } catch (e) {
      const error = scrubRunOutput(e instanceof Error ? e.message : String(e), secrets).slice(0, 300);
      await this.prisma.backup.update({ where: { id: row.id }, data: { status: "FAILED", errorTail: error, completedAt: new Date() } });
      return { ...base, status: "FAILED", sizeBytes: null, error };
    }
  }

  private async copyVolume(app: { id: string; name: string; serverId: string } & Record<string, unknown>, volume: string, dest: DestinationSpec, snap: { runId: string; destinationId: string | null }): Promise<SnapshotItem> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = volumeBackupFilename(ts, dest);
    const key = dest.type === "S3" && dest.s3 ? objectKey(dest.s3, `${app.id}/${volume}`, filename) : null;
    const row = await this.prisma.volumeBackup.create({ data: { appId: app.id, volumeName: volume, status: "RUNNING", filename, path: volumeBackupPath(app.id, volume, filename), destinationId: snap.destinationId, objectKey: key, createdBy: CREATED_BY(snap.runId) } });
    const secrets = [dest.s3?.accessKey, dest.s3?.secretKey, dest.encryption?.key];
    const base = { kind: "volume" as const, ref: app.id, volume, name: app.name, rowId: row.id };
    try {
      const r = await this.agentWs.sendCommand(app.serverId, buildVolumeBackupScript(app.id, volume, appVolumeName(app as never, volume), filename, dest), "backup", VOLUME_TIMEOUT_MS);
      const ok = r.exitCode === 0;
      const size = ok ? parseSize(r.output) : null;
      const error = ok ? null : (gpgMissingTail(r.output, r.exitCode, dest.encryption.enabled, secrets) ?? scrubRunOutput(r.output, secrets)).slice(-300);
      await this.prisma.volumeBackup.update({ where: { id: row.id }, data: { status: ok ? "SUCCESS" : "FAILED", sizeBytes: size, exitCode: r.exitCode, errorTail: error, completedAt: new Date() } });
      return { ...base, status: ok ? "SUCCESS" : "FAILED", sizeBytes: size != null ? size.toString() : null, error };
    } catch (e) {
      const error = scrubRunOutput(e instanceof Error ? e.message : String(e), secrets).slice(0, 300);
      await this.prisma.volumeBackup.update({ where: { id: row.id }, data: { status: "FAILED", errorTail: error, completedAt: new Date() } });
      return { ...base, status: "FAILED", sizeBytes: null, error };
    }
  }

  // ───────────────────────────── restore ─────────────────────────────

  /**
   * One-click go-back for one item: the existing restore of the recorded backup (permission re-checked there: write on
   * the database / app). It puts the target's database or volume back to the state the safety copy holds.
   */
  async restore(actor: RunActor, runId: string, itemId: string): Promise<SnapshotView> {
    const run = await this.runs.get(actor, runId);
    const snap = await this.prisma.migrationSnapshot.findUnique({ where: { runId: run.id } });
    if (!snap || !isLive(snap.status)) throw new ConflictException("there is no safety copy to go back to");
    const item = (Array.isArray(snap.items) ? (snap.items as unknown as SnapshotItem[]) : []).find((i) => i.rowId === itemId && i.status === "SUCCESS");
    if (!item) throw new NotFoundException("safety copy item not found");
    if (item.kind === "database") await this.dbBackups.restore(actor.userId, item.ref, itemId);
    else await this.volBackups.restore(actor.userId, item.ref, itemId);
    await this.prisma.migrationSnapshot.update({ where: { id: snap.id }, data: { restoredAt: new Date() } });
    await this.audit.log({ actor: actor.userId, action: "migration.snapshot.restore", target: run.id, meta: { kind: item.kind, ref: item.ref } });
    return this.view(actor, runId);
  }

  // ───────────────────────────── schedule hooks ─────────────────────────────

  /** Take every planned copy whose data copy has finished. */
  async runDue(): Promise<void> {
    await this.recoverStuck();
    const planned = await this.prisma.migrationSnapshot.findMany({ where: { status: "PLANNED" }, take: 5, orderBy: { createdAt: "asc" } });
    for (const s of planned) {
      const run = await this.prisma.migrationRun.findUnique({ where: { id: s.runId }, select: { status: true, steps: { select: { key: true, status: true } } } });
      if (!run || !runAcceptsSnapshot(run.status)) {
        await this.prisma.migrationSnapshot.updateMany({ where: { id: s.id, status: "PLANNED" }, data: { status: "SKIPPED", note: "run-over" } });
        continue;
      }
      if (captureDue(run.steps)) await this.capture(s.id);
    }
  }

  /** Remove copies older than the keep time: the stored object first, then the row. */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.migrationSnapshot.findMany({ where: { status: { in: ["SUCCESS", "PARTIAL", "FAILED"] }, expiresAt: { lt: now } }, take: 20 });
    let swept = 0;
    for (const s of due) {
      let dest: DestinationSpec;
      try {
        dest = await this.backups.destinationSpecById(s.destinationId);
      } catch {
        continue; // the destination is gone or unreadable: leave it, never orphan silently
      }
      const items = Array.isArray(s.items) ? (s.items as unknown as SnapshotItem[]) : [];
      let allGone = true;
      for (const i of items) {
        if (!i.rowId) continue;
        try {
          if (i.kind === "database") {
            const b = await this.prisma.backup.findUnique({ where: { id: i.rowId }, include: { database: { select: { serverId: true } } } });
            if (b) {
              await this.agentWs.sendCommand(b.database.serverId, buildDeleteBackupScript(b.databaseId, b.filename, dest), "backup");
              await this.prisma.backup.delete({ where: { id: b.id } });
            }
          } else {
            const b = await this.prisma.volumeBackup.findUnique({ where: { id: i.rowId }, include: { app: { select: { serverId: true } } } });
            if (b) {
              await this.agentWs.sendCommand(b.app.serverId, buildVolumeDeleteScript(b.appId, b.volumeName, b.filename, dest), "backup");
              await this.prisma.volumeBackup.delete({ where: { id: b.id } });
            }
          }
        } catch {
          allGone = false; // the agent was offline: try again on the next sweep
        }
      }
      if (allGone) {
        await this.prisma.migrationSnapshot.update({ where: { id: s.id }, data: { status: "EXPIRED", items: [] } });
        swept++;
      }
    }
    return swept;
  }
}
