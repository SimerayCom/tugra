import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Database, DbStatus, Restore, RestoreKind, RestoreStatus } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentCommandTimeoutException, AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { NotificationsService } from "../notifications/notifications.service";
import { DatabasesService, type ReapOutcome } from "../databases/databases.service";
import { loadProjectCtx } from "../common/resource-project";
import { resolveImage, type DbEngine, type DbSpec } from "../databases/database-script";
import { type DestinationSpec } from "./destination";
import { BackupRunnerService } from "./backup-runner.service";
import { scrubRunOutput } from "./backup-script";
import {
  baseIntervals,
  buildPitrPrepareScript,
  buildPitrRecoveryWaitScript,
  buildPitrSeedScript,
  buildWalObjectListScript,
  buildWalRestoreCleanScript,
  buildWalStageScript,
  MAX_STAGE_SEGMENTS,
  parsePitrRestore,
  parsePitrSeed,
  parseWalObjects,
  parseWalStaged,
  pickBase,
  pitrRestoreExitHint,
  recoverableWindow,
  WAL_STAGE_BATCH,
  type BasePick,
  type WalObject,
} from "./pitr-restore-script";

const WINDOW_CACHE_MS = 20_000; // the web card polls; one agent listing per db per 20s is plenty
const LIST_TIMEOUT_MS = 120_000;
const MAX_LIST_PAGES = 50;
const PREPARE_TIMEOUT_MS = 180_000;
const STAGE_TIMEOUT_MS = 600_000; // per batch of WAL_STAGE_BATCH downloads
const SEED_TIMEOUT_MS = 3_600_000; // a multi-GB base tar (base-backup class)
const CLEAN_TIMEOUT_MS = 120_000; // rm -rf of up to 64 GiB of staged WAL
const WAIT_CALL_SEC = 60; // one wait command polls this long, then reports "still replaying" (32)
const PROBE_CALL_SEC = 10; // the orphan sweep's one-shot "has it promoted?" look
const TRANSIENT_RETRY_MS = 5_000; // pause before retrying a step after a transient agent error
const STAGE_RETRY_BUDGET_MS = 10 * 60_000; // keep retrying a transiently failing stage batch this long
const SUCCESS_WRITE_ATTEMPTS = 3;
const TAIL_CAP = 2_000;
/** Segments staged beyond the burst of segments shipped around the target. Object mtime = SHIP time, and the
 *  shipper flushes a backlog in bursts, so the segment holding the records at T can sit anywhere in the burst
 *  that lands at/after T; stage the whole burst (all segments within BURST_WINDOW of the first one at/after T)
 *  plus a margin. Over-staging only costs disk; under-staging fails loud (PG stops short of the target). */
const STAGE_MARGIN = 2;
const BURST_WINDOW_MS = 5 * 60_000;
/** Longer than any possible replay: prepare 3m + staging ≤42 batches×10m (+retries) + seed 1h + wait 4h ≈ 12h. A
 *  RUNNING PITR row older than this that no live run owns is unconditionally an orphan; younger rows are judged
 *  by probing the target (see sweepOrphans). */
const ORPHAN_AFTER_MS = 14 * 3_600_000;
const SWEEP_EVERY_MS = 5 * 60_000;

export const PitrWindowSchema = z.object({
  /** Earliest moment any usable base can restore to (its completion), latest = ship time of the newest contiguous
   *  segment. Both are UPPER-BOUND heuristics: a target needs a committed change after it in the archived WAL. */
  earliest: z.date().nullable(),
  latest: z.date().nullable(),
  approx: z.literal(true),
  reason: z.enum(["not_enabled", "no_base", "agent_offline", "capability", "list_failed", "no_wal"]).nullable(),
  bases: z.array(z.object({ id: z.string(), from: z.date(), to: z.date(), startLsn: z.string(), timeline: z.number() })),
});
export type PitrWindowView = z.infer<typeof PitrWindowSchema>;

export const PitrRestoreStartSchema = z.object({ restoreId: z.string(), databaseId: z.string() });
export type PitrRestoreStartView = z.infer<typeof PitrRestoreStartSchema>;

