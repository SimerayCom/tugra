import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MigratorService } from "../migrator/migrator.service";
import { ApplicationsService } from "../applications/applications.service";
import { DatabasesService } from "../databases/databases.service";
import type { CreateDatabaseInput } from "../databases/dto";
import { ImporterService } from "./importer.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { planImport } from "./import-planner";
import { foreignAppToCreateInput } from "./apply-map";
import { seedTasks, deriveOpStatus, type TaskSeed, type TaskStatus } from "./import-executor.logic";
import type { ForeignApp, ForeignDb } from "./foreign-fleet";

/** Engines Tugra can provision a resource for — a discovered DB with any other engine (e.g. UNKNOWN)
 *  is skipped by a plan blocker, but we re-check here so a bad engine never reaches DatabasesService. */
const PROVISIONABLE_ENGINES = new Set(["POSTGRES", "MYSQL", "REDIS", "MONGO", "MARIADB", "KEYDB", "DRAGONFLY", "CLICKHOUSE", "LIBSQL"]);
import type { ImportSource } from "./import-source";
import type { ImportApplyInput } from "./dto";

const CONCURRENCY = 5;
const STALE_RUNNING_MS = 10 * 60_000; // a RUNNING task older than this is treated as a dead worker's leftover
const msg = (e: unknown): string => (e instanceof Error ? e.message : "failed");

/**
 * Applies an import plan, persisted as a BulkOperation(kind="import") with one typed task per plan item so
 * progress survives the request and can be polled, cancelled, or rolled back. Two modes:
 *  - local-docker: in-place ADOPTION via {@link MigratorService.adopt} (re-inspects + renames under Tugra).
 *  - coolify: COPY-mode — each app is created fresh on a target server from its resolved spec + secrets,
 *    and each database is provisioned as an empty resource (its DATA is restored later by the migrator).
 * Volume items are still recorded as skipped (they are declared on / restored with their owner). No secret
 * VALUES are ever stored on a task or returned.
 */
