import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Prisma, type AppMove, type AppMovePhase, type AppStatus, type Application } from "@prisma/client";
import { APP_MOVE_TERMINAL_PHASES, type AppMoveFailureReason, type AppMoveWarningCode } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { DeployLeaseService } from "../applications/deploy-lease.service";
import { PortAllocatorService } from "../applications/port-allocator.service";
import { DnsAutomationService } from "../dns/dns-automation.service";
import { NotificationsService } from "../notifications/notifications.service";
import { buildCustomCertRemoveScript } from "../deploy/deploy-script";
import { composeProject } from "../deploy/compose-script";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import {
  MOVE_TIMEOUTS,
  buildMoveApplyScript,
  buildMoveCleanupScript,
  buildMovePackScript,
  buildMovePartStatScript,
  buildMovePrepareScript,
  buildMoveSourcePartDropScript,
  buildMoveVerifyStoppedScript,
  hasMarker,
  parseMoveApplyOk,
  parseMovePacked,
  parseMovePart,
  parseMovePrepare,
  parseMoveVolResults,
  scrubMoveOutput,
} from "./app-move-scripts";
import { MovePreflightService } from "./move-preflight.service";
import { PartTransferService, type PartTransferHandle } from "./part-transfer.service";
import { collectReservedPorts, parseExtraPorts } from "./move-preflight";
import { CutoverAckMissing, isValidSnapshot, planCutover, restoreData, type CutoverColumn } from "./move-cutover";
import { repointMoveDomains } from "./move-dns";
import { purgeMoveSource, targetLeftovers } from "./app-move-archive";
import { asArray, type MoveWarning, type StoredVolume } from "./move-types";
import type { MoveAckInput } from "./dto";

const HOUR_MS = 3600_000;
/** Whole-move ceiling: 12 h plus the time to push the data at a pessimistic 5 MiB/s. */
const BASE_DEADLINE_MS = 12 * HOUR_MS;
const FLOOR_BYTES_PER_SEC = 5 * 1024 * 1024;
const LOG_TAIL_MAX = 16 * 1024;
const PART_ATTEMPTS = 3;