interface Ctx {
  src: Database;
  target: Database;
  rec: Restore;
  pick: BasePick;
  /** The exact file names to stage: the run truncated to the target burst (+margin) plus every timeline history file. */
  names: string[];
  dest: DestinationSpec; // WAL + base objects (pinned while PITR is on)
  targetTime: Date;
  actor: string;
}

const isTransient = (e: unknown) =>
  e instanceof AgentOfflineException || e instanceof AgentDisconnectedException || e instanceof AgentCommandTimeoutException;

/** Which segments of a contiguous run to stage for `target`: through the burst shipped at/after it, plus a margin. */
export function stageSetFor(run: ReadonlyArray<WalObject>, target: Date): WalObject[] {
  const firstAfter = run.findIndex((o) => o.mtime >= target);
  if (firstAfter < 0) return [...run];
  const burstEnd = run[firstAfter].mtime.getTime() + BURST_WINDOW_MS;
  let last = firstAfter;
  while (last + 1 < run.length && run[last + 1].mtime.getTime() <= burstEnd) last++;
  return run.slice(0, Math.min(run.length, last + 1 + STAGE_MARGIN));
}

/**
 * PITR REPLAY orchestrator (5.6b): "restore this Postgres database as it was at T" → a NEW database. The source is
 * never touched, locked, stopped or recreated. Asynchronous: {@link start} does every refusal, creates the target
 * row (born PROVISIONING, locked at once) and the Restore row, and returns; {@link execute} runs in-process
 * (minutes to hours): prepare staging → stage the WAL needed for T → seed the data volume from the base tar →
 * start the container in recovery → wait for PROMOTE → RUNNING. PROMOTION IS THE COMMIT POINT: nothing after it
 * can fail the restore or reap the database. Any failure before it records a FAILED Restore (homed on the SOURCE,
 * so it survives) and reaps the target — and when the host cleanup could not be PROVEN, the target row is KEPT
 * (status FAILED) so the volume/container/staging dir never become untracked.
 * A hub restart mid-replay leaves a RUNNING row this hub can't finish: {@link sweepOrphans} judges each by probing
 * the target (promoted → SUCCESS, still replaying → leave, dead → reap) and never destroys a promoted database.
 */