@Injectable()
export class ImportExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly migrator: MigratorService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly importer: ImporterService,
    private readonly apps: ApplicationsService,
    private readonly dbs: DatabasesService,
  ) {}

  apply(userId: string, input: ImportApplyInput): Promise<{ opId: string }> {
    return input.sourceKind === "local-docker" ? this.applyLocalDocker(userId, input) : this.applyCoolify(userId, input);
  }

  /** Re-discover + re-plan, enforce the reviewed plan via planHash, then persist + fan out the adoptions. */
  private async applyLocalDocker(userId: string, input: Extract<ImportApplyInput, { sourceKind: "local-docker" }>): Promise<{ opId: string }> {
    const source = new LocalDockerSource(this.migrator, userId, input.serverId);
    const fleet = await source.discover(); // enforces apps:config + blanks env values
    const plan = planImport(fleet, { sourceKind: "local-docker", targetServerId: input.serverId });
    if (plan.planHash !== input.planHash) {
      throw new ConflictException("the plan changed since it was previewed — re-run the plan and review again");
    }
    await this.assertNoInflight(input.serverId);
    const seeds = seedTasks(plan, fleet);
    const op = await this.createOp(userId, "local-docker", input.serverId, plan.planHash, { plan });

    const byId = new Map<string, TaskSeed>();
    for (const s of seeds) {
      const task = await this.prisma.bulkTask.create({
        data: {
          opId: op.id,
          serverId: input.serverId,
          kind: s.kind,
          itemRef: s.itemRef,
          status: s.run ? "PENDING" : "SKIPPED",
          dependsOn: s.dependsOn,
          output: s.run ? null : s.skipReason,
          result: { name: s.name }, // the proposed/source name — secret-free; merged with appId on success
          compensation: s.adopt ? { originalName: s.adopt.originalName } : undefined,
        },
      });
      if (s.run && s.adopt) byId.set(task.id, s);
    }
    await this.audit.log({ actor: userId, action: "import.apply", target: op.id, meta: { sourceKind: "local-docker", serverId: input.serverId, run: byId.size, total: seeds.length } });
    void this.fanout(op.id, [...byId.keys()], (taskId) => this.runAdopt(taskId, input.serverId, userId, byId.get(taskId)!)).catch(() => undefined);
    return { opId: op.id };
  }

  /** Copy a Coolify fleet's apps onto a target Tugra server: per app, resolve its secrets and create it. */
  private async applyCoolify(userId: string, input: Extract<ImportApplyInput, { sourceKind: "coolify" }>): Promise<{ opId: string }> {
    const { source } = await this.importer.openSession(userId, input.sessionId); // session ownership + team authz
    try {
      const fleet = await source.discover();
      const plan = planImport(fleet, { sourceKind: "coolify" });
      if (plan.planHash !== input.planHash) {
        throw new ConflictException("the plan changed since it was previewed — re-run the plan and review again");
      }
      // Authorize the TARGET server up front (fail fast with 403/404, before taking the per-server lock or
      // writing any op/task rows) — openSession only vouches for the session's team, not the import target.
      const server = await this.prisma.server.findUnique({ where: { id: input.targetServerId } });
      if (!server) throw new NotFoundException("target server not found");
      await this.access.requirePermission(userId, server.teamId, "apps:config");
      await this.assertNoInflight(input.targetServerId);

      const op = await this.createOp(userId, "coolify", input.targetServerId, plan.planHash, { sessionId: input.sessionId, plan });
      // Idempotency: skip app refs a prior op already imported onto this target (and whose app still exists),
      // so a re-apply after a partial/cancelled run does not create duplicate Tugra apps.
      const already = await this.alreadyImported(input.targetServerId, plan.items.map((i) => i.itemRef), op.id);

      const appByRef = new Map(fleet.apps.map((a) => [`app:${a.serverRef ?? "_"}:${a.sourceRef}`, a]));
      const dbByRef = new Map(fleet.databases.map((d) => [`database:${d.serverRef ?? "_"}:${d.sourceRef}`, d]));
      // Per task, the exact work to run. Apps are copied; databases are provisioned as empty resources
      // (their DATA is restored later by the migrator) so a destResourceId exists to restore INTO.
      // Volumes are still skipped here — they are declared on / restored with their owning app/db.
      const runners = new Map<string, () => Promise<void>>();
      for (const item of plan.items) {
        const app = item.kind === "app" ? appByRef.get(item.itemRef) : undefined;
        const db = item.kind === "database" ? dbByRef.get(item.itemRef) : undefined;
        const dup = already.has(item.itemRef);
        const hasBlocker = item.risks.some((r) => r.level === "blocker");
        const provisionableDb = !!db && PROVISIONABLE_ENGINES.has(db.engine);
        const runnable = !dup && !hasBlocker && ((item.kind === "app" && !!app) || (item.kind === "database" && provisionableDb));
        const reason = dup
          ? "already imported onto this server in a previous run"
          : hasBlocker
            ? "blocked by a plan risk"
            : item.kind === "volume"
              ? "volume data is not copied by this import yet — it is restored with its app/database"
              : item.kind === "database" && !provisionableDb
                ? "database engine has no Tugra equivalent"
                : "could not resolve the source resource";
        const task = await this.prisma.bulkTask.create({
          data: {
            opId: op.id,
            serverId: input.targetServerId,
            kind: item.kind,
            itemRef: item.itemRef,
            status: runnable ? "PENDING" : "SKIPPED",
            dependsOn: item.dependsOn,
            output: runnable ? null : reason,
            result: { name: item.name },
          },
        });
        if (runnable && app) runners.set(task.id, () => this.runCopyApp(task.id, source, app, userId, input.targetServerId, input.environmentId));
        else if (runnable && db) runners.set(task.id, () => this.runCreateDb(task.id, db, userId, input.targetServerId, input.environmentId));
      }
      await this.audit.log({ actor: userId, action: "import.apply", target: op.id, meta: { sourceKind: "coolify", serverId: input.targetServerId, run: runners.size, total: plan.items.length } });
      void this.fanout(op.id, [...runners.keys()], (taskId) => runners.get(taskId)!())
        .catch(() => undefined)
        .finally(() => source.close()); // close only once the async fan-out is done with the client
      return { opId: op.id };
    } catch (e) {
      // Any failure before the fan-out is handed the source → close it here (the fan-out's finally won't run).
      await source.close();
      throw e;
    }
  }

  /** Source refs already imported onto `serverId` by a PRIOR op whose created app/database still exists →
   *  skip on re-apply (so a retry after a partial/cancelled run never creates a duplicate app or DB). */
  private async alreadyImported(serverId: string, itemRefs: string[], excludeOpId: string): Promise<Set<string>> {
    const prior = await this.prisma.bulkTask.findMany({
      where: { itemRef: { in: itemRefs }, status: "DONE", resourceType: { in: ["application", "database"] }, serverId, opId: { not: excludeOpId } },
      select: { itemRef: true, resourceId: true, resourceType: true },
    });
    if (!prior.length) return new Set();
    const idsOf = (type: string) => prior.filter((p) => p.resourceType === type && p.resourceId).map((p) => p.resourceId as string);
    const appIds = idsOf("application");
    const dbIds = idsOf("database");
    const liveApps = new Set(appIds.length ? (await this.prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true } })).map((a) => a.id) : []);
    const liveDbs = new Set(dbIds.length ? (await this.prisma.database.findMany({ where: { id: { in: dbIds } }, select: { id: true } })).map((d) => d.id) : []);
    const out = new Set<string>();
    for (const p of prior) {
      if (!p.itemRef || !p.resourceId) continue;
      const live = p.resourceType === "database" ? liveDbs : liveApps;
      if (live.has(p.resourceId)) out.add(p.itemRef);
    }
    return out;
  }

  /** One import per target server at a time (a small check-then-create window remains; create/adopt guards back it). */
  private async assertNoInflight(serverId: string): Promise<void> {
    const inflight = await this.prisma.bulkOperation.findFirst({
      where: { kind: "import", meta: { path: ["serverId"], equals: serverId }, tasks: { some: { status: { in: ["PENDING", "RUNNING"] } } } },
      select: { id: true },
    });
    if (inflight) throw new ConflictException("an import for this server is already in progress");
  }

  private createOp(userId: string, sourceKind: string, serverId: string, planId: string, extra: Record<string, unknown> = {}) {
    return this.prisma.bulkOperation.create({
      data: { actorId: userId, command: "", kind: "import", planId, meta: { sourceKind, serverId, ...extra } },
    });
  }

  private async fanout(opId: string, taskIds: string[], run: (taskId: string) => Promise<void>): Promise<void> {
    let i = 0;
    const worker = async () => {
      while (i < taskIds.length) {
        const taskId = taskIds[i++]; // no await between read+increment → safe on the event loop
        try {
          const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { cancelRequestedAt: true } });
          if (op?.cancelRequestedAt) {
            await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "CANCELLED", finishedAt: new Date() } });
            continue;
          }
          await run(taskId);
        } catch {
          // A DB/transport error on one task must not kill the worker or the sibling tasks. The stale-RUNNING
          // reaper in loadOwnedOp settles anything stuck, and the op can be retried.
        }
      }
    };
    const n = Math.min(CONCURRENCY, taskIds.length) || 0;
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  /** Atomically claim a task PENDING→RUNNING; 0 rows → a concurrent cancel already took it, so skip. */
  private async claim(taskId: string): Promise<boolean> {
    const claimed = await this.prisma.bulkTask.updateMany({ where: { id: taskId, status: "PENDING" }, data: { status: "RUNNING", startedAt: new Date() } });
    return claimed.count > 0;
  }

  private async runAdopt(taskId: string, serverId: string, userId: string, seed: TaskSeed): Promise<void> {
    if (!(await this.claim(taskId))) return;
    try {
      const app = await this.migrator.adopt(userId, serverId, { container: seed.adopt!.container, name: seed.name });
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: { status: "DONE", resourceType: "application", resourceId: app.id, result: { name: app.name, appId: app.id }, finishedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  private async runCopyApp(taskId: string, source: ImportSource, app: ForeignApp, userId: string, targetServerId: string, environmentId?: string): Promise<void> {
    if (!(await this.claim(taskId))) return;
    try {
      const { values, unresolved } = await source.fetchSecrets(app.sourceRef); // real env values (server-side only)
      const createInput = foreignAppToCreateInput(app, values, { serverId: targetServerId, environmentId, sourceTag: "coolify" });
      const created = await this.apps.create(userId, createInput); // re-checks apps:config on the TARGET team; deploy:false
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: {
          status: "DONE",
          resourceType: "application",
          resourceId: created.id,
          result: { name: created.name, appId: created.id, unresolvedEnv: unresolved.length }, // count only — never the values
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  /** Provision an empty Tugra database for a discovered source DB (deploy:false — the record is created,
   *  the container + DATA come later). Records the sourceRef→destResourceId mapping so the migrator can
   *  restore into it. Fresh credentials are minted (the app's DATABASE_URL is rewired at cutover). */
  private async runCreateDb(taskId: string, db: ForeignDb, userId: string, targetServerId: string, environmentId?: string): Promise<void> {
    if (!(await this.claim(taskId))) return;
    try {
      const input: CreateDatabaseInput = {
        name: db.name,
        serverId: targetServerId,
        engine: db.engine as CreateDatabaseInput["engine"], // PROVISIONABLE_ENGINES-gated before enqueue
        version: db.version,
        environmentId,
      };
      const created = await this.dbs.create(userId, input); // re-checks `databases` on the TARGET team; no deploy
      await this.prisma.bulkTask.update({
        where: { id: taskId },
        data: { status: "DONE", resourceType: "database", resourceId: created.id, result: { name: created.name, databaseId: created.id }, finishedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "FAILED", output: msg(e), finishedAt: new Date() } });
    }
  }

  /** Poll an operation's progress. Scoped to its creator. Returns a redacted view (no compensation blobs). */
  async status(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId);
    return toStatusView(op);
  }

  /** Request cancellation: flip the cooperative flag and mark any not-yet-started tasks CANCELLED. */
  async cancel(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId);
    if (!op.cancelRequestedAt) {
      await this.prisma.bulkOperation.update({ where: { id: opId }, data: { cancelRequestedAt: new Date() } });
    }
    await this.prisma.bulkTask.updateMany({
      where: { opId, status: "PENDING" },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    await this.audit.log({ actor: userId, action: "import.cancel", target: opId });
    return this.status(userId, opId);
  }

  /**
   * Undo an operation's completed work: local-docker un-adopts (rename the container back + drop the record);
   * coolify copy-mode removes each created app. Never while the fan-out is still running, and never an app the
   * user has (re)deployed since import — that is no longer in its as-imported state, so we leave it.
   */
  async rollback(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId);
    if (deriveOpStatus(op.tasks.map((t) => t.status as TaskStatus)) === "RUNNING") {
      throw new ConflictException("the import is still running — cancel it and wait for it to stop before rolling back");
    }
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string }) : {};
    const serverId = meta.serverId;
    const sourceKind = meta.sourceKind;
    if (!serverId) throw new ConflictException("operation has no target server to roll back");
    // Primary authz gate (destructive): the per-app unadopt/remove re-checks too (defence in depth).
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");

    const done = op.tasks.filter((t) => t.status === "DONE" && t.resourceType === "application" && t.resourceId);
    for (const t of done) {
      const appId = t.resourceId!;
      const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { id: true } });
      if (!app) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", output: "app already removed", finishedAt: new Date() } });
        continue;
      }
      if ((await this.prisma.deployment.count({ where: { appId } })) > 0) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: app has been (re)deployed since import — remove it manually if intended" } });
        continue;
      }
      try {
        if (sourceKind === "coolify") {
          await this.apps.remove(userId, appId); // the imported app is a fresh Tugra app → full teardown
        } else {
          const originalName = typeof t.compensation === "object" && t.compensation ? (t.compensation as { originalName?: string }).originalName : undefined;
          if (!originalName) {
            await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: original container name not recorded" } });
            continue;
          }
          await this.migrator.unadopt(userId, serverId, appId, originalName);
        }
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", finishedAt: new Date() } });
      } catch (e) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: `rollback failed: ${msg(e)}` } });
      }
    }
    // Databases provisioned by this import (coolify copy-mode) are freshly created empty records → tear
    // them down too, so a rollback leaves nothing behind. (local-docker never creates database tasks.)
    const doneDbs = op.tasks.filter((t) => t.status === "DONE" && t.resourceType === "database" && t.resourceId);
    for (const t of doneDbs) {
      const dbId = t.resourceId!;
      const existing = await this.prisma.database.findUnique({ where: { id: dbId }, select: { id: true, status: true } });
      if (!existing) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", output: "database already removed", finishedAt: new Date() } });
        continue;
      }
      // NEVER destroy a DB that has left its as-provisioned EMPTY state: dbs.remove does `docker rm -f`
      // + `docker volume rm`, so once the DB has been started (status != NEW) or had data restored/backed
      // up into it (the whole point — the migrator restores INTO it), teardown would be irreversible data
      // loss. Mirror the app guard: skip and leave it for explicit manual removal (keep status DONE).
      const used =
        existing.status !== "NEW" ||
        (await this.prisma.restore.count({ where: { databaseId: dbId } })) > 0 ||
        (await this.prisma.backup.count({ where: { databaseId: dbId } })) > 0;
      if (used) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: database has been provisioned/restored since import — remove it manually if intended" } });
        continue;
      }
      try {
        await this.dbs.remove(userId, dbId);
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", finishedAt: new Date() } });
      } catch (e) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: `rollback failed: ${msg(e)}` } });
      }
    }
    await this.audit.log({ actor: userId, action: "import.rollback", target: opId, meta: { serverId, count: done.length + doneDbs.length } });
    return this.status(userId, opId);
  }

  private async loadOwnedOp(userId: string, opId: string) {
    // Lazily settle tasks stuck RUNNING past the stale threshold — a worker that died or a hub restart mid-
    // adopt would otherwise leave the operation reading RUNNING forever and block rollback. Bounded: only
    // touches genuinely-stale rows (the adopt path's own timeouts are well under a minute).
    await this.prisma.bulkTask.updateMany({
      where: { opId, status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      data: { status: "FAILED", output: "stale: no completion signal (the worker stopped before finishing)", finishedAt: new Date() },
    });
    const op = await this.prisma.bulkOperation.findUnique({
      where: { id: opId },
      include: { tasks: { orderBy: { itemRef: "asc" } } },
    });
    if (!op || op.kind !== "import") throw new NotFoundException("import operation not found");
    if (op.actorId !== userId) throw new ForbiddenException("not your operation");
    return op;
  }
}

