import { Injectable, Logger } from "@nestjs/common";
import { RestoreKind, RestoreStatus, type MigrationVolumeTransfer } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { AgentWsServer } from "../../agent-gateway/agent-ws.server";
import { DatabasesService } from "../../databases/databases.service";
import { CryptoService } from "../../crypto/crypto.service";
import type { DbCredentials, DbEngine, DbSpec } from "../../databases/database-script";
import { scrubRestoreOutput, scrubRunOutput } from "../../backups/backup-script";
import { MOVE_TIMEOUTS, hasMarker, scrubMoveOutput } from "../../app-moves/app-move-scripts";
import { VxPartRegistry } from "./vx-part-registry";
import {
  MIGRATION_EXIT,
  buildDumpApplyScript,
  buildMigrationApplyScript,
  buildMigrationCleanupScript,
  buildMigrationStateProbeScript,
  buildMigrationWipeDestScript,
  migrationRestoreId,
  parseMigrationApplyOk,
  parseMigrationStateProbe,
  type MigrationStateProbe,
} from "./vx-scripts";
import { DUMP_DEST_PG_LAYOUT_TEXT, dbGates, dumpDestGate, dumpDestLayout, firstGate } from "./vx-dest-gate";
import { VX_RESTORE_BY_PREFIX, dumpRestoreTimeoutMs } from "./vx-dump";
import type { VxCtx } from "./vx.service";
import { pgMajorOf } from "./vx-targets";
import type { VxInventoryItem } from "./vx.dto";

const MiB = 1024 * 1024;
const WIPE_TIMEOUT_MS = 30 * 60_000;
const HEARTBEAT_MS = 30_000;
/** Hub constants the apply applies; never user text. */
const PG_EXCLUDES = ["postmaster.pid"];

type Step = { name: string; status: string };

/** Human text for the apply script's exit codes (fail closed: anything unknown is an unknown outcome). */
export function explainApplyExit(code: number | null): string {
  switch (code) {
    case 72:
      return "the staged copy is not a valid archive; the destination volume was not touched";
    case 71:
      return "extracting failed and the destination volume was rolled back; re-run the migrator to retry";
    case 70:
      return "extracting AND the rollback failed: the snapshot volume was kept for manual recovery, do not start the app";
    case MIGRATION_EXIT.noParts:
      return "the staged parts are missing on the target; reset the volume and copy it again";
    case MIGRATION_EXIT.entryMismatch:
      return "the extracted entry count differs from the source's; reset the volume and copy it again";
    case MIGRATION_EXIT.pgVersion:
      return "the extracted PostgreSQL cluster reports a different major than expected; reset the volume and use the logical dump";
    default:
      return "the apply ended with an unknown outcome on the target; the destination may be partial, reset the volume and copy it again";
  }
}

/** Human text for the streamed dump restore's exit codes (fail closed: anything unknown is an unknown outcome). */
export function explainDumpApplyExit(code: number | null): string {
  if (code === MIGRATION_EXIT.noParts) return "the staged parts are missing on the target; the dump has to be copied again";
  return "restoring the dump into the database failed on the target; the staged parts are kept, re-run the migrator to apply them again (a PostgreSQL restore was rolled back, a MySQL-family restore is safe to repeat)";
}

/** Minutes the hub waits for a freshly copied Postgres to come up (crash recovery of an unclean stop can take minutes). */
export function provisionWaitMs(rawBytes: number): number {
  return Math.min(30 * 60_000, 60_000 + Math.ceil((Math.max(0, rawBytes) / (200 * MiB)) * 1000));
}

/**
 * Applies a fully copied transfer on the TARGET (wipe the disposable destination, extract the staged parts with the
 * rollback snapshot, verify entries / PG_VERSION, write the `applied` marker) and, for a Postgres data volume, starts the
 * database. Runs as a hub-side background worker with a 30 s heartbeat; the recovery service settles it if the hub dies.
 * Every terminal write is FENCED on `state = APPLYING`, so an abort/reset never gets overwritten by a late worker.
 */
