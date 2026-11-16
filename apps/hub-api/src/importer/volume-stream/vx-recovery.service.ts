import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { MigrationVolumeTransfer } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MOVE_TIMEOUTS } from "../../app-moves/app-move-scripts";
import { VxPartRegistry } from "./vx-part-registry";
import { VxApplyService } from "./vx-apply.service";
import { VxService } from "./vx.service";
import { vxEnabled, vxStaleMs } from "./vx-constants";
import { scrubMoveOutput } from "../../app-moves/app-move-scripts";

/** An APPLYING transfer with no heartbeat for this long lost its worker (the hub died or restarted). */
export const APPLY_STALE_MS = 3 * 60_000;
const SWEEP_MS = 60_000;

/**
 * Settles streamed copies whose driver disappeared:
 *  - COPYING with no beat/commit for MIGRATION_VX_STALE_MS: the migrator is gone -> FAILED and resumable (parts kept).
 *  - APPLYING with no apply heartbeat for 3 min: ask the TARGET what happened (the apply script leaves a lock file, an
 *    `applied` marker and the staged parts) and settle accordingly, failing closed on anything it cannot prove.
 * The importer's 10-minute task reaper never touches `data:volume:*` tasks; this sweep (by `lastBeatAt`) is their only reaper.
 */
@Injectable()
export class VxRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VxRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vx: VxService,
    private readonly apply: VxApplyService,
    private readonly registry: VxPartRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.sweep().catch((e) => this.logger.warn(`vx recovery sweep failed: ${e instanceof Error ? e.message : String(e)}`)), SWEEP_MS);
    this.timer.unref?.();
    void this.sweep().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = Date.now()): Promise<void> {
    if (!vxEnabled() || this.busy) return;
    this.busy = true;
    try {
      const staleCopy = await this.prisma.migrationVolumeTransfer.findMany({ where: { state: "COPYING", lastBeatAt: { lt: new Date(now - vxStaleMs()) } } });
      for (const t of staleCopy) await this.failStaleCopy(t);
      const staleApply = await this.prisma.migrationVolumeTransfer.findMany({ where: { state: "APPLYING", lastBeatAt: { lt: new Date(now - APPLY_STALE_MS) } } });
      for (const t of staleApply) await this.settleApply(t, now);
    } finally {
      this.busy = false;
    }
  }

  private async failStaleCopy(t: MigrationVolumeTransfer): Promise<void> {
    this.registry.cancel(t.id, new Error("the migrator stopped reporting"));
    // a volume resumes from its committed parts; a dump cannot (it is not byte-deterministic), so the next run starts it over
    const message = t.destType === "db-dump" ? "migrator stopped reporting; re-run the command (the dump starts over: a dump cannot resume from the middle)" : "migrator stopped reporting; re-run the command to resume";
    const r = await this.prisma.migrationVolumeTransfer.updateMany({
      where: { id: t.id, state: "COPYING", lastBeatAt: t.lastBeatAt },
      data: { state: "FAILED", runId: null, error: message, phase: null },
    });
    if (r.count !== 1) return;
    await this.prisma.bulkTask.updateMany({ where: { opId: t.opId, itemRef: `data:${t.itemRef}` }, data: { status: "FAILED", output: message, finishedAt: new Date() } });
  }

  private async resolveCtx(t: MigrationVolumeTransfer) {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: t.opId }, select: { actorId: true } });
    if (!op) return null;
    try {
      return await this.vx.resolve(t.opId, op.actorId, t.itemRef);
    } catch {
      return null; // the op was cancelled / rolled back / lost its role: nothing more to drive
    }
  }

  private async failApply(t: MigrationVolumeTransfer, message: string, phase: string | null = null): Promise<void> {
    const safe = scrubMoveOutput(message).slice(0, 500);
    const r = await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: "APPLYING" }, data: { state: "FAILED", error: safe, phase, finishedAt: new Date() } });
    if (r.count === 1) await this.prisma.bulkTask.updateMany({ where: { opId: t.opId, itemRef: `data:${t.itemRef}` }, data: { status: "FAILED", output: safe, finishedAt: new Date() } });
  }

  /** The apply lost its worker. Settle it from what the TARGET proves. */
  private async settleApply(t: MigrationVolumeTransfer, now: number): Promise<void> {
    if (this.apply.isRunning(t.id)) return; // a live worker in THIS process (just slow to heartbeat)
    const ctx = await this.resolveCtx(t);
    if (!ctx) {
      await this.failApply(t, "the import is no longer active: the apply outcome is unknown, reset the volume");
      return;
    }
    const probe = await this.apply.probeTargetState(ctx, t.id);
    if (!probe) {
      await this.failApply(t, "target state unknown: the target could not be asked, reset the volume and copy it again");
      return;
    }
    if (probe.applied) {
      // The extract and its checks finished; only the post-apply steps (start the database) and the marker removal remain.
      await this.prisma.migrationVolumeTransfer.updateMany({ where: { id: t.id, state: "APPLYING" }, data: { lastBeatAt: new Date(now) } });
      this.apply.resumeAfterApplied(ctx, t);
      return;
    }
    if (probe.running) {
      // Still extracting on the target: keep waiting, up to the apply deadline counted from the last heartbeat.
      const deadline = (t.lastBeatAt?.getTime() ?? now) + MOVE_TIMEOUTS.apply(Number(t.rawBytesFinal ?? 0)) + 120_000;
      if (now > deadline) await this.failApply(t, "the apply did not finish in time: reset the volume and copy it again");
      return;
    }
    if (probe.parts > 0) {
      await this.failApply(t, "apply interrupted; re-run the migrator to apply the staged parts again (they are still on the target)");
      return;
    }
    await this.failApply(t, "target state unknown: no staged parts and no applied marker, reset the volume and copy it again");
  }
}