/** Shape the owned operation into a secret-free status view (internal compensation is not exposed). Includes
 *  the persisted plan snapshot so a failed/partial import's full picture survives for a post-mortem. */
export function toStatusView(op: {
  id: string;
  planId: string | null;
  meta: unknown;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  tasks: Array<{
    itemRef: string | null;
    kind: string;
    status: string;
    resourceType: string | null;
    resourceId: string | null;
    result: unknown;
    output: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  }>;
}) {
  const statuses = op.tasks.map((t) => t.status as TaskStatus);
  const count = (s: TaskStatus) => statuses.filter((x) => x === s).length;
  const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string; plan?: unknown }) : {};
  return {
    id: op.id,
    sourceKind: meta.sourceKind ?? null,
    serverId: meta.serverId ?? null,
    planHash: op.planId,
    // The secret-free plan captured at apply time — the durable record of what the import discovered +
    // intended, independent of any later re-discovery. Null for legacy ops that predate this.
    plan: meta.plan ?? null,
    status: deriveOpStatus(statuses),
    cancelRequested: !!op.cancelRequestedAt,
    createdAt: op.createdAt,
    totals: {
      total: op.tasks.length,
      done: count("DONE"),
      failed: count("FAILED") + count("FAILED_VERIFY"),
      skipped: count("SKIPPED"),
      running: count("RUNNING"),
      pending: count("PENDING"),
      cancelled: count("CANCELLED"),
      rolledBack: count("ROLLED_BACK"),
    },
    tasks: op.tasks.map((t) => {
      const res = typeof t.result === "object" && t.result ? (t.result as { name?: string; unresolvedEnv?: number }) : null;
      return {
        itemRef: t.itemRef,
        kind: t.kind,
        name: res?.name ?? null,
        status: t.status,
        resourceType: t.resourceType,
        resourceId: t.resourceId,
        message: t.output,
        // Count only (never values): >0 means the app was created with some env vars unresolved — fix before deploy.
        unresolvedEnv: typeof res?.unresolvedEnv === "number" ? res.unresolvedEnv : undefined,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
      };
    }),
  };
}