@Injectable()
export class PitrRestoreService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PitrRestoreService.name);
  private readonly windowCache = new Map<string, { at: number; value: PitrWindowView }>();
  /** Restore ids this hub is executing right now (the orphan sweep never touches them). */
  private readonly live = new Set<string>();
  /** Source ids with a start() in progress or a replay running — taken SYNCHRONOUSLY so a double submit can't
   *  pass the DB check twice while the first request is still listing WAL. */
  private readonly bySource = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: BackupRunnerService,
    private readonly databases: DatabasesService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    void this.sweepOrphans();
    this.timer = setInterval(() => void this.sweepOrphans(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── window ──

  async window(userId: string, id: string): Promise<PitrWindowView> {
    const db = await this.requireRead(userId, id);
    const cached = this.windowCache.get(id);
    if (cached && Date.now() - cached.at < WINDOW_CACHE_MS) return cached.value;
    const { view } = await this.computeWindow(db);
    this.windowCache.set(id, { at: Date.now(), value: view });
    return view;
  }

  private empty(reason: PitrWindowView["reason"]): PitrWindowView {
    return { earliest: null, latest: null, approx: true, reason, bases: [] };
  }

  /** The window plus the raw picks/objects the replay needs (so start() never recomputes from a stale cache). */
  private async computeWindow(db: Database): Promise<{ view: PitrWindowView; picks: BasePick[]; objects: WalObject[]; dest: DestinationSpec | null }> {
    const none = (reason: PitrWindowView["reason"]) => ({ view: this.empty(reason), picks: [], objects: [], dest: null });
    if ((db.engine as DbEngine) !== "POSTGRES" || !db.pitrEnabled || !db.pitrEnabledAt) return none("not_enabled");
    const rows = await this.prisma.baseBackup.findMany({
      where: {
        databaseId: db.id,
        status: "SUCCESS",
        createdAt: { gte: db.pitrEnabledAt },
        completedAt: { not: null },
        startLsn: { not: null },
        timeline: { not: null },
        destinationId: db.backupDestinationId, // the chain is pinned to one store while PITR is on (null = LOCAL)
      },
      orderBy: { createdAt: "desc" },
    });
    if (rows.length === 0) return none("no_base");
    if (!this.agentWs.isOnline(db.serverId)) return none("agent_offline");
    if (!(await this.agentWs.isCapabilityGranted(db.serverId, "backup"))) return none("capability");
    const dest = await this.runner.destinationSpecById(db.backupDestinationId);
    const objects = await this.listObjects(db, dest);
    if (!objects) return none("list_failed");
    const picks = baseIntervals(rows, objects);
    if (picks.length === 0) return { view: this.empty("no_wal"), picks: [], objects, dest };
    const { earliest, latest } = recoverableWindow(picks);
    const view: PitrWindowView = {
      earliest,
      latest,
      approx: true,
      reason: null,
      bases: picks.map((p) => ({ id: p.base.id, from: p.base.completedAt!, to: p.reach, startLsn: p.base.startLsn!, timeline: p.base.timeline! })),
    };
    return { view, picks, objects, dest };
  }

  /** Every shipped WAL object, cursor-paged. Null = the listing could not be trusted (never "empty"). */
  private async listObjects(db: Database, dest: DestinationSpec): Promise<WalObject[] | null> {
    const all: WalObject[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const r = await this.agentWs.sendCommand(db.serverId, buildWalObjectListScript(db.id, dest, { after }), "backup", LIST_TIMEOUT_MS);
      if (r.exitCode !== 0) return null;
      const parsed = parseWalObjects(r.output, dest);
      if (!parsed) return null;
      all.push(...parsed.objects);
      if (!parsed.more) return all;
      after = parsed.last;
    }
    this.logger.warn(`pitr window for database ${db.id}: WAL listing exceeded ${MAX_LIST_PAGES} pages; chain too long`);
    return null;
  }

  // ── replay ──

  /**
   * Validate everything that can be validated up front, create the target (born PROVISIONING, locked at once) and
   * the Restore row, kick off the replay in the background and return the ids. `done` resolves when the replay
   * has finished (specs await it; the controller discards it).
   */
  async start(
    userId: string,
    id: string,
    input: { targetTime: Date; name?: string; environmentId?: string },
  ): Promise<PitrRestoreStartView & { done: Promise<void> }> {
    const src = await this.requireWrite(userId, id);
    // Synchronous per-source claim (no await between the check and the add): the DB check below cannot see a
    // sibling request that is still listing WAL.
    if (this.bySource.has(src.id)) throw new ConflictException("a point-in-time restore of this database is already running");
    this.bySource.add(src.id);
    let launched = false;
    try {
      if ((src.engine as DbEngine) !== "POSTGRES") throw new BadRequestException("point-in-time restore is supported only for Postgres");
      if (!src.pitrEnabled || !src.pitrEnabledAt) throw new ConflictException("enable PITR on this database first");
      if (!this.agentWs.isOnline(src.serverId)) throw new AgentOfflineException();
      if (!(await this.agentWs.isCapabilityGranted(src.serverId, "backup")) || !(await this.agentWs.isCapabilityGranted(src.serverId, "database"))) {
        throw new ConflictException("grant the 'backup' and 'database' capabilities on this server to restore to a point in time");
      }
      const targetTime = input.targetTime;
      if (!(targetTime instanceof Date) || Number.isNaN(targetTime.getTime())) throw new BadRequestException("invalid target time");
      if (targetTime.getTime() > Date.now()) throw new UnprocessableEntityException("the target time is in the future");
      // Cross-restart backstop for the in-process claim above.
      const inflight = await this.prisma.restore.findFirst({
        where: { databaseId: src.id, kind: RestoreKind.PITR, status: RestoreStatus.RUNNING, createdAt: { gte: new Date(Date.now() - ORPHAN_AFTER_MS) } },
        select: { id: true },
      });
      if (inflight) throw new ConflictException("a point-in-time restore of this database is already running");

      const { view, picks, objects, dest } = await this.computeWindow(src); // fresh, never the cache
      if (view.reason || !dest) throw new UnprocessableEntityException(windowReasonText(view.reason));
      const pick = pickBase(picks.map((p) => p.base), objects, targetTime);
      if (!pick) {
        const hint =
          view.earliest && targetTime < view.earliest
            ? `the earliest recoverable moment is ${view.earliest.toISOString()}`
            : view.latest && targetTime > view.latest
              ? `the latest recoverable moment is ${view.latest.toISOString()}`
              : "no base backup + contiguous WAL covers that moment (a gap in the archived chain)";
        throw new UnprocessableEntityException(`that time is not recoverable: ${hint}`);
      }
      const run = stageSetFor(pick.run, targetTime);
      if (run.length > MAX_STAGE_SEGMENTS) throw new UnprocessableEntityException("too much WAL to replay in one restore; take a newer base backup first");
      const names = [...run.map((o) => o.name), ...objects.filter((o) => o.name.endsWith(".history")).map((o) => o.name)];

      // From here on a row exists: every throw must leave nothing behind.
      const target = await this.databases.createRecoveryTarget(src, { name: input.name, environmentId: input.environmentId }, userId);
      let release: (() => void) | undefined;
      let rec: Restore | undefined;
      try {
        release = this.databases.acquireMaintenance(target.id);
        await this.access.grantResourceAccess(userId, src.teamId, target.id);
        rec = await this.prisma.restore.create({
          data: {
            databaseId: src.id, // homed on the SOURCE: survives a failed target's reap
            sourceDatabaseId: src.id,
            targetDatabaseId: target.id,
            targetTime,
            baseBackupId: pick.base.id,
            kind: RestoreKind.PITR,
            status: RestoreStatus.RUNNING,
            createdBy: userId,
          },
        });
        await this.audit
          .log({ actor: userId, action: "database.pitr.restore.start", target: src.id, meta: { restoreId: rec.id, targetDatabaseId: target.id, targetTime: targetTime.toISOString(), baseBackupId: pick.base.id, segments: run.length } })
          .catch(() => undefined);
      } catch (e) {
        // Nothing may dangle: fail the Restore row if it exists, reap the target, release, rethrow.
        if (rec) await this.prisma.restore.update({ where: { id: rec.id }, data: { status: RestoreStatus.FAILED, errorTail: "could not start the restore", completedAt: new Date() } }).catch(() => undefined);
        await this.databases.reapRecoveryTarget(target, userId);
        release?.();
        throw e;
      }
      this.windowCache.delete(src.id);

      const ctx: Ctx = { src, target, rec, pick: { ...pick, run }, names, dest, targetTime, actor: userId };
      this.live.add(rec.id);
      launched = true;
      const done = this.execute(ctx)
        .catch((e) => this.logger.error(`pitr replay ${ctx.rec.id} crashed: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          this.live.delete(ctx.rec.id);
          this.bySource.delete(src.id);
          release?.();
        });
      return { restoreId: rec.id, databaseId: target.id, done };
    } finally {
      if (!launched) this.bySource.delete(src.id);
    }
  }

  private async execute(ctx: Ctx): Promise<void> {
    const { src, target, pick, dest, targetTime, actor, names } = ctx;
    let promoted: { lsn: string; timeline: number } | null = null;
    try {
      // 1. prepare the staging dir (pull image, PGDATA + uid checks, disk)
      const prep = await this.agentWs.sendCommand(src.serverId, buildPitrPrepareScript(target.id, target.image, names.length), "backup", PREPARE_TIMEOUT_MS);
      if (prep.exitCode !== 0) return this.fail(ctx, "prepare", prep.exitCode, prep.output);
      // 2. stage the WAL (+ timeline history files) in batches; a transient agent error retries the batch for up to
      //    STAGE_RETRY_BUDGET (staging is resumable: present files are skipped); stop at the first real failure
      for (let i = 0; i < names.length; i += WAL_STAGE_BATCH) {
        const batch = names.slice(i, i + WAL_STAGE_BATCH);
        let r: { exitCode: number; output: string } | null = null;
        const retryUntil = Date.now() + STAGE_RETRY_BUDGET_MS;
        while (!r) {
          try {
            r = await this.agentWs.sendCommand(src.serverId, buildWalStageScript(src.id, target.id, batch, dest), "backup", STAGE_TIMEOUT_MS);
          } catch (e) {
            if (!isTransient(e) || Date.now() >= retryUntil) throw e;
            await this.delay(TRANSIENT_RETRY_MS);
          }
        }
        const parsed = parseWalStaged(r.output);
        if (r.exitCode !== 0 || parsed.failed || parsed.staged.length !== batch.length) {
          return this.fail(ctx, "stage", r.exitCode, `${parsed.failed ? `segment ${parsed.failed}: ` : ""}${r.output}`);
        }
      }
      // 3. seed the data volume from the base tar (+ backup_label cross-check)
      const base = await this.prisma.baseBackup.findUnique({ where: { id: pick.base.id } });
      if (!base) return this.fail(ctx, "seed", null, "the base backup row disappeared");
      const seed = await this.agentWs.sendCommand(
        src.serverId,
        buildPitrSeedScript({ id: target.id, image: target.image }, { filename: base.filename }, src.id, dest, pick.startSeg),
        "backup",
        SEED_TIMEOUT_MS,
      );
      if (seed.exitCode !== 0 || !parsePitrSeed(seed.output)) return this.fail(ctx, "seed", seed.exitCode, seed.output);
      // 4. start the container in archive recovery toward the target (docker run returns at once)
      const out = await this.databases.reprovision(target, actor, { pitr: false, recovery: { targetTime } });
      if (out.row.status !== DbStatus.RUNNING) return this.fail(ctx, "start", out.exitCode, out.error ?? out.output);
      // runProvision flips RUNNING when `docker run` exits 0, but the cluster is a read-only hot standby until it
      // promotes — keep it PROVISIONING so nothing presents it as ready.
      await this.prisma.database.update({ where: { id: target.id }, data: { status: DbStatus.PROVISIONING } });
      // 5. wait for PROMOTE (bounded). Each call polls WAIT_CALL_SEC then reports 32 = still replaying. A
      //    transient agent error (reconnect, self-update, hub-side timeout) is NOT a verdict — wait and ask again.
      const spec: DbSpec = this.runner.toSpec(target);
      const budgetMs = Math.min(14_400, Math.max(900, 900 + 20 * names.length)) * 1000;
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        let w: { exitCode: number; output: string };
        try {
          w = await this.agentWs.sendCommand(src.serverId, buildPitrRecoveryWaitScript(spec, WAIT_CALL_SEC), "database", (WAIT_CALL_SEC + 60) * 1000);
        } catch (e) {
          if (!isTransient(e)) throw e;
          await this.delay(TRANSIENT_RETRY_MS);
          continue;
        }
        if (w.exitCode === 0) {
          promoted = parsePitrRestore(w.output);
          if (promoted) break;
          return this.fail(ctx, "wait", 0, w.output);
        }
        if (w.exitCode !== 32) return this.fail(ctx, "wait", w.exitCode, w.output);
      }
      if (!promoted) return this.fail(ctx, "wait", 32, `recovery did not finish within ${Math.round(budgetMs / 60000)} minutes`);
    } catch (e) {
      await this.fail(ctx, "unexpected", null, e instanceof Error ? e.message : String(e));
      return;
    }
    await this.commit(ctx.rec.id, target, src, actor, promoted);
  }

  /** PROMOTED = COMMITTED. Record it with retries; nothing here can fail the restore or reap the database. The
   *  orphan sweep finishes the bookkeeping later if a write still did not land (it sees target RUNNING). */
  private async commit(restoreId: string, target: Database, src: Database, actor: string, promoted: { lsn: string; timeline: number }): Promise<void> {
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      for (let i = 1; i <= SUCCESS_WRITE_ATTEMPTS; i++) {
        try {
          await fn();
          return;
        } catch (e) {
          this.logger.error(`pitr replay ${restoreId}: ${what} failed (attempt ${i}/${SUCCESS_WRITE_ATTEMPTS}): ${e instanceof Error ? e.message : e}`);
          if (i < SUCCESS_WRITE_ATTEMPTS) await this.delay(TRANSIENT_RETRY_MS);
        }
      }
    };
    await attempt("marking the database RUNNING", () => this.prisma.database.update({ where: { id: target.id }, data: { status: DbStatus.RUNNING } }));
    await attempt("recording SUCCESS", () =>
      this.prisma.restore.updateMany({ where: { id: restoreId, status: RestoreStatus.RUNNING }, data: { status: RestoreStatus.SUCCESS, exitCode: 0, completedAt: new Date() } }),
    );
    await this.agentWs.sendCommand(src.serverId, buildWalRestoreCleanScript(target.id), "backup", CLEAN_TIMEOUT_MS).catch(() => undefined);
    await this.audit
      .log({ actor, action: "database.pitr.restore", target: src.id, meta: { restoreId, targetDatabaseId: target.id, status: "SUCCESS", lsn: promoted.lsn, timeline: promoted.timeline } })
      .catch(() => undefined);
  }

  /** Record the failure on the (source-homed) Restore row with an actionable, scrubbed tail, reap the target. If
   *  the host cleanup could not be proven, the target row is KEPT (FAILED) and the tail says what to do. */
  private async fail(ctx: Ctx, step: string, exitCode: number | null, output: string): Promise<void> {
    const { src, target, actor } = ctx;
    const phase = (["prepare", "seed", "stage", "wait"].includes(step) ? step : "wait") as "prepare" | "seed" | "stage" | "wait";
    const hint = step === "start" ? "The restored container could not be started." : step === "unexpected" ? "An unexpected error interrupted the restore." : pitrRestoreExitHint(exitCode, phase);
    let password: string | undefined;
    try {
      password = this.runner.toSpec(src).credentials.password;
    } catch {
      /* nothing to redact */
    }
    const reap = await this.databases.reapRecoveryTarget(target, actor);
    const prefix = `${step}: ${hint}${reapNote(reap)} `;
    // Keep the END of the output (the final FATAL line is the useful one); the prefix never displaces it.
    const scrubbed = scrubRunOutput(output ?? "", [password, ctx.dest.s3?.accessKey, ctx.dest.s3?.secretKey, ctx.dest.encryption?.key]);
    const room = Math.max(0, TAIL_CAP - prefix.length);
    const tail = `${prefix}${scrubbed.length > room ? scrubbed.slice(-room) : scrubbed}`.trim();
    await this.prisma.restore
      .updateMany({ where: { id: ctx.rec.id, status: RestoreStatus.RUNNING }, data: { status: RestoreStatus.FAILED, exitCode, errorTail: tail, completedAt: new Date() } })
      .catch(() => undefined);
    await this.audit.log({ actor, action: "database.pitr.restore", target: src.id, meta: { restoreId: ctx.rec.id, targetDatabaseId: target.id, status: "FAILED", step, exitCode, reaped: reap.cleaned } }).catch(() => undefined);
    await this.notifications
      .fireForEvent(src.teamId, "backup_restore_failed", { dbId: src.id, dbName: `${src.name} (point-in-time restore)`, engine: src.engine, exitCode, errorTail: tail })
      .catch(() => undefined);
  }

  /**
   * RUNNING PITR Restore rows that no live run in THIS hub owns were interrupted by a hub restart. Each is judged
   * by its TARGET, never by age alone: a target already RUNNING (promoted, bookkeeping lost) is recorded SUCCESS;
   * a PROVISIONING target is probed once — promoted → SUCCESS, still replaying → left for the next sweep (the
   * container keeps replaying on its own), dead/absent → reaped + FAILED. Only a row older than ORPHAN_AFTER is
   * reaped without a verdict (agent unreachable for that long). Never destroys a promoted database.
   */
  async sweepOrphans(): Promise<void> {
    let rows: Restore[];
    try {
      rows = await this.prisma.restore.findMany({ where: { kind: RestoreKind.PITR, status: RestoreStatus.RUNNING } });
    } catch (e) {
      this.logger.warn(`pitr orphan sweep: could not list restores: ${e instanceof Error ? e.message : e}`);
      return;
    }
    for (const rec of rows) {
      if (this.live.has(rec.id)) continue;
      if (rec.targetDatabaseId && this.databases.isUnderMaintenance(rec.targetDatabaseId)) continue;
      const stale = Date.now() - rec.createdAt.getTime() > ORPHAN_AFTER_MS;
      try {
        const target = rec.targetDatabaseId ? await this.prisma.database.findUnique({ where: { id: rec.targetDatabaseId } }) : null;
        if (!target) {
          await this.finishOrphan(rec, RestoreStatus.FAILED, "interrupted by a hub restart (the restored database no longer exists)", { reaped: true });
          continue;
        }
        if (target.status === DbStatus.RUNNING) {
          // Promoted and announced, only the bookkeeping was lost.
          await this.finishOrphan(rec, RestoreStatus.SUCCESS, null, { reaped: false });
          continue;
        }
        if (this.agentWs.isOnline(target.serverId)) {
          let probe: { exitCode: number; output: string } | null = null;
          try {
            probe = await this.agentWs.sendCommand(target.serverId, buildPitrRecoveryWaitScript(this.runner.toSpec(target), PROBE_CALL_SEC), "database", (PROBE_CALL_SEC + 30) * 1000);
          } catch (e) {
            if (!isTransient(e)) throw e;
          }
          if (probe && probe.exitCode === 0 && parsePitrRestore(probe.output)) {
            await this.prisma.database.update({ where: { id: target.id }, data: { status: DbStatus.RUNNING } }).catch(() => undefined);
            await this.agentWs.sendCommand(target.serverId, buildWalRestoreCleanScript(target.id), "backup", CLEAN_TIMEOUT_MS).catch(() => undefined);
            await this.finishOrphan(rec, RestoreStatus.SUCCESS, null, { reaped: false });
            continue;
          }
          if (probe && probe.exitCode === 32 && !stale) continue; // still replaying on its own — look again later
          if (!probe && !stale) continue; // agent flickering — look again later
        } else if (!stale) {
          continue; // offline — a verdict needs the agent; give it until ORPHAN_AFTER
        }
        const reap = await this.databases.reapRecoveryTarget(target, "reconciler");
        await this.finishOrphan(rec, RestoreStatus.FAILED, `interrupted by a hub restart${reapNote(reap)}`, { reaped: reap.cleaned });
      } catch (e) {
        this.logger.warn(`pitr orphan sweep: restore ${rec.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private async finishOrphan(rec: Restore, status: RestoreStatus, errorTail: string | null, meta: { reaped: boolean }): Promise<void> {
    // Guarded on RUNNING so a run that finished meanwhile (SUCCESS written) is never overwritten.
    const r = await this.prisma.restore.updateMany({
      where: { id: rec.id, status: RestoreStatus.RUNNING },
      data: { status, exitCode: status === RestoreStatus.SUCCESS ? 0 : null, errorTail, completedAt: new Date() },
    });
    if (r.count === 0) return;
    await this.audit
      .log({ actor: "reconciler", action: "database.pitr.restore", target: rec.databaseId, meta: { restoreId: rec.id, targetDatabaseId: rec.targetDatabaseId, status, step: "orphan", ...meta } })
      .catch(() => undefined);
  }

  /** Overridable in tests (retry pauses). */
  protected delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── authz ──

  private async requireRead(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    if (!(await this.access.teamRole(userId, db.teamId))) throw new ForbiddenException("not a member of this team");
    await this.access.requireResourceAccess(userId, db.teamId, {
      resourceId: db.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, db.environmentId).then((c) => c.projectId),
    });
    return db;
  }

  /** 'databases' (it creates + provisions a database) AND 'backups' (it reads the backup store); a custom image
   *  additionally needs 'apps:config' (the same bar as cloning/verifying such a database). */
  private async requireWrite(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requirePermission(userId, db.teamId, "databases");
    await this.access.requirePermission(userId, db.teamId, "backups");
    if (db.image !== resolveImage(db.engine as DbEngine, db.version)) await this.access.requirePermission(userId, db.teamId, "apps:config");
    return db;
  }
}

function reapNote(reap: ReapOutcome): string {
  if (reap.cleaned) return "";
  return reap.reason === "links"
    ? " (apps are still linked to the restored database — unlink them, then delete it)"
    : " (the host cleanup of the restored container/volume could not be confirmed — delete the FAILED database to retry)";
}

function windowReasonText(reason: PitrWindowView["reason"]): string {
  switch (reason) {
    case "not_enabled":
      return "PITR is not active on this database";
    case "no_base":
      return "no base backup has been taken since PITR was enabled — take one first";
    case "agent_offline":
      return "the server's agent is offline";
    case "capability":
      return "the 'backup' capability is not granted on this server";
    case "list_failed":
      return "the archived WAL could not be listed at the backup destination";
    case "no_wal":
      return "no contiguous archived WAL follows any base backup yet";
    default:
      return "that time is not recoverable";
  }
}