@Injectable()
export class VxApplyService {
  private readonly logger = new Logger(VxApplyService.name);
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly databases: DatabasesService,
    private readonly audit: AuditService,
    private readonly registry: VxPartRegistry,
    private readonly crypto: CryptoService,
  ) {}

  isRunning(transferId: string): boolean {
    return this.active.has(transferId);
  }

  /** Kick off the apply in the background (idempotent per transfer within this process). */
  start(ctx: VxCtx, t: MigrationVolumeTransfer): void {
    if (this.active.has(t.id)) return;
    this.active.add(t.id);
    void this.run(ctx, t)
      .catch((e) => this.logger.warn(`vx apply ${t.id} crashed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.active.delete(t.id));
  }

  /** Recovery: the apply script already finished (marker present); only the post-apply steps remain. */
  resumeAfterApplied(ctx: VxCtx, t: MigrationVolumeTransfer): void {
    if (this.active.has(t.id)) return;
    this.active.add(t.id);
    void this.postApply(ctx, t)
      .catch((e) => this.logger.warn(`vx post-apply ${t.id} crashed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.active.delete(t.id));
  }

  /** The apply finished and the database did not start: re-run ONLY the provision step. */
  retryProvision(ctx: VxCtx, t: MigrationVolumeTransfer): void {
    this.resumeAfterApplied(ctx, t);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private dataRef(t: Pick<MigrationVolumeTransfer, "itemRef">): string {
    return `data:${t.itemRef}`;
  }

  private ownerResult(ctx: VxCtx): Record<string, unknown> {
    return ctx.target.destType === "app-volume"
      ? { vx: true, appItemRef: ctx.ownerTaskItemRef, volumeName: ctx.target.name }
      : { vx: true, databaseItemRef: ctx.ownerTaskItemRef };
  }

  /** Update the data task (fenced to RUNNING unless `force`); never throws. */
  private async task(t: MigrationVolumeTransfer, ctx: VxCtx, data: { status?: string; output?: string | null; steps?: Step[]; result?: Record<string, unknown>; finished?: boolean }): Promise<void> {
    try {
      await this.prisma.bulkTask.updateMany({
        where: { opId: t.opId, itemRef: this.dataRef(t) },
        data: {
          ...(data.status ? { status: data.status as never } : {}),
          ...(data.output !== undefined ? { output: data.output } : {}),
          ...(data.steps ? { steps: data.steps } : {}),
          ...(data.result ? { result: { ...this.ownerResult(ctx), ...data.result } as never } : {}),
          ...(data.finished ? { finishedAt: new Date() } : {}),
        },
      });
    } catch {
      /* the data task is a mirror; the transfer row is the source of truth */
    }
  }

  private async beat(transferId: string): Promise<void> {
    await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: transferId, state: "APPLYING" }, data: { lastBeatAt: new Date() } }).catch(() => undefined);
  }

  /** Fenced failure: only an APPLYING transfer can become FAILED here (an ABORTED/reset one stays as it is). */
  private async fail(ctx: VxCtx, t: MigrationVolumeTransfer, message: string, phase: string | null = null, steps?: Step[]): Promise<void> {
    const safe = scrubMoveOutput(message).slice(0, 500);
    const r = await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: "APPLYING" }, data: { state: "FAILED", error: safe, phase, finishedAt: new Date() } });
    if (r.count === 1) {
      await this.task(t, ctx, { status: "FAILED", output: safe, finished: true, ...(steps ? { steps } : {}) });
      await this.audit.log({ actor: ctx.actorId, action: "import.migration.volume", target: ctx.opId, meta: { itemRef: t.itemRef, status: "FAILED" } }).catch(() => undefined);
    }
  }

  private async cleanupStaging(ctx: VxCtx, t: MigrationVolumeTransfer): Promise<void> {
    try {
      await this.agentWs.sendCommand(ctx.targetServerId, buildMigrationCleanupScript(t.id), "backup", MOVE_TIMEOUTS.drop);
    } catch {
      /* best-effort: the applied marker only matters for recovery, which is over once the transfer is DONE */
    }
  }

  /** Remove the target's staging dir + rollback snapshots of a transfer (reset / abort / rollback). false = could not reach the target. */
  async cleanupTarget(transferId: string, targetServerId: string): Promise<boolean> {
    try {
      const r = await this.agentWs.sendCommand(targetServerId, buildMigrationCleanupScript(transferId), "backup", MOVE_TIMEOUTS.drop);
      return r.exitCode === 0 && hasMarker(r.output, "TUGRA_VX_CLEANUP_DONE");
    } catch {
      return false;
    }
  }

  /** Empty the destination volume (and this transfer's stale snapshots). Throws on failure: the destination state is then unknown. */
  async wipeDest(ctx: Pick<VxCtx, "targetServerId" | "dockerVolume">, transferId: string): Promise<void> {
    const r = await this.agentWs.sendCommand(ctx.targetServerId, buildMigrationWipeDestScript(ctx.dockerVolume, transferId), "backup", WIPE_TIMEOUT_MS);
    if (r.exitCode !== 0) throw new Error("the destination volume could not be emptied on the target");
  }

  async probeTargetState(ctx: Pick<VxCtx, "targetServerId">, transferId: string): Promise<MigrationStateProbe | null> {
    try {
      const r = await this.agentWs.sendCommand(ctx.targetServerId, buildMigrationStateProbeScript(transferId), "backup", MOVE_TIMEOUTS.stat);
      return r.exitCode === 0 ? parseMigrationStateProbe(r.output) : null;
    } catch {
      return null;
    }
  }

  // ───────────────────────────── the apply ─────────────────────────────

  private async run(ctx: VxCtx, t: MigrationVolumeTransfer): Promise<void> {
    const hb = setInterval(() => void this.beat(t.id), HEARTBEAT_MS);
    hb.unref?.();
    const steps: Step[] = [
      { name: "source-verified", status: "DONE" },
      { name: "copying", status: "DONE" },
      { name: "copied", status: "DONE" },
      { name: "applying", status: "RUNNING" },
    ];
    try {
      await this.task(t, ctx, { steps, result: { progress: { partsDone: t.partsDone, rawBytes: Number(t.rawBytesFinal ?? 0) } } });
      if (ctx.target.destType === "db-dump") return await this.runDumpApply(ctx, t, steps);
      const rawBytes = Number(t.rawBytesFinal ?? 0);
      const entries = t.entries ?? -1;
      if (rawBytes < 1 || entries < 0) return await this.fail(ctx, t, "the transfer has no recorded size: copy it again", null, steps);

      // 1. The destination must STILL be as-provisioned: a deploy/start that landed during the copy aborts the wipe.
      const blocked = await this.destBlocked(ctx);
      if (blocked) {
        steps[steps.length - 1].status = "FAILED";
        return await this.fail(ctx, t, blocked, null, steps);
      }

      // 2. Empty the (disposable) destination so the snapshot inside the apply is of an EMPTY volume, never a partial one.
      try {
        await this.wipeDest(ctx, t.id);
      } catch (e) {
        steps[steps.length - 1].status = "FAILED";
        return await this.fail(ctx, t, e instanceof Error ? e.message : "wipe failed", null, steps);
      }

      // 3. Apply.
      const isDb = ctx.target.destType === "db-data";
      let script: string;
      try {
        script = buildMigrationApplyScript({
          transferId: t.id,
          dockerVolume: ctx.dockerVolume,
          restoreId: migrationRestoreId(t.id, t.attempt),
          expectedEntries: entries,
          rawBytes,
          excludes: isDb ? PG_EXCLUDES : [],
          ...(isDb ? { expectPgMajor: await this.expectedMajor(ctx) } : {}),
        });
      } catch (e) {
        steps[steps.length - 1].status = "FAILED";
        return await this.fail(ctx, t, e instanceof Error ? e.message : "could not build the apply", null, steps);
      }
      let exitCode: number | null = null;
      let output = "";
      try {
        const r = await this.agentWs.sendCommand(ctx.targetServerId, script, "backup", MOVE_TIMEOUTS.apply(rawBytes));
        exitCode = r.exitCode;
        output = r.output;
      } catch (e) {
        steps[steps.length - 1].status = "FAILED";
        return await this.fail(ctx, t, `the target could not be reached while applying (${e instanceof Error ? e.message : "error"}); the outcome is unknown, reset and copy again`, null, steps);
      }
      const applied = exitCode === 0 && parseMigrationApplyOk(output) === entries;
      if (!applied) {
        steps[steps.length - 1].status = "FAILED";
        return await this.fail(ctx, t, explainApplyExit(exitCode === 0 ? null : exitCode), null, steps);
      }
      steps[steps.length - 1].status = "DONE";
      steps.push({ name: "applied", status: "DONE" });
      await this.task(t, ctx, { steps });
      await this.postApply(ctx, t, steps);
    } finally {
      clearInterval(hb);
    }
  }

  // ───────────────────────────── the streamed dump's restore ─────────────────────────────

  /**
   * Restore the staged parts into the destination DATABASE, streaming (`cat p.* | gunzip | pg_restore`, no decoded dump on disk):
   * start the database if it has not been (the same `DatabasesService.provision` a logical restore uses), run the engine's restore
   * pipeline on the target under a budget sized from the dump, record the attempt as a `Restore` row (so the database reads as
   * used, and so a retry can tell its own earlier attempt from anyone else's) and end DONE. A failed restore leaves the staged parts
   * where they are: the next `begin` re-applies them without dumping again.
   */
  private async runDumpApply(ctx: VxCtx, t: MigrationVolumeTransfer, steps: Step[]): Promise<void> {
    const rawBytes = Number(t.rawBytesFinal ?? 0);
    if (rawBytes < 1) return await this.fail(ctx, t, "the transfer has no recorded size: copy it again", null, steps);
    const gate = await dumpDestGate(this.prisma, ctx.resourceId);
    if (!gate.open) {
      steps[steps.length - 1].status = "FAILED";
      return await this.fail(ctx, t, gate.reason === "gone" ? "destination no longer exists" : "the database was started or holds data not restored by this migration: refusing to restore over it", null, steps);
    }

    const layout = await dumpDestLayout(this.prisma, ctx.resourceId);
    if (!layout.ok) {
      steps[steps.length - 1].status = "FAILED";
      return await this.fail(ctx, t, DUMP_DEST_PG_LAYOUT_TEXT, null, steps);
    }

    // 1. the database must be running to take a restore
    const db = await this.prisma.database.findUnique({ where: { id: ctx.resourceId }, select: { id: true, engine: true, image: true, port: true, hostPort: true, credentials: true, status: true } });
    if (!db) return await this.fail(ctx, t, "destination no longer exists", null, steps);
    let rec: { id: string } | null = null;
    if (db.status !== "RUNNING") {
      steps.push({ name: "db-provisioned", status: "RUNNING" });
      await this.task(t, ctx, { steps });
      // The `vx:` Restore row is written BEFORE the database is started: it is what marks the started database as this lane's own, so
      // a start that fails (status FAILED) or outlasts its wait (PROVISIONING, RUNNING later) can still be retried by the next begin.
      rec = await this.prisma.restore.create({ data: { databaseId: ctx.resourceId, kind: RestoreKind.IMPORT_URL, status: RestoreStatus.RUNNING, createdBy: `${VX_RESTORE_BY_PREFIX}${t.id}` } });
      const started = await this.provisionAndWait(ctx, t);
      steps[steps.length - 1].status = started ? "DONE" : "FAILED";
      if (!started) await this.prisma.restore.update({ where: { id: rec.id }, data: { status: RestoreStatus.FAILED, errorTail: "the destination database did not start", completedAt: new Date() } }).catch(() => undefined);
      if (!started) return await this.fail(ctx, t, "the destination database did not start: fix the cause and re-run the migrator (the staged parts are kept)", null, steps);
    }

    // 2. the restore script: the engine's own import pipeline fed by the staged parts (credentials decrypted in memory for this one call)
    let script: string;
    let password = "";
    try {
      const creds = JSON.parse(this.crypto.decrypt(db.credentials)) as DbCredentials;
      password = creds.password;
      const spec: DbSpec = { id: db.id, engine: db.engine as DbEngine, image: db.image, port: db.port, hostPort: db.hostPort, credentials: creds };
      script = buildDumpApplyScript({ transferId: t.id, rawBytes, db: spec });
    } catch (e) {
      if (rec) await this.prisma.restore.update({ where: { id: rec.id }, data: { status: RestoreStatus.FAILED, errorTail: "could not build the restore", completedAt: new Date() } }).catch(() => undefined);
      return await this.fail(ctx, t, e instanceof Error && !/credential|decrypt/i.test(e.message) ? e.message : "could not build the restore", null, steps);
    }

    // 3. run it, recording the attempt
    steps.push({ name: "restoring", status: "RUNNING" });
    await this.task(t, ctx, { steps });
    rec ??= await this.prisma.restore.create({ data: { databaseId: ctx.resourceId, kind: RestoreKind.IMPORT_URL, status: RestoreStatus.RUNNING, createdBy: `${VX_RESTORE_BY_PREFIX}${t.id}` } });
    const recId = rec.id;
    let exitCode: number | null = null;
    let output = "";
    try {
      const r = await this.agentWs.sendCommand(ctx.targetServerId, script, "backup", dumpRestoreTimeoutMs(rawBytes));
      exitCode = r.exitCode;
      output = r.output;
    } catch (e) {
      steps[steps.length - 1].status = "FAILED";
      await this.prisma.restore.update({ where: { id: recId }, data: { status: RestoreStatus.FAILED, errorTail: "the target could not be reached while restoring", completedAt: new Date() } }).catch(() => undefined);
      return await this.fail(ctx, t, `the target could not be reached while restoring (${e instanceof Error ? e.message : "error"}); the outcome is unknown, re-run the migrator to restore again`, null, steps);
    }
    const ok = exitCode === 0 && parseMigrationApplyOk(output) === 0;
    if (!ok) {
      steps[steps.length - 1].status = "FAILED";
      const tail = scrubRestoreOutput(scrubRunOutput(output, [password]));
      await this.prisma.restore.update({ where: { id: recId }, data: { status: RestoreStatus.FAILED, exitCode, errorTail: tail, completedAt: new Date() } }).catch(() => undefined);
      return await this.fail(ctx, t, explainDumpApplyExit(exitCode === 0 ? null : exitCode), null, steps);
    }
    await this.prisma.restore.update({ where: { id: recId }, data: { status: RestoreStatus.SUCCESS, exitCode: 0, completedAt: new Date() } });
    steps[steps.length - 1].status = "DONE";
    steps.push({ name: "applied", status: "DONE" });
    await this.task(t, ctx, { steps });
    await this.postApply(ctx, t, steps);
  }

  /** The Postgres major the extracted cluster must report: the Tugra record's version major. */
  private async expectedMajor(ctx: VxCtx): Promise<string> {
    const db = await this.prisma.database.findUnique({ where: { id: ctx.resourceId }, select: { version: true } });
    const major = pgMajorOf(db?.version);
    if (!major) throw new Error("the database version is not a PostgreSQL major");
    return major;
  }

  /** Why the destination may no longer be wiped, or null when it is still as-provisioned. */
  private async destBlocked(ctx: VxCtx): Promise<string | null> {
    if (ctx.target.destType === "app-volume") {
      const n = await this.prisma.deployment.count({ where: { appId: ctx.resourceId } });
      return n > 0 ? "the app was deployed during the copy: refusing to wipe a live volume" : null;
    }
    const opRow = await this.prisma.bulkOperation.findUnique({ where: { id: ctx.opId }, select: { meta: true } });
    const inv = (opRow?.meta as { vxInventory?: Record<string, VxInventoryItem> } | null)?.vxInventory?.[ctx.target.itemRef];
    const gates = await dbGates(this.prisma, ctx, inv);
    const bad = firstGate(gates, ["credentials", "state"]);
    return bad ? bad.text : null;
  }

  /** After the extract: app volume -> DONE; db-data -> start the database, wait for it, then DONE. */
  private async postApply(ctx: VxCtx, t: MigrationVolumeTransfer, stepsIn?: Step[]): Promise<void> {
    const steps: Step[] = stepsIn ?? [
      { name: "source-verified", status: "DONE" },
      { name: "copying", status: "DONE" },
      { name: "copied", status: "DONE" },
      { name: "applying", status: "DONE" },
      { name: "applied", status: "DONE" },
    ];
    if (ctx.target.destType === "db-data") {
      steps.push({ name: "db-provisioned", status: "RUNNING" });
      await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: "APPLYING" }, data: { phase: "provisioning", lastBeatAt: new Date() } });
      await this.task(t, ctx, { steps });
      const hb = setInterval(() => void this.beat(t.id), HEARTBEAT_MS);
      hb.unref?.();
      try {
        const started = await this.provisionAndWait(ctx, t);
        if (!started) {
          steps[steps.length - 1].status = "FAILED";
          await this.task(t, ctx, { steps, result: { dbData: { started: false } } });
          return await this.fail(ctx, t, "the data was applied but the database did not start: fix the cause and re-run the migrator to retry the start (nothing is copied again)", "provision-failed", steps);
        }
      } finally {
        clearInterval(hb);
      }
      steps[steps.length - 1].status = "DONE";
    }
    const done = await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: "APPLYING" }, data: { state: "DONE", phase: null, error: null, finishedAt: new Date() } });
    if (done.count !== 1) return;
    await this.task(t, ctx, { status: "DONE", output: null, steps, finished: true, result: { progress: { partsDone: t.partsDone, rawBytes: Number(t.rawBytesFinal ?? 0) }, ...(ctx.target.destType === "db-data" ? { dbData: { started: true } } : {}) } });
    await this.audit.log({ actor: ctx.actorId, action: "import.migration.volume", target: ctx.opId, meta: { itemRef: t.itemRef, status: "SUCCESS", bytes: Number(t.rawBytesFinal ?? 0) } }).catch(() => undefined);
    await this.cleanupStaging(ctx, t); // the `applied` marker has done its job
    this.registry.forget(t.id);
  }

  /** `DatabasesService.provision` (the normal start path: the entrypoint sees PG_VERSION and skips initdb), then wait. */
  private async provisionAndWait(ctx: VxCtx, t: MigrationVolumeTransfer): Promise<boolean> {
    const deadline = Date.now() + provisionWaitMs(Number(t.rawBytesFinal ?? 0));
    try {
      const view = await this.databases.provision(ctx.actorId, ctx.resourceId);
      if ((view as { status?: string }).status === "RUNNING") return true;
    } catch {
      /* the status poll below decides */
    }
    while (Date.now() < deadline) {
      const db = await this.prisma.database.findUnique({ where: { id: ctx.resourceId }, select: { status: true } });
      if (db?.status === "RUNNING") return true;
      if (db?.status === "FAILED") return false;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    return false;
  }
}