/** A move step failed in a way that must roll the move back. `reason` is the stable code the UI translates. */
export class MoveAbort extends Error {
  constructor(
    public readonly reason: AppMoveFailureReason,
    public readonly phase: AppMovePhase,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** The rollback cannot finish right now (an agent it needs is offline): leave the move ROLLING_BACK for recovery. */
export class MoveDefer extends Error {}

/** Timing knobs (tests shrink them; production uses the defaults). */
export interface RunnerTiming {
  heartbeatMs: number;
  deployPollMs: number;
  partRetryBackoffMs: number;
  busyBackoffMs: number;
  busyBackoffMaxMs: number;
  cancelWaitMs: number;
  /** How long the rollback waits for its `move:<id>:rb` deploy (independent of the move's own, possibly spent, deadline). */
  rollbackDeployWaitMs: number;
  /** How long PRECHECK waits for a user deploy that is RUNNING to finish before it gives up (rolls back, source untouched). */
  userDeployWaitMs: number;
}

interface MoveRun {
  moveId: string;
  cancelled: boolean;
  handles: Set<PartTransferHandle>;
  reqs: Map<string, { serverId: string; reqId: string }>;
  log: string[];
  heartbeat?: NodeJS.Timeout;
}

/**
 * The phase machine of an app move. The AppMove row is the source of truth; the in-memory MoveRun is only a cache for
 * cancellation handles. Every phase is persisted BEFORE its side effect and every step is idempotent, so a crash at any
 * point is recoverable (see AppMoveRecoveryService). Invariants the tests assert at every crash point:
 *   - the app is runnable on exactly one server;
 *   - the source volumes are never removed before COMPLETED (and then only by the archive purge);
 *   - Application.serverId changes ONLY inside the cutover transaction (and its inverse in the rollback).
 */
@Injectable()
export class AppMoveRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger(AppMoveRunnerService.name);
  private readonly runs = new Map<string, MoveRun>();
  timing: RunnerTiming = { heartbeatMs: 10_000, deployPollMs: 2_000, partRetryBackoffMs: 2_000, busyBackoffMs: 1_000, busyBackoffMaxMs: 15_000, cancelWaitMs: 60_000, rollbackDeployWaitMs: 30 * 60_000, userDeployWaitMs: 10 * 60_000 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
    private readonly preflights: MovePreflightService,
    private readonly transfers: PartTransferService,
    private readonly portAlloc: PortAllocatorService,
    private readonly dns: DnsAutomationService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly lease: DeployLeaseService,
  ) {}

  onModuleDestroy(): void {
    for (const r of this.runs.values()) if (r.heartbeat) clearInterval(r.heartbeat);
  }

  // ───────────────────────────── entry points ─────────────────────────────

  isRunning(moveId: string): boolean {
    return this.runs.has(moveId);
  }

  /** Drive a move: a fresh one from QUEUED, or an orphaned one (a restarted hub) from wherever it stopped. Never throws. */
  async run(moveId: string): Promise<void> {
    if (this.runs.has(moveId)) return;
    const run: MoveRun = { moveId, cancelled: false, handles: new Set(), reqs: new Map(), log: [] };
    this.runs.set(moveId, run);
    try {
      const claimed = await this.prisma.appMove.updateMany({
        where: { id: moveId, phase: { notIn: APP_MOVE_TERMINAL } },
        data: { ownerId: this.lease.bootId, heartbeatAt: new Date() },
      });
      if (claimed.count !== 1) return;
      run.heartbeat = setInterval(() => void this.beat(moveId), this.timing.heartbeatMs);
      run.heartbeat.unref?.();
      const move = await this.load(moveId);
      await this.dispatch(run, move);
    } catch (e) {
      if (e instanceof MoveDefer) {
        // an agent we need is offline: release the move; the recovery loop retries until its deadline
        await this.prisma.appMove.updateMany({ where: { id: moveId, ownerId: this.lease.bootId }, data: { ownerId: null } }).catch(() => undefined);
      } else {
        this.logger.error(`move ${moveId} crashed: ${e instanceof Error ? e.message : String(e)}`);
        await this.crashed(moveId, e).catch(() => undefined);
      }
    } finally {
      if (run.heartbeat) clearInterval(run.heartbeat);
      this.runs.delete(moveId);
    }
  }

  /** Where a move resumes, by the phase it was left in (the row decides, never the process). */
  private async dispatch(run: MoveRun, move: AppMove): Promise<void> {
    switch (move.phase) {
      case "QUEUED":
        return this.forward(run, move);
      case "PRECHECK":
      case "STOPPING_SOURCE":
      case "TRANSFERRING":
        // streams are not resumable: roll back (cleanup is idempotent; the source was never modified)
        return this.rollback(run, move.id, "hub_restarted", move.phase);
      case "DEPLOYING":
        return this.resumeDeploying(run, move.id);
      case "FINALIZING":
        return this.finalize(run, move.id);
      case "ROLLING_BACK":
        return this.rollback(run, move.id, (move.failureReason as AppMoveFailureReason | null) ?? "hub_restarted", move.failurePhase ?? "TRANSFERRING");
      default:
        return;
    }
  }

  /** Ask a running move to stop: only meaningful before the cutover. Kills in-flight agent commands + relays. */
  requestCancel(moveId: string): void {
    const run = this.runs.get(moveId);
    if (!run) return;
    run.cancelled = true;
    for (const h of run.handles) h.cancel(new Error("move cancelled"));
    for (const r of run.reqs.values()) this.agentWs.cancelCommand(r.serverId, r.reqId);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async load(id: string): Promise<AppMove> {
    const m = await this.prisma.appMove.findUnique({ where: { id } });
    if (!m) throw new Error(`move ${id} not found`);
    return m;
  }

  private async beat(id: string): Promise<void> {
    await this.prisma.appMove.updateMany({ where: { id, ownerId: this.lease.bootId, phase: { notIn: APP_MOVE_TERMINAL } }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
  }

  private async setPhase(id: string, phase: AppMovePhase, data: Prisma.AppMoveUpdateInput = {}): Promise<void> {
    await this.prisma.appMove.update({ where: { id }, data: { phase, ...data } });
  }

  private async setVolumes(id: string, vols: StoredVolume[]): Promise<void> {
    await this.prisma.appMove.update({ where: { id }, data: { volumes: vols as unknown as Prisma.InputJsonValue } });
  }

  private note(run: MoveRun, line: string): void {
    run.log.push(`${new Date().toISOString()} ${scrubMoveOutput(line)}`.slice(0, 600));
  }

  private async flushLog(run: MoveRun): Promise<void> {
    let tail = run.log.join("\n");
    if (tail.length > LOG_TAIL_MAX) tail = tail.slice(tail.length - LOG_TAIL_MAX);
    await this.prisma.appMove.update({ where: { id: run.moveId }, data: { logTail: tail } }).catch(() => undefined);
  }

  /** Persist a warning once (same code + details are not repeated). */
  private async warn(id: string, code: AppMoveWarningCode, details?: Record<string, unknown>): Promise<void> {
    const m = await this.prisma.appMove.findUnique({ where: { id }, select: { warnings: true } });
    const list = asArray<MoveWarning>(m?.warnings);
    const key = JSON.stringify({ code, details: details ?? null });
    if (list.some((w) => JSON.stringify({ code: w.code, details: w.details ?? null }) === key)) return;
    await this.prisma.appMove.update({ where: { id }, data: { warnings: [...list, { code, ...(details ? { details } : {}) }] as unknown as Prisma.InputJsonValue } });
  }

  /** One agent command, tracked so a cancel can kill it. Rejects (never resolves a failure silently) on transport errors. */
  private async cmd(run: MoveRun, serverId: string, script: string, capability: "deploy" | "backup", timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    let reqId: string | undefined;
    try {
      return await this.agentWs.sendCommand(serverId, script, capability, timeoutMs, undefined, (id) => {
        reqId = id;
        run.reqs.set(id, { serverId, reqId: id });
      });
    } finally {
      if (reqId) run.reqs.delete(reqId);
    }
  }

  /** Called between steps: stop for a cancel request or an exceeded deadline (only before the cutover). */
  private async checkpoint(run: MoveRun, id: string, phase: AppMovePhase): Promise<void> {
    if (run.cancelled) throw new MoveAbort("cancelled", phase);
    const m = await this.prisma.appMove.findUnique({ where: { id }, select: { cancelRequested: true, deadlineAt: true } });
    if (m?.cancelRequested) throw new MoveAbort("cancelled", phase);
    if (m?.deadlineAt && m.deadlineAt.getTime() < Date.now()) throw new MoveAbort("deadline_exceeded", phase);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      t.unref?.();
    });
  }

  private acksOf(m: AppMove): Partial<MoveAckInput> {
    return (m.acks && typeof m.acks === "object" ? (m.acks as Partial<MoveAckInput>) : {}) ?? {};
  }

  private plan(m: AppMove): { cheap: boolean; totalBytes: number; partBytes?: number; hostPort?: { from: number | null; to: number | null }; domain?: { to: string | null }; volumes?: { dockerName: string; state: string }[] } {
    return (m.plan && typeof m.plan === "object" ? (m.plan as never) : { cheap: false, totalBytes: 0 }) as never;
  }

  // ───────────────────────────── forward path ─────────────────────────────

  private async forward(run: MoveRun, move: AppMove): Promise<void> {
    const id = move.id;
    const cheap = this.plan(move).cheap === true;
    try {
      await this.precheck(run, id);
      if (!cheap) {
        await this.stopSource(run, id);
        await this.transfer(run, id);
      }
      await this.cutover(run, id);
    } catch (e) {
      let abort = this.asAbort(e, cheap ? "PRECHECK" : (await this.load(id)).phase);
      // a cancel kills the in-flight command, which then looks like a failure: report what actually happened
      if (abort.reason !== "cancelled" && (run.cancelled || (await this.load(id)).cancelRequested)) abort = new MoveAbort("cancelled", abort.phase);
      await this.rollback(run, id, abort.reason, abort.phase);
      return;
    }
    if (cheap) return; // the cheap cutover completed the move in its transaction
    await this.deployPhase(run, id);
  }

  private asAbort(e: unknown, phase: AppMovePhase): MoveAbort {
    if (e instanceof MoveAbort) return e;
    if (e instanceof MoveDefer) throw e;
    this.logger.warn(`move step failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
    return new MoveAbort("internal_error", phase, e instanceof Error ? scrubMoveOutput(e.message) : undefined);
  }

  private async precheck(run: MoveRun, id: string): Promise<void> {
    let move = await this.load(id);
    const plan = this.plan(move);
    const deadline = new Date(Date.now() + BASE_DEADLINE_MS + Math.ceil((plan.totalBytes ?? 0) / FLOOR_BYTES_PER_SEC) * 1000);
    await this.setPhase(id, "PRECHECK", { startedAt: new Date(), deadlineAt: deadline });
    move = await this.load(id);
    await this.checkpoint(run, id, "PRECHECK");

    const app = await this.prisma.application.findUnique({ where: { id: move.appId } });
    if (!app || app.serverId !== move.sourceServerId) throw new MoveAbort("changed_under_us", "PRECHECK");
    const target = await this.prisma.server.findUnique({ where: { id: move.targetServerId } });
    if (!target || target.teamId !== move.teamId) throw new MoveAbort("preflight_changed", "PRECHECK", "target server is gone");

    // A queued user deploy waits for the move (claimNext holds it) and is never a reason to abort. One that is already
    // RUNNING is waited out for a bounded time first, so the preflight below only fails for a deploy that will not end.
    await this.waitForRunningDeploy(run, id, move.appId);

    // Re-probe both agents and rebuild the plan; any structural difference or new blocker rolls back before a byte moves.
    const fresh = await this.preflights.computePreflight(app, target, this.acksOf(move), move.requestedBy, false, id);
    if (!fresh.ok) throw new MoveAbort("preflight_changed", "PRECHECK", fresh.blockers.map((b) => b.code).join(","));
    const shape = (v: { dockerName: string; state: string }[] | undefined): string => JSON.stringify((v ?? []).map((x) => [x.dockerName, x.state]));
    // The volume set, whether the host port changes and the derived domain must match; sizes and the exact reallocated
    // port may legitimately drift while the app runs, so they are not compared.
    const portChanges = (h: { from?: number | null; to?: number | null } | undefined): boolean => (h?.from ?? null) !== (h?.to ?? null);
    if (shape(fresh.plan.volumes) !== shape(plan.volumes) || portChanges(fresh.plan.hostPort) !== portChanges(plan.hostPort) || fresh.plan.domain.to !== plan.domain?.to) {
      throw new MoveAbort("preflight_changed", "PRECHECK", "plan differs from the preflight");
    }
    this.note(run, "precheck ok");
    if (plan.cheap) return;

    // Create the labelled destination volumes (and the staging dir) on the target.
    const vols = asArray<StoredVolume>(move.volumes);
    const toPrepare = vols.filter((v) => v.state === "PENDING");
    const script = buildMovePrepareScript(
      id,
      toPrepare.map((v) => ({ dockerName: v.dockerName, ...(v.kind === "compose" ? { compose: { project: composeProject(app), key: v.name } } : {}) })),
    );
    let r: { exitCode: number; output: string };
    try {
      r = await this.cmd(run, move.targetServerId, script, "backup", MOVE_TIMEOUTS.prepare);
    } catch (e) {
      throw new MoveAbort(this.offline(e) ? "agent_offline" : "prepare_failed", "PRECHECK");
    }
    const created = r.exitCode === 0 ? parseMovePrepare(r.output, toPrepare.map((v) => v.dockerName)) : null;
    if (!created) throw new MoveAbort("prepare_failed", "PRECHECK", scrubMoveOutput(r.output).slice(-200));
    await this.setVolumes(
      id,
      vols.map((v) => (v.state === "PENDING" ? { ...v, createdOnTarget: created[v.dockerName] === true, archiveOverwritten: created[v.dockerName] === false } : v)),
    );
    await this.flushLog(run);
  }

  private async waitForRunningDeploy(run: MoveRun, id: string, appId: string): Promise<void> {
    const where = { appId, status: "RUNNING" as const, OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "move:" } } }] };
    if ((await this.prisma.deployment.count({ where })) === 0) return;
    this.note(run, "waiting for a running deployment of the app to finish");
    const until = Date.now() + this.timing.userDeployWaitMs;
    for (;;) {
      await this.checkpoint(run, id, "PRECHECK");
      if ((await this.prisma.deployment.count({ where })) === 0) return;
      if (Date.now() > until) throw new MoveAbort("preflight_changed", "PRECHECK", "deploy_active: a deployment of the app was still running");
      await this.sleep(this.timing.deployPollMs);
    }
  }

  private offline(e: unknown): boolean {
    return /offline|disconnect|not connected/i.test(e instanceof Error ? e.message : String(e));
  }

  private async stopSource(run: MoveRun, id: string): Promise<void> {
    await this.checkpoint(run, id, "PRECHECK");
    await this.setPhase(id, "STOPPING_SOURCE");
    const move = await this.load(id);
    const app = await this.prisma.application.findUnique({ where: { id: move.appId } });
    if (!app || app.serverId !== move.sourceServerId) throw new MoveAbort("changed_under_us", "STOPPING_SOURCE");
    const life = await this.apps.moveLifecycle(app);
    const stop = async (): Promise<void> => {
      let r: { exitCode: number; output: string };
      try {
        r = await this.cmd(run, move.sourceServerId, life.stop, "deploy", life.timeoutMs);
      } catch (e) {
        throw new MoveAbort(this.offline(e) ? "agent_offline" : "stop_failed", "STOPPING_SOURCE");
      }
      if (r.exitCode !== 0) throw new MoveAbort("stop_failed", "STOPPING_SOURCE", scrubMoveOutput(r.output).slice(-200));
    };
    const verify = async (): Promise<boolean> => {
      try {
        const r = await this.cmd(run, move.sourceServerId, buildMoveVerifyStoppedScript(app.id), "deploy", 60_000);
        return r.exitCode === 0 && hasMarker(r.output, "TUGRA_VX_QUIESCED");
      } catch (e) {
        throw new MoveAbort(this.offline(e) ? "agent_offline" : "stop_unverified", "STOPPING_SOURCE");
      }
    };
    if (move.prevStatus === "RUNNING") await stop();
    let quiet = await verify();
    if (!quiet && move.prevStatus !== "RUNNING") {
      // the app was recorded STOPPED/FAILED yet something of it runs: stop it, then prove it
      await stop();
      quiet = await verify();
    }
    if (!quiet) throw new MoveAbort("stop_unverified", "STOPPING_SOURCE");
    if (move.prevStatus === "RUNNING") {
      // intentional: monitors/alerts treat STOPPED as expected during the move
      await this.prisma.application.updateMany({ where: { id: app.id, serverId: move.sourceServerId }, data: { status: "STOPPED" as AppStatus } });
    }
    this.note(run, "source stopped and verified quiescent");
    await this.flushLog(run);
  }

  private async transfer(run: MoveRun, id: string): Promise<void> {
    await this.checkpoint(run, id, "STOPPING_SOURCE");
    await this.setPhase(id, "TRANSFERRING");
    const move = await this.load(id);
    const vols = asArray<StoredVolume>(move.volumes);
    const src = move.sourceServerId;
    const dst = move.targetServerId;
    const partBytes = this.plan(move).partBytes ?? 256 * 1024 * 1024;

    for (let i = 0; i < vols.length; i++) {
      const vol = vols[i];
      if (vol.state === "SKIPPED" || vol.state === "APPLIED") continue;
      const size = vol.sizeBytes ?? 0;
      await this.checkpoint(run, id, "TRANSFERRING");

      // 1. pack on the source
      if (vol.state === "PENDING") {
        let r: { exitCode: number; output: string };
        try {
          r = await this.cmd(run, src, buildMovePackScript({ moveId: id, idx: i, dockerVolume: vol.dockerName, partBytes }), "backup", MOVE_TIMEOUTS.pack(size));
        } catch (e) {
          throw new MoveAbort(this.offline(e) ? "agent_offline" : "pack_failed", "TRANSFERRING");
        }
        const packed = r.exitCode === 0 ? parseMovePacked(r.output) : null;
        if (!packed) throw new MoveAbort("pack_failed", "TRANSFERRING", scrubMoveOutput(r.output).slice(-200));
        vols[i] = { ...vol, state: "PACKED", parts: packed.parts, partsDone: 0, bytesDone: 0, entries: packed.entries };
        await this.setVolumes(id, vols);
      }

      // 2. every part: stat -> relay (retried) -> drop
      for (let p = vols[i].partsDone; p < vols[i].parts; p++) {
        await this.checkpoint(run, id, "TRANSFERRING");
        let st: { exitCode: number; output: string };
        try {
          st = await this.cmd(run, src, buildMovePartStatScript(id, i, p), "backup", MOVE_TIMEOUTS.stat);
        } catch (e) {
          throw new MoveAbort(this.offline(e) ? "agent_offline" : "part_stat_failed", "TRANSFERRING");
        }
        const info = st.exitCode === 0 ? parseMovePart(st.output) : null;
        if (!info) throw new MoveAbort("part_stat_failed", "TRANSFERRING");
        await this.transferPart(run, id, i, p, info, src, dst);
        // freed ONLY after both ends succeeded; a failed drop is harmless (cleanup removes the staging dir)
        await this.cmd(run, src, buildMoveSourcePartDropScript(id, i, p), "backup", MOVE_TIMEOUTS.drop).catch(() => undefined);
        vols[i] = { ...vols[i], partsDone: p + 1, bytesDone: vols[i].bytesDone + info.size };
        await this.setVolumes(id, vols);
      }
      vols[i] = { ...vols[i], state: "TRANSFERRED" };
      await this.setVolumes(id, vols);

      // 3. apply on the target (verify -> snapshot -> wipe -> extract -> count)
      await this.checkpoint(run, id, "TRANSFERRING");
      let ap: { exitCode: number; output: string };
      try {
        ap = await this.cmd(
          run,
          dst,
          buildMoveApplyScript({ moveId: id, idx: i, dockerVolume: vol.dockerName, restoreId: `${id}_${i}`, expectedEntries: vols[i].entries ?? 0 }),
          "backup",
          MOVE_TIMEOUTS.apply(size),
        );
      } catch (e) {
        // timeout / kill / lost agent: the wipe may have happened with no way to tell. The snapshot of a volume that held an
        // earlier move's archive is then the only intact copy of it: keep it (an empty snapshot of a fresh volume is not).
        if (vol.archiveOverwritten) await this.keepSnapshot(run, id, vols, i);
        throw new MoveAbort(this.offline(e) ? "agent_offline" : "apply_failed", "TRANSFERRING");
      }
      if (ap.exitCode !== 0) {
        // 70 = extract AND rollback both failed: the snapshot is the only intact copy of what the apply wiped
        if (ap.exitCode === 70) await this.keepSnapshot(run, id, vols, i);
        const reason: AppMoveFailureReason = ({ 72: "apply_aborted", 71: "apply_rolled_back", 70: "apply_rollback_failed", 68: "entry_count_mismatch" } as Record<number, AppMoveFailureReason>)[ap.exitCode] ?? "apply_failed";
        throw new MoveAbort(reason, "TRANSFERRING", `exit ${ap.exitCode}: ${scrubMoveOutput(ap.output).slice(-200)}`);
      }
      const entries = parseMoveApplyOk(ap.output);
      if (entries == null || entries !== vols[i].entries) throw new MoveAbort("entry_count_mismatch", "TRANSFERRING");
      vols[i] = { ...vols[i], state: "APPLIED" };
      await this.setVolumes(id, vols);
      this.note(run, `volume ${vol.name} applied (${entries} entries)`);
      await this.flushLog(run);
    }
  }

  /** Flag the apply rollback snapshot of volume `i` as kept (automatic cleanup never removes it) and say so. */
  private async keepSnapshot(run: MoveRun, id: string, vols: StoredVolume[], i: number): Promise<void> {
    vols[i] = { ...vols[i], rollbackKept: true };
    await this.setVolumes(id, vols).catch(() => undefined);
    await this.warn(id, "apply_snapshot_kept", { volume: vols[i].name, snapshot: `tugra_restore_rb_${id}_${i}` }).catch(() => undefined);
    this.note(run, `apply rollback snapshot of volume ${vols[i].name} kept for manual recovery`);
  }

  /** One part through the relay: up to 3 attempts; a busy relay seat waits with backoff and does not count. */
  private async transferPart(run: MoveRun, id: string, idx: number, part: number, info: { size: number; sha256: string }, src: string, dst: string): Promise<void> {
    let attempt = 0;
    let busyWait = this.timing.busyBackoffMs;
    for (;;) {
      await this.checkpoint(run, id, "TRANSFERRING");
      const r = await this.transfers.transfer({ moveId: id, idx, part, size: info.size, sha256: info.sha256, srcServerId: src, dstServerId: dst }, (h) => {
        run.handles.add(h);
      });
      run.handles.clear();
      if (r.ok) return;
      if (r.busy) {
        await this.sleep(busyWait);
        busyWait = Math.min(busyWait * 2, this.timing.busyBackoffMaxMs);
        continue;
      }
      attempt++;
      this.note(run, `part ${part} of volume ${idx} failed (attempt ${attempt}): ${r.detail}`);
      if (run.cancelled) throw new MoveAbort("cancelled", "TRANSFERRING");
      if (attempt >= PART_ATTEMPTS) {
        const reason: AppMoveFailureReason = r.recvExit === 66 ? "sha_mismatch" : r.recvExit === 65 ? "size_mismatch" : "transfer_failed";
        throw new MoveAbort(reason, "TRANSFERRING", r.detail);
      }
      await this.sleep(this.timing.partRetryBackoffMs * attempt);
    }
  }

  // ───────────────────────────── cutover ─────────────────────────────

  private async cutover(run: MoveRun, id: string): Promise<void> {
    await this.checkpoint(run, id, "TRANSFERRING");
    const move = await this.load(id);
    const cheap = this.plan(move).cheap === true;
    const prev = move.phase;
    const target = await this.prisma.server.findUnique({ where: { id: move.targetServerId } });
    if (!target) throw new MoveAbort("changed_under_us", prev);
    const source = await this.prisma.server.findUnique({ where: { id: move.sourceServerId } });
    if (!source) throw new MoveAbort("changed_under_us", prev);
    // The live listening ports on the target (best effort, OUTSIDE the transaction: a network round trip).
    const app0 = await this.prisma.application.findUnique({ where: { id: move.appId } });
    const live = app0?.hostPort != null && !cheap ? await this.portAlloc.probeUsedPorts(target.id).catch(() => new Set<number>()) : new Set<number>();
    const localDestIds = (await this.prisma.backupDestination.findMany({ where: { teamId: move.teamId, type: "LOCAL" }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    const defaultMagicSuffix = process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io";

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${move.appId} FOR UPDATE`;
          const cur = await tx.application.findUnique({ where: { id: move.appId } });
          if (!cur || cur.serverId !== move.sourceServerId) throw new MoveAbort("changed_under_us", prev);

          const [apps, dbs] = await Promise.all([
            tx.application.findMany({ where: { serverId: target.id }, select: { id: true, hostPort: true, portMappings: true, extraPorts: true } }),
            tx.database.findMany({ where: { serverId: target.id }, select: { hostPort: true } }),
          ]);
          const used = collectReservedPorts(apps, dbs, cur.id);
          for (const p of live) used.add(p);
          // The replacement port follows the preflight's rules: free of every reservation on the target (other apps'
          // hostPort / portMappings / extraPorts, databases, live listeners) AND of the ports this app itself bakes in.
          const baked = new Set<number>([...parseExtraPorts(cur.extraPorts), ...parseExtraPorts(cur.portMappings)].map((p) => p.hostPort));
          const taken = new Set<number>([...used, ...baked]);
          const newHostPort = cur.hostPort != null && used.has(cur.hostPort) ? (await this.portAlloc.allocate(target.id, 1, tx, taken))[0] ?? null : null;

          let cp;
          try {
            cp = planCutover({ app: cur, source, target, acks: this.acksOf(move), defaultMagicSuffix, targetUsedPorts: used, newHostPort, bakedPorts: baked });
          } catch (e) {
            if (e instanceof CutoverAckMissing) throw new MoveAbort("changed_under_us", prev, e.message);
            throw e;
          }

          const drains = await tx.logDrain.findMany({ where: { appId: cur.id, serverId: move.sourceServerId }, select: { id: true, serverId: true } });
          const domains = await tx.domain.findMany({ where: { applicationId: cur.id }, select: { id: true, hostname: true } });
          const snapshot = { ...cp.before, logDrains: drains, domains };

          // The move row flips with the app row, atomically: a cancel that landed first (cancelRequested) wins.
          const flipped = await tx.appMove.updateMany({
            where: { id, phase: { in: ["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"] }, cancelRequested: false },
            data: cheap
              ? { phase: "COMPLETED", cutoverAt: new Date(), finishedAt: new Date(), sourcePurgedAt: new Date(), ownerId: null, snapshotBefore: snapshot as unknown as Prisma.InputJsonValue }
              : { phase: "DEPLOYING", cutoverAt: new Date(), snapshotBefore: snapshot as unknown as Prisma.InputJsonValue },
          });
          if (flipped.count !== 1) throw new MoveAbort("cancelled", prev);

          const upd = await tx.application.updateMany({ where: { id: cur.id, serverId: move.sourceServerId }, data: this.toData(cp.data) });
          if (upd.count !== 1) throw new MoveAbort("changed_under_us", prev);
          if (drains.length) await tx.logDrain.updateMany({ where: { id: { in: drains.map((d) => d.id) } }, data: { serverId: target.id } });
          // These rows record where their DATA physically lives (legacy NULL = "the current server").
          await tx.deployment.updateMany({ where: { appId: cur.id, runServerId: null }, data: { runServerId: move.sourceServerId } });
          await tx.volumeBackup.updateMany({
            where: { appId: cur.id, hostServerId: null, OR: [{ destinationId: null }, { destinationId: { in: localDestIds } }] },
            data: { hostServerId: move.sourceServerId },
          });
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      if (e instanceof MoveAbort) throw e;
      throw new MoveAbort("cutover_failed", prev, e instanceof Error ? scrubMoveOutput(e.message) : undefined);
    }
    await this.audit.log({ actor: move.requestedBy, action: "app.move.cutover", target: move.appId, meta: { moveId: id, from: move.sourceServerId, to: move.targetServerId } });
    this.note(run, "cutover committed");
    if (cheap) {
      await this.afterTerminal(run, id, "COMPLETED");
      await this.apps.syncAfterMove(move.appId, [move.sourceServerId, move.targetServerId]).catch(() => undefined);
    } else {
      await this.flushLog(run);
    }
  }

  /** Cutover column values -> a Prisma update payload (JSON columns need an explicit null marker). */
  private toData(d: Partial<Record<CutoverColumn, unknown>>): Prisma.ApplicationUpdateManyMutationInput & { serverId?: string } {
    const out: Record<string, unknown> = { ...d };
    if ("configMounts" in out) out.configMounts = out.configMounts == null ? Prisma.DbNull : (out.configMounts as Prisma.InputJsonValue);
    return out as never;
  }

  // ───────────────────────────── deploy on the target ─────────────────────────────

  private async deployPhase(run: MoveRun, id: string): Promise<void> {
    const move = await this.load(id);
    const failedSyncs = await this.apps.syncAfterMove(move.appId, [move.sourceServerId, move.targetServerId]).catch(() => ["sync"]);
    if (failedSyncs.length) await this.warn(id, "post_cutover_sync_failed", { steps: failedSyncs });
    let depId = move.deploymentId;
    if (!depId) {
      const dep = await this.apps.submitMoveDeploy(move.appId, move.requestedBy, `move:${id}`);
      depId = dep.id;
      await this.prisma.appMove.update({ where: { id }, data: { deploymentId: depId } });
    }
    await this.finishDeploying(run, id, depId);
  }

  /** Recovery entry for DEPLOYING: find/enqueue the move's deploy by its key and wait for it. */
  private async resumeDeploying(run: MoveRun, id: string): Promise<void> {
    const move = await this.load(id);
    let dep = await this.prisma.deployment.findUnique({ where: { appId_idempotencyKey: { appId: move.appId, idempotencyKey: `move:${id}` } } });
    if (!dep) {
      dep = await this.apps.submitMoveDeploy(move.appId, move.requestedBy, `move:${id}`);
    }
    if (move.deploymentId !== dep.id) await this.prisma.appMove.update({ where: { id }, data: { deploymentId: dep.id } });
    await this.finishDeploying(run, id, dep.id);
  }

  private async finishDeploying(run: MoveRun, id: string, depId: string): Promise<void> {
    const outcome = await this.awaitDeployment(id, depId);
    const move = await this.load(id);
    if (outcome === "SUCCESS") {
      if (move.prevStatus === "STOPPED" || move.prevStatus === "FAILED") await this.stopOnTarget(run, id);
      await this.finalize(run, id);
      return;
    }
    if (move.prevStatus === "FAILED") {
      // the app was already failing before the move: leave it on the target, say so, do not roll back
      await this.warn(id, "deploy_failed_after_move");
      await this.prisma.application.updateMany({ where: { id: move.appId, serverId: move.targetServerId }, data: { status: "FAILED" } });
      await this.finalize(run, id);
      return;
    }
    await this.rollback(run, id, outcome === "TIMEOUT" ? "deploy_timeout" : "deploy_failed", "DEPLOYING");
  }

  /**
   * Poll a deployment until it ends. The forward deploy is bounded by the move's deadline; the rollback's fallback deploy
   * passes its own absolute `untilMs` instead - a rollback for deadline_exceeded / deploy_timeout starts with the move
   * deadline already spent, and judging its deploy TIMEOUT on the first poll would fail a rollback that is about to work.
   */
  private async awaitDeployment(id: string, depId: string, untilMs?: number): Promise<"SUCCESS" | "FAILED" | "TIMEOUT"> {
    for (;;) {
      const dep = await this.prisma.deployment.findUnique({ where: { id: depId }, select: { status: true } });
      if (!dep) return "FAILED";
      if (dep.status === "SUCCESS") return "SUCCESS";
      if (dep.status === "FAILED" || dep.status === "CANCELLED") return "FAILED";
      if (untilMs !== undefined) {
        if (Date.now() > untilMs) return "TIMEOUT";
      } else {
        const m = await this.prisma.appMove.findUnique({ where: { id }, select: { deadlineAt: true } });
        if (m?.deadlineAt && m.deadlineAt.getTime() < Date.now()) return "TIMEOUT";
      }
      await this.sleep(this.timing.deployPollMs);
    }
  }

  /** A move of a STOPPED/FAILED app deploys it on the target (to prove it runs there), then stops it again. */
  private async stopOnTarget(run: MoveRun, id: string): Promise<void> {
    const move = await this.load(id);
    const app = await this.prisma.application.findUnique({ where: { id: move.appId } });
    if (!app) return;
    try {
      const life = await this.apps.moveLifecycle(app);
      const r = await this.cmd(run, move.targetServerId, life.stop, "deploy", life.timeoutMs);
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      await this.prisma.application.updateMany({ where: { id: app.id, serverId: move.targetServerId }, data: { status: "STOPPED" } });
    } catch {
      await this.warn(id, "target_stop_failed");
    }
  }

  // ───────────────────────────── finalize ─────────────────────────────

  private async finalize(run: MoveRun, id: string): Promise<void> {
    await this.setPhase(id, "FINALIZING");
    const move = await this.load(id);
    const app = await this.prisma.application.findUnique({ where: { id: move.appId } });

    // (1) DNS: repoint the records Tugra wrote (only with the operator's consent); a failure is a warning.
    if (app && move.repointDns) {
      try {
        const r = await repointMoveDomains({ db: this.prisma as never, dns: this.dns }, move.appId, move.requestedBy);
        if (r.failed.length) await this.warn(id, "dns_repoint_failed", { hostnames: r.failed });
        const target = await this.prisma.server.findUnique({ where: { id: move.targetServerId }, select: { publicIp: true, publicIpv6: true } });
        if (r.manual.length) await this.warn(id, "dns_manual_repoint", { ip: target?.publicIp ?? target?.publicIpv6 ?? null, hostnames: r.manual });
      } catch {
        await this.warn(id, "dns_repoint_failed");
      }
    }

    // (2) the source: remove the app's CONTAINER only (its volumes are the archive) and its uploaded cert
    if (app) {
      try {
        const life = await this.apps.moveLifecycle(app);
        const script = [app.certPem ? buildCustomCertRemoveScript(app.id) : "", life.removeContainer].filter(Boolean).join("\n");
        const r = await this.cmd(run, move.sourceServerId, script, "deploy", life.timeoutMs);
        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      } catch {
        await this.warn(id, "source_cleanup_failed");
      }
    }

    // (3) staging dirs on both hosts
    for (const server of [move.sourceServerId, move.targetServerId]) {
      try {
        const r = await this.cmd(run, server, buildMoveCleanupScript(id), "backup", MOVE_TIMEOUTS.prepare);
        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      } catch {
        await this.warn(id, "staging_cleanup_failed", { serverId: server });
      }
    }

    // (4) done: the archive clock starts now
    await this.afterTerminal(run, id, "COMPLETED");
  }

  /** Terminal bookkeeping shared by the cheap path and finalize: row, audit, notification, queue drain. */
  private async afterTerminal(run: MoveRun, id: string, phase: "COMPLETED" | "ROLLED_BACK" | "FAILED"): Promise<void> {
    const move = await this.load(id);
    const moved = asArray<StoredVolume>(move.volumes).some((v) => v.state === "APPLIED");
    const now = new Date();
    const archiveUntil = moved && phase === "COMPLETED" ? new Date(now.getTime() + move.retainDays * 24 * HOUR_MS) : null;
    if (phase === "COMPLETED") {
      await this.prisma.appMove.update({
        where: { id },
        data: { phase: "COMPLETED", finishedAt: move.finishedAt ?? now, ownerId: null, archiveUntil, ...(moved ? {} : { sourcePurgedAt: move.sourcePurgedAt ?? now }) },
      });
    }
    await this.flushLog(run);
    const [src, dst] = await Promise.all([
      this.prisma.server.findUnique({ where: { id: move.sourceServerId }, select: { name: true } }),
      this.prisma.server.findUnique({ where: { id: move.targetServerId }, select: { name: true } }),
    ]);
    const ctx = { appId: move.appId, appName: move.appName, sourceName: src?.name ?? move.sourceServerId, targetName: dst?.name ?? move.targetServerId, reason: move.failureReason ?? "", archiveUntil: archiveUntil?.toISOString() ?? "" };
    const event = phase === "COMPLETED" ? "app_move_completed" : phase === "ROLLED_BACK" ? "app_move_rolled_back" : "app_move_failed";
    await this.audit.log({ actor: move.requestedBy, action: phase === "COMPLETED" ? "app.move.complete" : phase === "ROLLED_BACK" ? "app.move.rollback" : "app.move.fail", target: move.appId, meta: { moveId: id, reason: move.failureReason ?? undefined } }).catch(() => undefined);
    await this.notifications.fireForEvent(move.teamId, event, ctx).catch(() => undefined);
    void this.apps.drainApp(move.appId).catch(() => undefined);
    if (phase === "COMPLETED" && moved && move.retainDays === 0) {
      void this.purgeArchiveNow(id).catch(() => undefined);
    }
  }

  /** retainDays = 0: remove the archive right away (the sweeper would do it next tick; this just does not wait). */
  private async purgeArchiveNow(id: string): Promise<void> {
    const move = await this.load(id);
    await purgeMoveSource({ prisma: this.prisma as never, agentWs: this.agentWs as never }, move, { stampWhenLive: true });
  }

  // ───────────────────────────── rollback ─────────────────────────────

  /**
   * Undo a move. Idempotent and re-entrant: every step checks what is already done. Source volumes are never touched
   * before COMPLETED, so a failure before the cutover is always recoverable; after the cutover the app row is restored
   * from `snapshotBefore` with a compare-and-set on the server id.
   */
  private async rollback(run: MoveRun, id: string, reason: AppMoveFailureReason, failurePhase: AppMovePhase): Promise<void> {
    let move = await this.load(id);
    if (move.phase !== "ROLLING_BACK") {
      await this.setPhase(id, "ROLLING_BACK", { failureReason: reason, failurePhase, ownerId: this.lease.bootId });
      this.note(run, `rolling back: ${reason}`);
      move = await this.load(id);
    }
    const afterCutover = move.cutoverAt != null;
    const stoppedByUs = (move.failurePhase ?? failurePhase) !== "QUEUED" && (move.failurePhase ?? failurePhase) !== "PRECHECK";

    // 1. kill anything still in flight (commands, relays)
    run.cancelled = true;
    for (const h of run.handles) h.cancel(new Error("rolling back"));
    for (const r of run.reqs.values()) this.agentWs.cancelCommand(r.serverId, r.reqId);

    // 2. the target's move deploy must not run: cancel it (and wait for the RUNNING slot to free up)
    if (afterCutover) await this.cancelMoveDeploys(id, move.appId);

    // 3. restore the app row (CAS on the target server id)
    if (afterCutover) {
      const restored = await this.restoreApp(id);
      if (!restored) return this.markFailed(run, id, "internal_error", "the app row could not be restored");
      const failedSyncs = await this.apps.syncAfterMove(move.appId, [move.sourceServerId, move.targetServerId]).catch(() => ["sync"]);
      if (failedSyncs.length) await this.warn(id, "post_cutover_sync_failed", { steps: failedSyncs });
      // remove the target's container (never its volumes: they are cleaned below, label-checked)
      await this.removeTargetContainer(run, move);
    }

    // 4. target + source staging cleanup (target leftovers retried by the sweeper when an agent is offline). The
    //    "target is clean" stamp is only written with the ROLLED_BACK row below: a FAILED move must keep needing attention.
    const targetDone = await this.cleanupHosts(run, move);

    // 5. bring the app back
    const app = await this.prisma.application.findUnique({ where: { id: move.appId } });
    if (app) {
      if (move.prevStatus === "RUNNING" && stoppedByUs) {
        if (!this.agentWs.isOnline(move.sourceServerId)) throw new MoveDefer();
        const ok = await this.restartSource(run, move, app);
        if (!ok) return this.markFailed(run, id, "source_restart_failed", "the app could not be restarted on the source");
      } else {
        await this.prisma.application.updateMany({ where: { id: app.id, serverId: move.sourceServerId }, data: { status: move.prevStatus as AppStatus } });
      }
    }

    // 6. done
    await this.prisma.appMove.update({ where: { id }, data: { phase: "ROLLED_BACK", finishedAt: new Date(), ownerId: null, ...(targetDone ? { targetPurgedAt: new Date() } : {}) } });
    await this.afterTerminal(run, id, "ROLLED_BACK");
  }

  private async cancelMoveDeploys(id: string, appId: string): Promise<void> {
    const deps = await this.prisma.deployment.findMany({
      where: { appId, idempotencyKey: `move:${id}`, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true },
    });
    for (const d of deps) await this.apps.cancelMoveDeployment(d.id, "Cancelled: the app move was rolled back").catch(() => false);
    const until = Date.now() + this.timing.cancelWaitMs;
    for (;;) {
      const live = await this.prisma.deployment.count({ where: { appId, idempotencyKey: `move:${id}`, status: { in: ["QUEUED", "RUNNING"] } } });
      if (live === 0 || Date.now() > until) return;
      await this.sleep(Math.min(this.timing.deployPollMs, 500));
    }
  }

  /** Inverse of the cutover: one transaction, CAS serverId = target. Returns false when the row is in no known state. */
  private async restoreApp(id: string): Promise<boolean> {
    const move = await this.load(id);
    const snap = move.snapshotBefore as Record<string, unknown> | null;
    if (!snap || typeof snap !== "object") return false;
    // the pre-image columns, apart from the side tables recorded next to them
    const { logDrains, domains: _domains, ...rest } = snap;
    void _domains;
    if (!isValidSnapshot(rest)) return false;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${move.appId} FOR UPDATE`;
        const cur = await tx.application.findUnique({ where: { id: move.appId }, select: { serverId: true } });
        if (!cur) return true; // the app was deleted meanwhile: nothing to restore
        if (cur.serverId === move.sourceServerId) return true; // already restored (idempotent re-entry)
        if (cur.serverId !== move.targetServerId) return false;
        const upd = await tx.application.updateMany({ where: { id: move.appId, serverId: move.targetServerId }, data: this.toData(restoreData(rest as never) as never) });
        if (upd.count !== 1) return false;
        const drains = asArray<{ id: string; serverId: string }>(logDrains);
        for (const d of drains) await tx.logDrain.updateMany({ where: { id: d.id }, data: { serverId: d.serverId } });
        return true;
      },
      { timeout: 30_000 },
    );
  }

  private async removeTargetContainer(run: MoveRun, move: AppMove): Promise<void> {
    if (!this.agentWs.isOnline(move.targetServerId)) {
      await this.warn(move.id, "source_cleanup_failed", { serverId: move.targetServerId });
      return;
    }
    try {
      const app = await this.prisma.application.findUnique({ where: { id: move.appId } });
      if (!app) return;
      const life = await this.apps.moveLifecycle(app);
      await this.cmd(run, move.targetServerId, life.removeContainer, "deploy", life.timeoutMs);
    } catch {
      await this.warn(move.id, "source_cleanup_failed", { serverId: move.targetServerId });
    }
  }

  /** Returns true when the target is provably clean (everything this move left there is gone). Stamps nothing itself. */
  private async cleanupHosts(run: MoveRun, move: AppMove): Promise<boolean> {
    // target: staging + the volumes THIS move created + apply rollback snapshots (label-checked in-script)
    let targetDone = false;
    if (this.agentWs.isOnline(move.targetServerId)) {
      try {
        const lo = targetLeftovers(move);
        const r = await this.cmd(run, move.targetServerId, buildMoveCleanupScript(move.id, lo), "backup", MOVE_TIMEOUTS.prepare);
        const parsed = parseMoveVolResults(r.output, [...lo.removeVolumes, ...lo.removeRollbackFor.map((x) => `tugra_restore_rb_${x}`)]);
        targetDone = r.exitCode === 0 && parsed.complete && parsed.leftover.length === 0;
      } catch {
        targetDone = false;
      }
    }
    // source staging dir (the volumes are never touched)
    if (this.agentWs.isOnline(move.sourceServerId)) {
      await this.cmd(run, move.sourceServerId, buildMoveCleanupScript(move.id), "backup", MOVE_TIMEOUTS.prepare).catch(() => undefined);
    }
    return targetDone;
  }

  /** `docker start` the stopped source; when that is not possible (container gone, compose) deploy it there normally. */
  private async restartSource(run: MoveRun, move: AppMove, app: Application): Promise<boolean> {
    try {
      const life = await this.apps.moveLifecycle(app);
      const r = await this.cmd(run, move.sourceServerId, life.start, "deploy", life.timeoutMs);
      if (r.exitCode === 0) {
        await this.prisma.application.updateMany({ where: { id: app.id, serverId: move.sourceServerId }, data: { status: "RUNNING" } });
        return true;
      }
    } catch (e) {
      if (this.offline(e)) throw new MoveDefer();
    }
    try {
      const dep = await this.apps.submitMoveDeploy(app.id, move.requestedBy, `move:${move.id}:rb`);
      const outcome = await this.awaitDeployment(move.id, dep.id, Date.now() + this.timing.rollbackDeployWaitMs);
      return outcome === "SUCCESS";
    } catch {
      return false;
    }
  }

  /** The rollback itself failed: the app needs a human. The source volumes were never touched. `targetPurgedAt` is
   *  cleared so the needs-attention predicate (FAILED with neither purge stamp) holds; only purge-source lifts it. */
  private async markFailed(run: MoveRun, id: string, reason: AppMoveFailureReason, detail: string): Promise<void> {
    this.note(run, `rollback failed: ${detail}`);
    const move = await this.load(id);
    await this.prisma.appMove.update({ where: { id }, data: { phase: "FAILED", failureReason: move.failureReason ?? reason, finishedAt: new Date(), ownerId: null, targetPurgedAt: null } });
    await this.prisma.application.updateMany({ where: { id: move.appId }, data: { status: "FAILED" } });
    await this.afterTerminal(run, id, "FAILED");
  }

  /** An unexpected exception outside the abort paths: put the move in a state a human can act on. */
  private async crashed(id: string, e: unknown): Promise<void> {
    const move = await this.prisma.appMove.findUnique({ where: { id } });
    if (!move || (APP_MOVE_TERMINAL_PHASES as readonly string[]).includes(move.phase)) return;
    // release it: the recovery loop re-drives (rollback for pre-cutover phases, resume after)
    await this.prisma.appMove.update({ where: { id }, data: { ownerId: null, logTail: `${move.logTail ?? ""}\ninternal error: ${e instanceof Error ? scrubMoveOutput(e.message) : ""}`.slice(-LOG_TAIL_MAX) } });
  }

  /** Recovery gave up (an agent stayed offline past the deadline): FAILED, app marked failed, humans notified. */
  async failNeedsAttention(id: string, reason: AppMoveFailureReason): Promise<void> {
    const run: MoveRun = { moveId: id, cancelled: false, handles: new Set(), reqs: new Map(), log: [`${new Date().toISOString()} gave up: ${reason}`] };
    const move = await this.prisma.appMove.findUnique({ where: { id } });
    if (!move || (APP_MOVE_TERMINAL_PHASES as readonly string[]).includes(move.phase)) return;
    await this.markFailed(run, id, reason, "deadline passed while an agent stayed offline");
  }
}
