import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Database, DbStatus } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException, AgentCommandTimeoutException } from "../agent-gateway/agent-offline.exception";
import { DatabasesService } from "../databases/databases.service";
import { buildDbStopScript, dbContainerName, type DbEngine, type DbSpec } from "../databases/database-script";
import { BackupRunnerService } from "./backup-runner.service";
import { WalShipperRunnerService } from "./wal-shipper-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { scrubRunOutput } from "./backup-script";
import { buildPitrPreflightScript, buildPitrVerifyScript, buildWalSpoolPurgeScript, parsePitrVerify, pitrExitHint } from "./pitr-script";

const PREFLIGHT_TIMEOUT_MS = 120_000; // readiness poll (≤60s) + probes + image pull
const STOP_TIMEOUT_MS = 90_000; // docker stop -t 60 + slack
const STOP_GRACE_SEC = 60;
const VERIFY_TIMEOUT_MS = 150_000; // readiness (≤60s) + archive wait (≤60s) + slack
const DRAIN_BUDGET_MS = 300_000; // disable: how long the final WAL drain may loop
const DRAIN_RETRY_MS = 2_000; // disable: pause when a drain tick was skipped (overlap with the scheduled sweep)
/** A row left ARMING (flag on, no stamp) is reconciled only after this long since the hub first saw it — an agent
 *  script may still be finishing after a hub restart (PROVISION_TIMEOUT is 5 min). */
const ARMING_GRACE_MS = 6 * 60_000;
const RECONCILE_EVERY_MS = 60_000;
const TAIL_CAP = 2_000;
const IN_PROGRESS = "a PITR change is already in progress for this database";
const CHANGED = "the database changed state; retry";

export const PitrStatusSchema = z.object({
  enabled: z.boolean(),
  /** OFF = archiving off · ARMING = enable in progress / unverified (flag on, no stamp) · ACTIVE = verified. */
  state: z.enum(["OFF", "ARMING", "ACTIVE"]),
  enabledAt: z.date().nullable(),
  destinationType: z.enum(["LOCAL", "S3"]),
  /** True when ACTIVE but no SUCCESS base backup exists since enabling — WAL alone cannot anchor a recovery. */
  needsBaseBackup: z.boolean(),
});
export type PitrStatusView = z.infer<typeof PitrStatusSchema>;

/**
 * PITR enable/disable orchestration (5.4b). archive_mode is postmaster-level (not reloadable), so turning it on or
 * off is a container RECREATE over the persistent named volume (data survives), done through the same proven
 * provision path as everything else ({@link DatabasesService.reprovision}). Lives in the backups layer so
 * DatabasesService stays free of backups imports (BackupRunnerService → DatabasesService is the only edge).
 *
 * Invariant — the row flag `pitrEnabled` is NEVER false while a container with archive_mode=on can exist (an
 * armed container that nothing drains grows /etc/tugra/wal unbounded). So ENABLE flips the flag FIRST (CAS claim
 * → recreate → verify → stamp), and DISABLE clears it LAST (drain → recreate without archiving → clear). The
 * mirror state (flag on, container not archiving) is harmless and self-heals through the reconciler.
 *
 * Every mutating flow holds {@link DatabasesService.acquireMaintenance} for its whole duration and RE-READS the
 * row under the lock before acting (the pre-lock load is only for authz/early refusals), so a user provision /
 * stop / remove or a sibling transition can never interleave on a stale snapshot. Scheduled backup/base/restore
 * runners do not take that lock, hence the in-flight-work check is repeated right after the claim.
 *
 * State machine with NO new column: (false, null)=OFF · (true, null)=ARMING · (true, stamp)=ACTIVE. Only ACTIVE
 * rows are swept by the WAL shipper, so a verify-in-flight segment is never raced by the shipper.
 */
