import { Injectable, Logger } from "@nestjs/common";
import { Prisma, type ProjectMove } from "@prisma/client";
import type { ProjectMoveFailureCode, ProjectMoveItemView } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { ApplicationsService } from "../applications/applications.service";
import { AppDatabaseLinksService } from "../applications/app-database-links.service";
import { DeployLeaseService } from "../applications/deploy-lease.service";
import { AppMovesService } from "../app-moves/app-moves.service";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { DatabasesService } from "../databases/databases.service";
import { BackupsService } from "../backups/backups.service";
import { isTerminalPhase } from "./project-move-plan";
import { buildReport, reportOk, type ReportApp, type ReportDb } from "./project-move-report";
import { parseItems, parsePlan, type StoredPlan } from "./project-move-state";
import { ProjectMoveVolumeCarryService, VolumeCarryError } from "./project-move-volume-carry.service";
import { dbExtraVolumeName } from "../databases/database-script";

/** A step that failed for a reason the owner can read: the code is one of PROJECT_MOVE_FAILURE_CODES, never a message. */
export class StepError extends Error {
  constructor(readonly code: ProjectMoveFailureCode) {
    super(code);
  }
}

const POLL_MS = 3000;
const APP_MOVE_DEADLINE_MS = 12 * 3600_000;

/**
 * Drives one project move through its phases (lane H). It composes what the platform already does: a database's data travels by a
 * backup restored into a copy on the target, an app travels by the existing app move (volumes, domains, safety copy). All state lives in
 * the `ProjectMove` row; every step reads its stage first, so a restarted hub resumes where it stopped.
 *
 * Order: databases are copied first (the apps that use them are stopped so no write is lost), then each app is unlinked from its database,
 * moved, linked to the copy and redeployed, then the source databases are stopped and set aside as the safety copy.
 *
 * Failure: while every app is still on the source the move rolls back by itself (links put back, apps restarted, the copies removed). Once
 * an app has moved, nothing is undone on its own: the move ends FAILED with a fixed code and the items say where each one is.
 */
@Injectable()
export class ProjectMoveRunnerService {
  private readonly log = new Logger(ProjectMoveRunnerService.name);
  /** Poll interval; tests set it to 0. */
  pollMs = POLL_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
    private readonly links: AppDatabaseLinksService,
    private readonly appMoves: AppMovesService,
    private readonly databases: DatabasesService,
    private readonly backups: BackupsService,
    private readonly lease: DeployLeaseService,
    private readonly carry: ProjectMoveVolumeCarryService,
  ) {}

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  /** Drive the move to the end (or until another process owns it). Safe to call again after a restart. */
  async run(id: string): Promise<void> {
    if (!(await this.claim(id))) return;
    for (let guard = 0; guard < 24; guard++) {
      const row = await this.load(id);
      if (!row || isTerminalPhase(row.phase)) return;
      await this.prisma.projectMove.update({ where: { id }, data: { heartbeatAt: new Date() } });
      try {
        await this.step(row);
      } catch (e) {
        await this.onError(row, e);
      }
    }
  }

  private async claim(id: string): Promise<boolean> {
    const won = await this.prisma.projectMove.updateMany({
      where: { id, phase: { notIn: ["COMPLETED", "ROLLED_BACK", "FAILED"] }, OR: [{ ownerId: null }, { ownerId: this.lease.bootId }] },
      data: { ownerId: this.lease.bootId, heartbeatAt: new Date() },
    });
    return won.count === 1;
  }

  private load(id: string): Promise<ProjectMove | null> {
    return this.prisma.projectMove.findUnique({ where: { id } });
  }

  private async phase(id: string, phase: ProjectMove["phase"], extra: Prisma.ProjectMoveUpdateInput = {}): Promise<void> {
    await this.prisma.projectMove.update({ where: { id }, data: { phase, ...extra } });
    await this.audit.log({ actor: "system", action: "project.move.phase", target: id, meta: { phase } }).catch(() => undefined);
  }

  // ───────────────────────────── phases ─────────────────────────────

  private async step(row: ProjectMove): Promise<void> {
    switch (row.phase) {
      case "QUEUED":
        return this.phase(row.id, "PRECHECK", { startedAt: row.startedAt ?? new Date() });
      case "PRECHECK":
        if (!this.agentWs.isOnline(row.sourceServerId) || !this.agentWs.isOnline(row.targetServerId)) throw new StepError("agent_offline");
        return this.phase(row.id, "MOVING");
      case "MOVING":
        await this.moving(row);
        return this.phase(row.id, "VERIFYING");
      case "VERIFYING":
        return this.verify(row);
      case "CUTOVER": {
        const until = row.retainDays > 0 ? new Date(Date.now() + row.retainDays * 86_400_000) : null;
        await this.phase(row.id, "COMPLETED", { finishedAt: new Date(), archiveUntil: until, ownerId: null });
        await this.audit.log({ actor: row.actorId, action: "project.move.complete", target: row.projectId, meta: { moveId: row.id, to: row.targetServerId } });
        return;
      }
      case "ROLLING_BACK": {
        await this.rollback(row);
        // an undo the owner asked for says so (the code that failed the move is replaced: it was not what ended it)
        return this.phase(row.id, "ROLLED_BACK", { finishedAt: new Date(), ownerId: null, ...(parsePlan(row.plan).ownerRollback ? { failureReason: "rolled_back_by_owner" } : {}) });
      }
      default:
        return;
    }
  }

  private async moving(row: ProjectMove): Promise<void> {
    const plan = parsePlan(row.plan);
    const items = parseItems(row.items);
    const save = async () => {
      await this.prisma.projectMove.update({ where: { id: row.id }, data: { plan: plan as unknown as Prisma.InputJsonValue, items: this.refreshItems(items, plan) as unknown as Prisma.InputJsonValue } });
    };
    const cancelled = async () => (await this.load(row.id))?.cancelRequested === true && (await this.sourceAuthoritative(row, plan));
    const dbItems = items.filter((i) => i.kind === "database");
    const appItems = items.filter((i) => i.kind === "application");

    // 1. Databases: a copy on the target (config only for a database never deployed). Resumable: a copy made before a restart is reused.
    for (const it of dbItems) {
      const st = plan.dbs[it.refId];
      if (!st || (st.stage !== "pending" && st.stage !== "created")) continue;
      if (st.stage === "pending" && (await cancelled())) throw new StepError("cancelled");
      try {
        if (st.configOnly) {
          await this.databases.moveToServer(row.actorId, it.refId, row.targetServerId);
          st.targetDbId = it.refId;
          st.stage = "source_stopped";
        } else {
          if (st.stage === "pending") {
            const copy = await this.databases.clone(row.actorId, it.refId, { name: st.oldName });
            st.targetDbId = copy.id;
            st.stage = "created";
            await save();
          }
          const copyId = st.targetDbId!;
          const cur = await this.prisma.database.findUnique({ where: { id: copyId }, select: { status: true } });
          if (cur?.status === "NEW") {
            await this.databases.moveToServer(row.actorId, copyId, row.targetServerId);
            const view = await this.databases.provision(row.actorId, copyId);
            if (view.status !== "RUNNING") throw new StepError("db_copy_failed");
          } else if (cur?.status !== "RUNNING") {
            throw new StepError("db_copy_failed");
          }
          st.stage = "provisioned";
        }
      } catch (e) {
        if (e instanceof StepError) throw e;
        throw this.wrap(e, "db_copy_failed");
      }
      await save();
    }

    // 2. Freeze the writers: the running apps that use a database being copied stop, so the copy is the whole truth.
    const copying = new Set(Object.entries(plan.dbs).filter(([, d]) => !d.configOnly).map(([id]) => id));
    if (copying.size) {
      const used = await this.prisma.appDatabaseLink.findMany({ where: { appId: { in: appItems.map((a) => a.refId) }, databaseId: { in: [...copying] } }, select: { appId: true } });
      for (const appId of new Set(used.map((u) => u.appId))) {
        if (plan.frozen.includes(appId)) continue;
        const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { status: true } });
        if (app?.status !== "RUNNING") continue;
        await this.apps.stop(row.actorId, appId);
        plan.frozen.push(appId);
        await save();
      }
    }

    // 3. Data: backup, restore into the copy.
    for (const it of dbItems) {
      const st = plan.dbs[it.refId];
      if (!st || st.configOnly) continue;
      if (st.stage === "provisioned") {
        const b = await this.backups.backupNow(row.actorId, it.refId).catch((e: unknown) => {
          throw this.wrap(e, "db_backup_failed");
        });
        if (b.status !== "SUCCESS") throw new StepError("db_backup_failed");
        st.backupId = b.id;
        st.stage = "backed_up";
        await save();
      }
      if (st.stage === "backed_up" && st.backupId && st.targetDbId) {
        await this.backups.restoreTo(row.actorId, it.refId, st.backupId, st.targetDbId).catch((e: unknown) => {
          throw this.wrap(e, "db_restore_failed");
        });
        st.stage = "restored";
        await save();
      }
    }

    // 3b. Extra volumes of a database travel with it: both sides are stopped so the copy matches, the volumes are copied one by one, and the
    // copy is started again. Resumable: the names already copied are stored, the source stays stopped (a rollback starts it again).
    let volIdx = 0;
    for (const it of dbItems) {
      const st = plan.dbs[it.refId];
      if (!st || st.configOnly || st.stage !== "restored" || !st.targetDbId) continue;
      const vols = await this.extraVolumesOf(it.refId);
      if (vols.length === 0) continue;
      const done = new Set(st.volumesDone ?? []);
      if (vols.every((v) => done.has(v.name))) {
        volIdx += vols.length;
        continue;
      }
      try {
        if (!st.sourceStopped) {
          st.sourceStopped = true; // recorded before the stop: a restart in between still knows to start it again on rollback
          await save();
          await this.databases.stop(row.actorId, it.refId);
        }
        const copy = await this.prisma.database.findUnique({ where: { id: st.targetDbId }, select: { status: true } });
        if (copy?.status === "RUNNING") await this.databases.stop(row.actorId, st.targetDbId);
        for (const v of vols) {
          const idx = volIdx++;
          if (done.has(v.name)) continue;
          if (await cancelled()) throw new StepError("cancelled");
          await this.carry.carry({ moveId: row.id, idx, srcServerId: row.sourceServerId, dstServerId: row.targetServerId, srcVolume: dbExtraVolumeName({ id: it.refId }, v.name), dstVolume: dbExtraVolumeName({ id: st.targetDbId }, v.name) });
          done.add(v.name);
          st.volumesDone = [...done];
          await save();
        }
        const view = await this.databases.provision(row.actorId, st.targetDbId);
        if (view.status !== "RUNNING") throw new StepError("db_copy_failed");
      } catch (e) {
        if (e instanceof StepError) throw e;
        if (e instanceof VolumeCarryError) throw e.reason === "agent_offline" ? new StepError("agent_offline") : new StepError("db_volume_failed");
        throw this.wrap(e, "db_volume_failed");
      }
    }

    // 4. Apps, one at a time.
    for (const it of appItems) {
      const st = plan.apps[it.refId];
      if (!st) continue;
      if (st.stage === "pending") {
        if (await cancelled()) throw new StepError("cancelled");
        const app = await this.prisma.application.findUnique({ where: { id: it.refId }, select: { status: true, dbNetwork: true, name: true } });
        if (!app) throw new StepError("unexpected");
        const links = await this.prisma.appDatabaseLink.findMany({ where: { appId: it.refId }, select: { id: true, envVar: true, databaseId: true } });
        // Record everything rollback needs BEFORE the first link is touched, in its own stage: a failure or a restart half-way through the
        // removals still leaves a stored list to put back (rollback restores any app past "pending").
        st.links = links.map((l) => ({ envVar: l.envVar, databaseId: l.databaseId }));
        st.hadDbNetwork = app.dbNetwork;
        st.wasRunning = app.status === "RUNNING" || plan.frozen.includes(it.refId);
        st.stage = "unlinking";
        await save();
      }
      if (st.stage === "unlinking") {
        // The app move refuses an app that still has database links (they are per server): take them off, and put them back on the copies.
        // Re-reads the links that remain, so a restart half-way removes only what is left.
        const left = await this.prisma.appDatabaseLink.findMany({ where: { appId: it.refId }, select: { id: true, envVar: true } });
        const mine = new Set(st.links.map((l) => l.envVar));
        for (const l of left) if (mine.has(l.envVar)) await this.links.remove(row.actorId, it.refId, l.id);
        if (st.hadDbNetwork) await this.prisma.application.update({ where: { id: it.refId }, data: { dbNetwork: false } });
        st.stage = "unlinked";
        await save();
      }
      if (st.stage === "unlinked") {
        const name = (await this.prisma.application.findUnique({ where: { id: it.refId }, select: { name: true } }))?.name ?? it.name;
        const started = await this.appMoves
          .start(row.actorId, it.refId, { targetServerId: row.targetServerId, acknowledge: plan.acks, repointDns: row.repointDns, archiveRetainDays: row.retainDays, confirmName: name })
          .catch((e: unknown) => {
            throw this.wrap(e, "app_move_failed");
          });
        st.moveId = started.moveId;
        st.stage = "moving";
        await save();
      }
      if (st.stage === "moving" && st.moveId) {
        const phase = await this.waitForAppMove(st.moveId, row.id);
        if (phase !== "COMPLETED") throw new StepError(phase === "ROLLED_BACK" ? "app_move_rolled_back" : "app_move_failed");
        const child = await this.prisma.appMove.findUnique({ where: { id: st.moveId }, select: { plan: true } });
        it.tempAddress = tempAddressOf(child?.plan) ?? plan.targetIp;
        st.stage = "moved";
        await save();
      }
      if (st.stage === "moved") {
        for (const l of st.links) {
          const copy = plan.dbs[l.databaseId]?.targetDbId;
          if (!copy) continue;
          await this.links.create(row.actorId, it.refId, { databaseId: copy, envVar: l.envVar }).catch((e: unknown) => {
            throw this.wrap(e, "app_move_failed");
          });
        }
        st.stage = "relinked";
        await save();
      }
      if (st.stage === "relinked") {
        // A frozen app (it was running, we stopped it) or one whose environment just gained its links is recreated, so it starts with them.
        if (st.wasRunning && st.links.length) {
          await this.apps.deploy(row.actorId, it.refId, {}, `pmove:${row.id}:${it.refId}`).catch((e: unknown) => {
            throw this.wrap(e, "app_move_failed");
          });
        }
        st.stage = "redeployed";
        await save();
      }
    }

    // 5. Set the source databases aside as the safety copy: stopped, renamed, kept for `retainDays`.
    for (const it of dbItems) {
      const st = plan.dbs[it.refId];
      if (!st || st.configOnly || st.stage !== "restored") continue;
      await this.databases.stop(row.actorId, it.refId);
      await this.databases.rename(row.actorId, it.refId, `${st.oldName} (before move ${row.id.slice(-6)})`.slice(0, 120));
      st.setAside = true;
      st.stage = "source_stopped";
      await save();
    }
    await save();
  }

  private async waitForAppMove(moveId: string, projectMoveId: string): Promise<string> {
    const deadline = Date.now() + APP_MOVE_DEADLINE_MS;
    for (;;) {
      const m = await this.prisma.appMove.findUnique({ where: { id: moveId }, select: { phase: true } });
      if (!m) throw new StepError("app_move_failed");
      if ((APP_MOVE_TERMINAL as readonly string[]).includes(m.phase)) return m.phase;
      if (Date.now() > deadline) throw new StepError("timeout");
      await this.prisma.projectMove.update({ where: { id: projectMoveId }, data: { heartbeatAt: new Date() } });
      await this.sleep(this.pollMs);
    }
  }

  private async verify(row: ProjectMove): Promise<void> {
    const plan = parsePlan(row.plan);
    const appRows = await this.prisma.application.findMany({
      where: { id: { in: Object.keys(plan.apps) } },
      select: { id: true, name: true, serverId: true, status: true, domain: true, extraDomains: true, domains: { select: { hostname: true } } },
    });
    const apps: ReportApp[] = appRows.map((a) => ({
      id: a.id,
      name: a.name,
      serverId: a.serverId,
      status: a.status,
      wasRunning: plan.apps[a.id]?.wasRunning ?? false,
      hostnames: [a.domain, ...a.extraDomains, ...a.domains.map((d) => d.hostname)].filter((h): h is string => !!h),
    }));
    const dbs: ReportDb[] = [];
    for (const [sourceId, st] of Object.entries(plan.dbs)) {
      const target = st.targetDbId ? await this.prisma.database.findUnique({ where: { id: st.targetDbId }, select: { status: true, serverId: true, name: true } }) : null;
      const source = st.configOnly ? null : await this.prisma.database.findUnique({ where: { id: sourceId }, select: { status: true } });
      const restore = st.targetDbId && !st.configOnly ? await this.prisma.restore.findFirst({ where: { databaseId: st.targetDbId, status: "SUCCESS" }, select: { id: true } }) : null;
      const linked = await Promise.all(
        Object.entries(plan.apps).flatMap(([appId, a]) =>
          a.links.filter((l) => l.databaseId === sourceId).map(async () => !!st.targetDbId && (await this.prisma.appDatabaseLink.count({ where: { appId, databaseId: st.targetDbId } })) > 0),
        ),
      );
      dbs.push({ sourceId, name: st.oldName, configOnly: st.configOnly, target, restoreOk: st.configOnly || !!restore, relinked: linked.every(Boolean), source, setAside: st.setAside === true });
    }
    const report = buildReport({ targetServerId: row.targetServerId, targetIp: plan.targetIp, apps, dbs, repointDns: row.repointDns, retainDays: row.retainDays, warnings: plan.warnings });
    plan.report = report;
    await this.prisma.projectMove.update({ where: { id: row.id }, data: { plan: plan as unknown as Prisma.InputJsonValue } });
    if (!reportOk(report)) {
      await this.phase(row.id, "FAILED", { failureReason: "verify_failed", finishedAt: new Date(), ownerId: null });
      await this.audit.log({ actor: row.actorId, action: "project.move.fail", target: row.projectId, meta: { moveId: row.id, code: "verify_failed" } });
      return;
    }
    await this.phase(row.id, "CUTOVER");
  }

  // ───────────────────────────── failure and rollback ─────────────────────────────

  private wrap(e: unknown, code: ProjectMoveFailureCode): StepError {
    if (e instanceof StepError) return e;
    if (e instanceof AgentOfflineException) return new StepError("agent_offline");
    this.log.warn(`project move step failed (${code}): ${e instanceof Error ? e.constructor.name : "unknown"}`);
    return new StepError(code);
  }

  /** Is any app move this project move started still running? Optionally asks it to cancel (best effort; only an early move can stop). */
  private async childMoveActive(row: ProjectMove, plan: StoredPlan, cancel: boolean): Promise<boolean> {
    let active = false;
    for (const [appId, st] of Object.entries(plan.apps)) {
      if (!st.moveId) continue;
      const m = await this.prisma.appMove.findUnique({ where: { id: st.moveId }, select: { phase: true } });
      if (!m || (APP_MOVE_TERMINAL as readonly string[]).includes(m.phase)) continue;
      active = true;
      if (cancel) await this.appMoves.cancel(row.actorId, appId, st.moveId).catch(() => undefined);
    }
    return active;
  }

  /** Every app of the move is still on the source server: nothing has been cut over, so the move can be undone. */
  private async sourceAuthoritative(row: ProjectMove, plan: StoredPlan): Promise<boolean> {
    const apps = await this.prisma.application.findMany({ where: { id: { in: Object.keys(plan.apps) } }, select: { serverId: true } });
    return apps.every((a) => a.serverId === row.sourceServerId);
  }

  private async onError(row: ProjectMove, e: unknown): Promise<void> {
    const code: ProjectMoveFailureCode = e instanceof StepError ? e.code : e instanceof AgentOfflineException ? "agent_offline" : "unexpected";
    if (!(e instanceof StepError)) this.log.error(`project move failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
    const fresh = (await this.load(row.id)) ?? row;
    const plan = parsePlan(fresh.plan);
    if (fresh.phase === "ROLLING_BACK") {
      await this.phase(row.id, "FAILED", { failureReason: "rollback_incomplete", finishedAt: new Date(), ownerId: null });
      await this.audit.log({ actor: row.actorId, action: "project.move.fail", target: row.projectId, meta: { moveId: row.id, code: "rollback_incomplete" } });
      return;
    }
    // A child app move that is still running (a timeout, a failed poll) may yet land its app on the target: never remove the database copies
    // under it. Ask it to cancel, and end FAILED with the copies kept; the owner decides once it is over.
    if (await this.childMoveActive(fresh, plan, true)) {
      await this.phase(row.id, "FAILED", { failureReason: code, finishedAt: new Date(), ownerId: null });
      await this.audit.log({ actor: row.actorId, action: "project.move.fail", target: row.projectId, meta: { moveId: row.id, code, childActive: true } });
      return;
    }
    if (await this.sourceAuthoritative(fresh, plan)) {
      await this.phase(row.id, "ROLLING_BACK", { failureReason: code });
      await this.audit.log({ actor: row.actorId, action: "project.move.rollback", target: row.projectId, meta: { moveId: row.id, code } });
      return;
    }
    // An app has moved: nothing is undone on its own.
    await this.phase(row.id, "FAILED", { failureReason: code === "unexpected" ? "partial_move" : code, finishedAt: new Date(), ownerId: null });
    await this.audit.log({ actor: row.actorId, action: "project.move.fail", target: row.projectId, meta: { moveId: row.id, code } });
  }

  /** The extra volumes a database declares (name and path only). */
  private async extraVolumesOf(databaseId: string): Promise<Array<{ name: string; path: string }>> {
    const row = await this.prisma.database.findUnique({ where: { id: databaseId }, select: { volumes: true } });
    const v = (row as { volumes?: unknown } | null)?.volumes;
    return Array.isArray(v) ? v.filter((x): x is { name: string; path: string } => !!x && typeof (x as { name?: unknown }).name === "string" && typeof (x as { path?: unknown }).path === "string") : [];
  }

  /** Put everything back as it was: links to the source databases, apps restarted, the copies removed. Idempotent. */
  private async rollback(row: ProjectMove): Promise<void> {
    const plan = parsePlan(row.plan);
    if (plan.ownerRollback) return this.undoMove(row, plan);
    if (!(await this.sourceAuthoritative(row, plan))) throw new StepError("rollback_incomplete");
    if (await this.childMoveActive(row, plan, false)) throw new StepError("rollback_incomplete");
    for (const [appId, st] of Object.entries(plan.apps)) {
      if (st.stage === "pending") continue;
      const existing = await this.prisma.appDatabaseLink.findMany({ where: { appId }, select: { envVar: true } });
      const have = new Set(existing.map((l) => l.envVar));
      for (const l of st.links) {
        if (have.has(l.envVar)) continue;
        await this.links.create(row.actorId, appId, { databaseId: l.databaseId, envVar: l.envVar });
      }
      if (st.links.length === 0 && st.hadDbNetwork) await this.prisma.application.update({ where: { id: appId }, data: { dbNetwork: true } });
    }
    for (const appId of plan.frozen) {
      const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { status: true } });
      if (app && app.status !== "RUNNING") await this.apps.start(row.actorId, appId);
    }
    for (const [sourceId, st] of Object.entries(plan.dbs)) {
      if (!st.targetDbId) continue;
      if (st.configOnly) {
        await this.databases.moveToServer(row.actorId, sourceId, row.sourceServerId).catch(() => undefined);
      } else {
        // The source database was stopped early so its extra volumes could be copied: it runs again before the copy goes.
        if (st.sourceStopped && !st.setAside) await this.databases.provision(row.actorId, sourceId);
        // The copy is ours (we created it) and the source's data was never touched: remove the copy.
        const exists = await this.prisma.database.findUnique({ where: { id: st.targetDbId }, select: { id: true } });
        if (exists) await this.databases.remove(row.actorId, st.targetDbId, { keepVolume: false });
      }
    }
    await this.audit.log({ actor: row.actorId, action: "project.move.rolled_back", target: row.projectId, meta: { moveId: row.id } });
  }

  // ───────────────────────────── the owner's undo of a failed move ─────────────────────────────

  /**
   * Undo a move that ended FAILED after some apps had already moved (the owner asked for it). Order, each step resumable from its stage:
   *  1. every app the move touched is stopped (nothing may write while the data goes back),
   *  2. the links to the database copies come off,
   *  3. each database whose copy an app wrote to is brought back up to date on the source (a backup of the copy restored into the source;
   *     a source that was set aside or stopped early is started and named as before), one whose copy nobody wrote to just comes back,
   *  4. each app that moved goes back with the app move (volumes, domains), one at a time,
   *  5. the apps are linked to the source databases again and started the way they were,
   *  6. the copies are removed (a database that was never deployed is moved back instead).
   * Nothing is removed before everything it could have held has been brought back, and a step that cannot finish fails the undo (the owner
   * can press it again: it continues). Two things are not guaranteed: what an app wrote to a database copy is carried back only by the
   * backup/restore pair, and an app's own safety copy on the source (kept by its first move) is not consulted.
   */
  private async undoMove(row: ProjectMove, plan: StoredPlan): Promise<void> {
    const actor = row.actorId;
    if (await this.childMoveActive(row, plan, false)) throw new StepError("rollback_incomplete");
    const undo = (plan.undo ??= { apps: {}, dbs: {} });
    const save = () => this.prisma.projectMove.update({ where: { id: row.id }, data: { plan: plan as unknown as Prisma.InputJsonValue } });
    const fail = (e: unknown): never => {
      if (e instanceof StepError) throw e;
      this.log.warn(`project move undo failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
      throw new StepError(e instanceof AgentOfflineException ? "agent_offline" : "rollback_incomplete");
    };
    const copyIds = new Set(Object.values(plan.dbs).map((d) => d.targetDbId).filter((x): x is string => !!x));
    const touched = Object.entries(plan.apps).filter(([, a]) => a.stage !== "pending");
    const wroteToCopy = (sourceId: string): boolean => touched.some(([, a]) => (a.stage === "relinked" || a.stage === "redeployed") && a.links.some((l) => l.databaseId === sourceId));

    try {
      // 1. + 2. stop the apps and take their links to copies off
      for (const [appId] of touched) {
        const u = (undo.apps[appId] ??= { stage: "pending" });
        if (u.stage === "pending") {
          const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { status: true } });
          if (app?.status === "RUNNING") await this.apps.stop(actor, appId);
          u.stage = "stopped";
          await save();
        }
        if (u.stage === "stopped") {
          const links = await this.prisma.appDatabaseLink.findMany({ where: { appId }, select: { id: true, databaseId: true } });
          for (const l of links) if (copyIds.has(l.databaseId)) await this.links.remove(actor, appId, l.id);
          u.stage = "unlinked";
          await save();
        }
      }

      // 3. the databases: bring the source up to date and name it as before
      for (const [sourceId, st] of Object.entries(plan.dbs)) {
        if (!st.targetDbId || st.configOnly) continue;
        const d = (undo.dbs[sourceId] ??= { stage: "pending" });
        const mustRun = async (id: string): Promise<void> => {
          const cur = await this.prisma.database.findUnique({ where: { id }, select: { status: true } });
          if (cur?.status !== "RUNNING") {
            const v = await this.databases.provision(actor, id);
            if (v.status !== "RUNNING") throw new StepError("rollback_incomplete");
          }
        };
        if (d.stage === "pending") {
          if (wroteToCopy(sourceId)) {
            await mustRun(sourceId);
            await mustRun(st.targetDbId);
            const b = await this.backups.backupNow(actor, st.targetDbId);
            if (b.status !== "SUCCESS") throw new StepError("rollback_incomplete");
            d.backupId = b.id;
            await save();
            await this.backups.restoreTo(actor, st.targetDbId, b.id, sourceId);
          }
          d.stage = "synced";
          await save();
        }
        if (d.stage === "synced") {
          if (st.setAside || st.sourceStopped) {
            await mustRun(sourceId);
            if (st.setAside) await this.databases.rename(actor, sourceId, st.oldName);
            st.setAside = false;
            st.sourceStopped = false;
          }
          d.stage = "unset";
          await save();
        }
      }

      // 4. + 5. the apps that moved go back, then are linked and started the way they were
      const rows = await this.prisma.application.findMany({ where: { id: { in: touched.map(([id]) => id) } }, select: { id: true, name: true, serverId: true } });
      const where = new Map(rows.map((r) => [r.id, r]));
      for (const [appId, st] of touched) {
        const u = undo.apps[appId];
        const app = where.get(appId);
        if (!app) continue;
        if (u.stage === "unlinked") {
          if (app.serverId === row.targetServerId) {
            const started = await this.appMoves.start(actor, appId, { targetServerId: row.sourceServerId, acknowledge: plan.acks, repointDns: row.repointDns, archiveRetainDays: row.retainDays, confirmName: app.name });
            u.moveId = started.moveId;
            u.stage = "moving";
            await save();
          } else {
            u.stage = "moved";
            await save();
          }
        }
        if (u.stage === "moving" && u.moveId) {
          const phase = await this.waitForAppMove(u.moveId, row.id);
          if (phase !== "COMPLETED") throw new StepError("rollback_incomplete");
          u.stage = "moved";
          await save();
        }
        if (u.stage === "moved") {
          const have = new Set((await this.prisma.appDatabaseLink.findMany({ where: { appId }, select: { envVar: true } })).map((l) => l.envVar));
          for (const l of st.links) if (!have.has(l.envVar)) await this.links.create(actor, appId, { databaseId: l.databaseId, envVar: l.envVar });
          if (st.links.length === 0 && st.hadDbNetwork) await this.prisma.application.update({ where: { id: appId }, data: { dbNetwork: true } });
          u.stage = "relinked";
          await save();
        }
        if (u.stage === "relinked") {
          const cur = await this.prisma.application.findUnique({ where: { id: appId }, select: { status: true } });
          if (st.wasRunning && cur?.status !== "RUNNING") {
            // linked again, so the environment changed: a deploy starts it with the links; an app with none is simply started
            if (st.links.length > 0) await this.apps.deploy(actor, appId, {}, `pmove-undo:${row.id}:${appId}`);
            else await this.apps.start(actor, appId);
          }
          u.stage = "done";
          await save();
        }
      }
      for (const appId of plan.frozen) {
        const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { status: true } });
        if (app && app.status !== "RUNNING" && !touched.some(([id]) => id === appId)) await this.apps.start(actor, appId);
      }

      // 6. the copies go (or, for a database never deployed, the row goes back)
      for (const [sourceId, st] of Object.entries(plan.dbs)) {
        if (!st.targetDbId) continue;
        const d = (undo.dbs[sourceId] ??= { stage: st.configOnly ? "unset" : "pending" });
        if (d.stage === "copy_removed") continue;
        if (st.configOnly) {
          await this.databases.moveToServer(actor, sourceId, row.sourceServerId).catch(() => undefined);
        } else {
          const exists = await this.prisma.database.findUnique({ where: { id: st.targetDbId }, select: { id: true } });
          if (exists) await this.databases.remove(actor, st.targetDbId, { keepVolume: false });
        }
        d.stage = "copy_removed";
        await save();
      }
    } catch (e) {
      fail(e);
    }
    await this.audit.log({ actor, action: "project.move.rolled_back", target: row.projectId, meta: { moveId: row.id, byOwner: true } });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** The items' visible phase, derived from the stored stages. */
  refreshItems(items: ProjectMoveItemView[], plan: StoredPlan): ProjectMoveItemView[] {
    return items.map((i) => {
      if (i.kind === "database") {
        const st = plan.dbs[i.refId];
        const phase = !st ? i.phase : st.stage === "pending" ? "pending" : st.stage === "restored" || st.stage === "source_stopped" ? "moved" : "copying";
        return { ...i, phase, childId: st?.targetDbId ?? i.childId };
      }
      const st = plan.apps[i.refId];
      const phase = !st ? i.phase : st.stage === "pending" ? "pending" : st.stage === "unlinked" || st.stage === "unlinking" ? "preparing" : st.stage === "redeployed" ? "moved" : "moving";
      return { ...i, phase, childId: st?.moveId ?? i.childId };
    });
  }
}

/** Where the app answers on the target before DNS changes: the generated host from the app move's own plan, when it has one. */
function tempAddressOf(plan: unknown): string | null {
  const d = (plan as { domain?: { to?: unknown } } | null)?.domain?.to;
  return typeof d === "string" && d ? d : null;
}