@Injectable()
export class PitrService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PitrService.name);
  /** When the reconciler first saw a row ARMING (Database has no updatedAt to judge staleness from). */
  private readonly firstSeenArming = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: BackupRunnerService,
    private readonly databases: DatabasesService,
    private readonly shipper: WalShipperRunnerService,
    private readonly scheduler: BackupSchedulerService,
  ) {}

  /** The scheduled base backups are owned by PITR: a disable (or a failed enable) always clears the schedule so a
   *  full-cluster copy never keeps running against a database that is no longer archiving. The flag is cleared in
   *  the same write as the PITR flag; the repeatable removal is best-effort (the tick re-checks the flags). */
  private async dropBaseSchedule(id: string): Promise<void> {
    try {
      await this.scheduler.unscheduleBase(id);
    } catch (e) {
      this.logger.warn(`pitr disable for database ${id}: could not remove the base backup repeatable: ${e instanceof Error ? e.message : e}`);
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    void this.reconcileArming();
    this.timer = setInterval(() => void this.reconcileArming(), RECONCILE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── public API ──

  async status(userId: string, id: string): Promise<PitrStatusView> {
    return this.view(await this.load(userId, id));
  }

  async enable(userId: string, id: string): Promise<PitrStatusView> {
    const snap = await this.load(userId, id);
    if ((snap.engine as DbEngine) !== "POSTGRES") throw new BadRequestException("PITR is supported only for Postgres");
    if (snap.pitrEnabled && snap.pitrEnabledAt) return this.view(snap); // ACTIVE → idempotent
    if (this.databases.isUnderMaintenance(id)) throw new ConflictException(IN_PROGRESS);
    // Reachability + capabilities BEFORE any mutation: the recreate needs 'database'; the shipper that drains the
    // spool needs 'backup' — enabling without it would arm archiving with nothing draining it.
    if (!this.agentWs.isOnline(snap.serverId)) throw new AgentOfflineException();
    await this.requireCapabilities(snap);
    if (!(snap.pitrEnabled && !snap.pitrEnabledAt) && snap.status !== DbStatus.RUNNING) {
      throw new ConflictException("the database must be running to enable PITR");
    }
    await this.refuseWhileWorkInFlight(id);

    // Lock for the WHOLE transition (preflight included), then re-read: the snapshot above is pre-lock.
    const release = this.databases.acquireMaintenance(id);
    try {
      const db = await this.reload(id);
      if (!db || (db.pitrEnabled && db.pitrEnabledAt)) throw new ConflictException(CHANGED);
      const spec = this.runner.toSpec(db);

      if (db.pitrEnabled && !db.pitrEnabledAt) {
        // ARMING left over (hub crash mid-enable): resume the tail rather than re-claiming — same guards applied.
        await this.finishArming(db, userId, spec);
        return this.view(await this.reload(id));
      }
      if (db.status !== DbStatus.RUNNING) throw new ConflictException(CHANGED);

      // Preflight: read-only (+ image pull), so a refusal costs no downtime and needs no rollback.
      const pf = await this.agentWs.sendCommand(db.serverId, buildPitrPreflightScript(spec), "database", PREFLIGHT_TIMEOUT_MS);
      if (pf.exitCode !== 0) {
        throw new ConflictException(`${pitrExitHint(pf.exitCode, "preflight")} ${this.tail(pf.output, spec)}`.trim());
      }

      // CLAIM — the row lock and the flag-first flip in one statement (moveToServer CAS pattern). The flag is now
      // true before any container is armed, so a crash from here on leaves ARMING (safe), never (false, archiving).
      const claimed = await this.prisma.database.updateMany({
        where: { id, status: DbStatus.RUNNING, pitrEnabled: false },
        data: { status: DbStatus.PROVISIONING, pitrEnabled: true },
      });
      if (claimed.count === 0) throw new ConflictException(CHANGED);

      // A scheduled dump/base/restore may have started during the (up to 2 min) preflight — it would be killed by
      // the recreate. Re-check now that we hold the claim; on a hit, hand the row back untouched.
      try {
        await this.refuseWhileWorkInFlight(id);
      } catch (e) {
        await this.prisma.database.updateMany({
          where: { id, pitrEnabled: true, pitrEnabledAt: null },
          data: { status: DbStatus.RUNNING, pitrEnabled: false },
        });
        throw e;
      }

      await this.finishArming(db, userId, spec);
    } finally {
      release();
    }
    return this.view(await this.reload(id));
  }

  async disable(userId: string, id: string, opts: { purgeSpool?: boolean } = {}): Promise<PitrStatusView> {
    const snap = await this.load(userId, id);
    if ((snap.engine as DbEngine) !== "POSTGRES") throw new BadRequestException("PITR is supported only for Postgres");
    if (!snap.pitrEnabled) {
      // OFF: nothing is archiving; an explicit purge of a leftover spool is the only permitted side effect.
      if (opts.purgeSpool) await this.purgeSpool(snap);
      return this.view(snap);
    }
    if (this.databases.isUnderMaintenance(id)) throw new ConflictException(IN_PROGRESS);
    // Fail BEFORE any mutation when the agent is unreachable or a capability is missing — otherwise a
    // stop/drain/recreate chain would stop a healthy database for minutes and end in a misleading failure.
    if (!this.agentWs.isOnline(snap.serverId)) throw new AgentOfflineException();
    await this.requireCapabilities(snap);
    if (snap.pitrEnabledAt && snap.status !== DbStatus.RUNNING && snap.status !== DbStatus.STOPPED) {
      throw new ConflictException("re-provision the database before disabling PITR (its container state is unknown)");
    }
    await this.refuseWhileWorkInFlight(id);

    const release = this.databases.acquireMaintenance(id);
    try {
      const db = await this.reload(id);
      if (!db || !db.pitrEnabled) throw new ConflictException(CHANGED);

      if (!db.pitrEnabledAt) {
        // ARMING: nothing verified yet and the spool holds only a verify attempt → the enable rollback IS the disable.
        const r = await this.rollbackArming(db, userId, "manual-disable", null);
        if (!r.rolledBack) throw new BadGatewayException(r.message);
        return this.view(await this.reload(id));
      }

      // ACTIVE.
      if (db.status !== DbStatus.RUNNING && db.status !== DbStatus.STOPPED) throw new ConflictException(CHANGED);
      const claimed = await this.prisma.database.updateMany({
        // Match the status we OBSERVED under the lock, not any of several.
        where: { id, pitrEnabled: true, pitrEnabledAt: { not: null }, status: db.status },
        data: { status: DbStatus.PROVISIONING }, // the flag STAYS true until a non-archiving container is confirmed
      });
      if (claimed.count === 0) throw new ConflictException(CHANGED);
      const wasRunning = db.status === DbStatus.RUNNING;

      // Post-claim re-check (scheduled runners do not take the lock); on a hit, hand the status straight back.
      try {
        await this.refuseWhileWorkInFlight(id);
      } catch (e) {
        await this.prisma.database.update({ where: { id }, data: { status: db.status } });
        throw e;
      }

      let restored = false; // the pre-disable state has already been put back (nothing more for the catch to do)
      let committed = false; // the flag has been cleared: from here on a failure must NEVER re-arm archiving
      try {
        // A graceful stop makes Postgres flush and archive every remaining segment into the spool before exit. It is
        // STRICT here: we must KNOW nothing is still archiving before trusting a "drained" reading and purging. A
        // missing container counts as stopped; any other failure (or an indeterminate agent drop/timeout — the stop
        // may still complete on the agent) is resolved by RESTORING the real pre-disable state, never by guessing.
        if (wasRunning) {
          const st = await this.stop(db, { strict: true });
          if (!st.ok && !st.missing) {
            await this.restoreAfterFailedDisable(db, userId, wasRunning);
            restored = true;
            await this.audit.log({ actor: userId, action: "database.pitr.disable_failed", target: id, meta: { step: "stop" } });
            throw new BadGatewayException("the database could not be stopped cleanly; PITR is unchanged — retry");
          }
        }

        // FINAL DRAIN: ship until the spool is empty, progress stalls, or the budget ends. A skipped tick is almost
        // always the scheduled sweep holding the shipper's per-db lock (the agent was online a moment ago) — wait
        // and retry rather than giving up; an unexpected shipper error leaves the backlog unknown.
        let backlog = -1;
        let last = Number.POSITIVE_INFINITY;
        const deadline = Date.now() + DRAIN_BUDGET_MS;
        while (Date.now() < deadline) {
          let r: Awaited<ReturnType<WalShipperRunnerService["shipOnce"]>>;
          try {
            r = await this.shipper.shipOnce(db.id);
          } catch (e) {
            this.logger.warn(`pitr disable drain for database ${id} failed: ${e instanceof Error ? e.message : e}`);
            break;
          }
          if (r.skipped) {
            await this.delay(DRAIN_RETRY_MS);
            continue;
          }
          backlog = r.backlog;
          if (backlog === 0 || backlog >= last) break;
          last = backlog;
        }

        if (backlog !== 0 && !opts.purgeSpool) {
          // Nothing may be lost: put archiving back exactly as it was (flag is still true), release the status.
          await this.restoreAfterFailedDisable(db, userId, wasRunning);
          restored = true;
          await this.audit.log({ actor: userId, action: "database.pitr.disable_failed", target: id, meta: { backlog } });
          const n = backlog < 0 ? "an unknown number of" : String(backlog);
          throw new BadGatewayException(
            `${n} WAL segment(s) could not be shipped to the destination; archiving was left on — retry, or disable with purgeSpool to accept losing the un-shipped tail`,
          );
        }

        if (wasRunning) {
          const out = await this.databases.reprovision(db, userId, { pitr: false });
          if (out.row.status !== DbStatus.RUNNING) {
            // Flag stays TRUE (a container may still be archiving); a retry is idempotent.
            restored = true; // the row is honestly FAILED + flagged; nothing further to restore
            await this.audit.log({ actor: userId, action: "database.pitr.disable_failed", target: id, meta: { step: "recreate" } });
            throw new BadGatewayException("the database could not be recreated without archiving; PITR stays enabled — retry once the agent is reachable");
          }
        } else {
          // STOPPED: the stopped container still carries archive_mode=on in its config, so remove it (the data
          // volume is kept) and VERIFY it is gone — nothing can start an archiving container after the flag clears;
          // the next provision recreates it plain from the row.
          const rm = await this.agentWs.sendCommand(db.serverId, this.removeContainerStrict(db), "database", STOP_TIMEOUT_MS);
          if (rm.exitCode !== 0) {
            await this.restoreAfterFailedDisable(db, userId, wasRunning);
            restored = true;
            await this.audit.log({ actor: userId, action: "database.pitr.disable_failed", target: id, meta: { step: "remove" } });
            throw new BadGatewayException("the stopped database container could not be removed; PITR is unchanged — retry");
          }
          await this.prisma.database.update({ where: { id }, data: { status: DbStatus.STOPPED } });
        }

        // Only now — no archiving container exists — may the spool go and the flag clear (flag-LAST).
        if (backlog === 0 || opts.purgeSpool) await this.purgeSpool(db);
        await this.prisma.database.update({ where: { id }, data: { pitrEnabled: false, pitrEnabledAt: null, baseBackupEnabled: false } });
        committed = true;
        await this.dropBaseSchedule(id);
        await this.audit
          .log({ actor: userId, action: "database.pitr.disable", target: id, meta: { drained: backlog === 0, purged: backlog === 0 || !!opts.purgeSpool } })
          .catch(() => undefined); // best-effort: a failed audit after the clear must never re-arm archiving
      } catch (e) {
        // ANY failure after the claim that has not already restored the pre-disable state (agent, prisma, decrypt,
        // typed or not) must never leave the row PROVISIONING with the container stopped and no trace. Once the
        // flag is cleared, however, nothing may ever restore archiving behind it.
        if (!restored && !committed) {
          await this.restoreAfterFailedDisable(db, userId, wasRunning).catch(() => undefined);
          await this.audit
            .log({ actor: userId, action: "database.pitr.disable_failed", target: id, meta: { error: e instanceof Error ? e.message : String(e) } })
            .catch(() => undefined);
        }
        throw e;
      }
    } finally {
      release();
    }
    return this.view(await this.reload(id));
  }

  /**
   * Resolve rows stuck ARMING (hub died between the claim and the stamp). Verify-only first — no restart; a pass
   * stamps, a fail rolls back. Runs at boot and every minute (not under NODE_ENV=test). Each row gets a grace
   * period from when it was first seen so a still-running agent script is never raced, and the row is RE-READ
   * under the lock before acting (the listing is a snapshot; a user may have finished or disabled it meanwhile).
   */
  async reconcileArming(): Promise<void> {
    let rows: Database[];
    try {
      rows = await this.prisma.database.findMany({ where: { engine: "POSTGRES", pitrEnabled: true, pitrEnabledAt: null } });
    } catch (e) {
      this.logger.warn(`pitr reconcile: could not list databases: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const now = Date.now();
    for (const id of [...this.firstSeenArming.keys()]) if (!rows.some((r) => r.id === id)) this.firstSeenArming.delete(id);
    for (const snap of rows) {
      if (this.databases.isUnderMaintenance(snap.id)) continue;
      const seen = this.firstSeenArming.get(snap.id);
      if (seen == null) {
        this.firstSeenArming.set(snap.id, now);
        continue;
      }
      if (now - seen < ARMING_GRACE_MS) continue;
      let release: (() => void) | undefined;
      try {
        release = this.databases.acquireMaintenance(snap.id);
      } catch {
        continue; // raced a user action — next tick
      }
      try {
        const db = await this.reload(snap.id);
        if (!db || !db.pitrEnabled || db.pitrEnabledAt) {
          this.firstSeenArming.delete(snap.id); // no longer ARMING — never act on the stale snapshot
          continue;
        }
        if (!this.agentWs.isOnline(db.serverId)) continue;
        const spec = this.runner.toSpec(db);
        const v = await this.agentWs.sendCommand(db.serverId, buildPitrVerifyScript(spec), "database", VERIFY_TIMEOUT_MS);
        const ok = v.exitCode === 0 ? parsePitrVerify(v.output) : null;
        if (ok) {
          await this.stamp(db.id, "reconciler", ok.wal);
          this.firstSeenArming.delete(db.id);
        } else {
          const r = await this.rollbackArming(db, "reconciler", "reconcile", v.exitCode);
          if (r.rolledBack) this.firstSeenArming.delete(db.id);
        }
      } catch (e) {
        // Offline/timeout: leave ARMING and retry next tick. Anything else is logged, not thrown (a sweep).
        if (!(e instanceof AgentOfflineException || e instanceof AgentCommandTimeoutException)) {
          this.logger.warn(`pitr reconcile for database ${snap.id} failed: ${e instanceof Error ? e.message : e}`);
        }
      } finally {
        release();
      }
    }
  }

  // ── internals ──

  /** The shared enable tail: graceful stop → recreate WITH archiving → verify → stamp; any failure rolls back. */
  private async finishArming(db: Database, actor: string, spec: DbSpec): Promise<void> {
    await this.stop(db); // best-effort here: the recreate's `docker rm -f` is the backstop (data-safe on a named volume)
    const out = await this.databases.reprovision(db, actor, { pitr: true });
    if (out.row.status !== DbStatus.RUNNING) {
      await this.failEnable(db, actor, "recreate", out.error ?? out.output, out.exitCode, spec);
      return;
    }
    let v: { exitCode: number | null; output: string };
    try {
      v = await this.agentWs.sendCommand(db.serverId, buildPitrVerifyScript(spec), "database", VERIFY_TIMEOUT_MS);
    } catch (e) {
      v = { exitCode: null, output: e instanceof Error ? e.message : String(e) };
    }
    const ok = v.exitCode === 0 ? parsePitrVerify(v.output) : null;
    if (!ok) {
      await this.failEnable(db, actor, "verify", v.output, v.exitCode, spec);
      return;
    }
    await this.stamp(db.id, actor, ok.wal);
  }

  private async failEnable(db: Database, actor: string, step: string, tail: string, exitCode: number | null, spec: DbSpec): Promise<never> {
    const r = await this.rollbackArming(db, actor, step, exitCode);
    const hint = step === "verify" ? pitrExitHint(exitCode, "verify") : "The database container could not be recreated.";
    if (r.rolledBack) {
      throw new UnprocessableEntityException(
        `PITR could not be enabled (${step}): ${hint} Postgres was restarted and archiving was turned back off. ${this.tail(tail, spec)}`.trim(),
      );
    }
    throw new InternalServerErrorException(r.message);
  }

  /**
   * The ONLY failure path (enable recreate/verify failure, reconcile failure, manual disable of an ARMING row):
   * recreate WITHOUT archiving, purge the attempt's spool, and clear the flag LAST — only once a non-archiving
   * container is confirmed up, and only if the row is STILL ARMING (the clear is guarded, so a row a user has
   * meanwhile verified ACTIVE or disabled is never touched — reported, not assumed). If the recreate itself fails
   * the row is left (true, null, FAILED): unambiguous ARMING, retryable, and the reconciler keeps attempting it.
   */
  private async rollbackArming(db: Database, actor: string, step: string, exitCode: number | null): Promise<{ rolledBack: boolean; message: string }> {
    await this.stop(db);
    const out = await this.databases.reprovision(db, actor, { pitr: false });
    if (out.row.status === DbStatus.RUNNING) {
      // Preflight guaranteed an empty spool at enable time, so everything in it is from this failed attempt.
      await this.purgeSpool(db);
      const cleared = await this.prisma.database.updateMany({
        where: { id: db.id, pitrEnabled: true, pitrEnabledAt: null },
        data: { pitrEnabled: false, pitrEnabledAt: null, baseBackupEnabled: false, status: DbStatus.RUNNING },
      });
      await this.dropBaseSchedule(db.id);
      await this.audit.log({ actor, action: "database.pitr.enable_failed", target: db.id, meta: { step, exitCode, rolledBack: cleared.count > 0 } });
      if (cleared.count === 0) {
        this.logger.warn(`pitr rollback for database ${db.id}: row was no longer ARMING when the flag was to be cleared`);
        return { rolledBack: false, message: "the database changed state during the rollback; check its PITR status" };
      }
      return { rolledBack: true, message: "rolled back" };
    }
    await this.audit.log({ actor, action: "database.pitr.enable_failed", target: db.id, meta: { step, exitCode, rolledBack: false } });
    return {
      rolledBack: false,
      message: `PITR enable failed (${step}) and the rollback recreate also failed; archiving may still be on with an undrained spool — retry Disable once the agent is reachable`,
    };
  }

  /** Put the pre-disable state back after a failed disable: a running database is recreated WITH archiving (the
   *  flag is still true, so this is exactly where it was — and the real container state, not a guess); a stopped
   *  one just gets its status released. */
  private async restoreAfterFailedDisable(db: Database, actor: string, wasRunning: boolean): Promise<void> {
    if (wasRunning) {
      const out = await this.databases.reprovision(db, actor, { pitr: true });
      if (out.row.status !== DbStatus.RUNNING) {
        this.logger.warn(`pitr disable for database ${db.id}: could not restore the archiving container (row left FAILED, PITR still enabled)`);
      }
    } else {
      await this.prisma.database.update({ where: { id: db.id }, data: { status: DbStatus.STOPPED } });
    }
  }

  private async stamp(id: string, actor: string, wal: string): Promise<void> {
    // Guarded: only an ARMING row is stamped, so a racing disable can never be overwritten back to ACTIVE.
    await this.prisma.database.updateMany({
      where: { id, pitrEnabled: true, pitrEnabledAt: null },
      data: { pitrEnabledAt: new Date(), status: DbStatus.RUNNING },
    });
    await this.audit.log({ actor, action: "database.pitr.enable", target: id, meta: { wal } });
  }

  /** Graceful stop. `strict` reports docker's real outcome: `ok` on exit 0, `missing` when the container does not
   *  exist (nothing to stop — treated as stopped by the caller); the default swallows failures (the recreate's
   *  rm -f is the backstop). An agent drop/timeout is neither ok nor missing — the caller must not guess. */
  private async stop(db: Database, opts: { strict?: boolean } = {}): Promise<{ ok: boolean; missing: boolean }> {
    try {
      const r = await this.agentWs.sendCommand(db.serverId, buildDbStopScript(db, { graceSec: STOP_GRACE_SEC, strict: !!opts.strict }), "database", STOP_TIMEOUT_MS);
      return { ok: r.exitCode === 0, missing: r.exitCode !== 0 && /No such container/i.test(r.output ?? "") };
    } catch {
      return { ok: false, missing: false };
    }
  }

  /** `docker rm -f` the container (data volume kept) and PROVE it is gone — exit 0 only when no such container
   *  remains, so the caller never clears the flag over a still-existing archive_mode=on container. */
  private removeContainerStrict(db: Database): string {
    const name = dbContainerName(db);
    return `docker rm -f ${name} >/dev/null 2>&1 || true\n! docker inspect ${name} >/dev/null 2>&1`;
  }

  private async purgeSpool(db: Database): Promise<void> {
    await this.agentWs.sendCommand(db.serverId, buildWalSpoolPurgeScript(db.id), "database").catch(() => undefined);
  }

  private async requireCapabilities(db: Database): Promise<void> {
    if (!(await this.agentWs.isCapabilityGranted(db.serverId, "database"))) {
      throw new ConflictException("grant the 'database' capability on this server to change PITR");
    }
    if (!(await this.agentWs.isCapabilityGranted(db.serverId, "backup"))) {
      throw new ConflictException("grant the 'backup' capability on this server (the WAL shipper needs it) to change PITR");
    }
  }

  /** A recreate kills an in-flight pg_basebackup / dump / restore — refuse rather than corrupt them. */
  private async refuseWhileWorkInFlight(databaseId: string): Promise<void> {
    const [base, dump, restore] = await Promise.all([
      this.prisma.baseBackup.findFirst({ where: { databaseId, status: "RUNNING" }, select: { id: true } }),
      this.prisma.backup.findFirst({ where: { databaseId, status: "RUNNING" }, select: { id: true } }),
      this.prisma.restore.findFirst({ where: { databaseId, status: "RUNNING" }, select: { id: true } }),
    ]);
    if (base || dump || restore) throw new ConflictException("wait for the running backup/restore to finish before changing PITR");
  }

  /** Overridable in tests (the drain loop's retry pause). */
  protected delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private tail(output: string, spec: DbSpec): string {
    const scrubbed = scrubRunOutput(output ?? "", [spec.credentials.password]);
    return scrubbed.length > TAIL_CAP ? scrubbed.slice(-TAIL_CAP) : scrubbed;
  }

  /** Load + authorize: 'databases' (it recreates the container) AND 'backups' (it arms recurring shipping +
   *  storage), the same bar as scheduling the restore-verify drill. */
  private async load(userId: string, id: string): Promise<Database> {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requirePermission(userId, db.teamId, "databases");
    await this.access.requirePermission(userId, db.teamId, "backups");
    return db;
  }

  private async reload(id: string): Promise<Database> {
    return (await this.prisma.database.findUnique({ where: { id } })) as Database;
  }

  private async view(db: Database): Promise<PitrStatusView> {
    const state: PitrStatusView["state"] = !db.pitrEnabled ? "OFF" : !db.pitrEnabledAt ? "ARMING" : "ACTIVE";
    const dest = await this.runner.destinationSpecById(db.backupDestinationId);
    let needsBaseBackup = false;
    if (state === "ACTIVE" && db.pitrEnabledAt) {
      const base = await this.prisma.baseBackup.findFirst({
        where: { databaseId: db.id, status: "SUCCESS", createdAt: { gte: db.pitrEnabledAt } },
        select: { id: true },
      });
      needsBaseBackup = !base;
    }
    return { enabled: db.pitrEnabled, state, enabledAt: db.pitrEnabledAt, destinationType: dest.type, needsBaseBackup };
  }
}
