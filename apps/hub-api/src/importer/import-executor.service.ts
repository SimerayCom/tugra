import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MigratorService } from "../migrator/migrator.service";
import { ApplicationsService } from "../applications/applications.service";
import { DatabasesService } from "../databases/databases.service";
import { CryptoService } from "../crypto/crypto.service";
import type { CreateDatabaseInput } from "../databases/dto";
import { ImporterService } from "./importer.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { planImport } from "./import-planner";
import { foreignAppToCreateInput } from "./apply-map";
import { seedTasks, deriveOpStatus, type TaskSeed, type TaskStatus } from "./import-executor.logic";
import { MigrationTokenService } from "./migration-token.service";
import { assertSafeBase, buildMigrationCommand, buildMigrationCommandTemplate } from "./migration-command";
import { cleanupOpStaging } from "./migration-staging";
import type { ForeignApp, ForeignDb } from "./foreign-fleet";
import { createHash } from "node:crypto";
import { remapEnv, credsFromUrlForHost, type DbRemapTarget, type AppRemapTarget } from "./env-rewrite";
import { tokenizeDockerOptions } from "../deploy/deploy-script";
import type { DatabaseView } from "../databases/databases.service";

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
  private readonly logger = new Logger(ImportExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly migrator: MigratorService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly importer: ImporterService,
    private readonly apps: ApplicationsService,
    private readonly dbs: DatabasesService,
    private readonly migrationTokens: MigrationTokenService,
    private readonly crypto: CryptoService,
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
    // A cancelled import is abandoned → kill any live migration token so a copied command stops working.
    await this.migrationTokens.revoke(opId, userId).catch((e) => this.logger.warn(`migration-token revoke failed for ${opId}: ${msg(e)}`));
    await cleanupOpStaging(opId).catch(() => undefined); // reclaim any staged migration artifacts
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

    // Mark the op rolled-back BEFORE teardown so minting/validation is blocked for the whole window (a
    // best-effort revoke alone is not enough — this persistent marker is what assertCanMigrate + the token
    // guard's validate() honour, so even a missed revoke cannot resurrect a usable token).
    await this.prisma.bulkOperation.update({ where: { id: opId }, data: { meta: { ...meta, rolledBackAt: new Date().toISOString() } } });
    await this.migrationTokens.revoke(opId, userId).catch((e) => this.logger.warn(`migration-token revoke failed for ${opId}: ${msg(e)}`));

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
    await cleanupOpStaging(opId).catch(() => undefined); // the imported resources are gone → drop any staged artifacts
    return this.status(userId, opId);
  }

  /**
   * Mint a one-time migration token for this op so the untrusted SOURCE host can stream its volume/DB data
   * to the hub. Refuses (409) if a token is already live — use {@link reissueMigrationToken} to rotate — so
   * an accidental double-click never invalidates a command the host may already hold. The returned command
   * is shown ONCE: the token is hashed at rest and unrecoverable afterwards.
   */
  async mintMigrationToken(userId: string, opId: string, base: string) {
    const op = await this.loadOwnedOp(userId, opId);
    await this.assertCanMigrate(userId, op);
    assertSafeBase(base); // fail fast on an unsafe hub URL BEFORE a token is minted (none left behind on 400)
    await this.captureHubBase(opId, op.meta, base); // trusted capture (actor's request) for the agent download later
    const { token, expiresAt } = await this.migrationTokens.issue(opId);
    await this.auditTokenOrElseRevoke(userId, opId, "import.migration_token.mint", expiresAt);
    return { opId, token, expiresAt, command: buildMigrationCommand(token, base) };
  }

  /** Rotate the migration token: revoke the old and mint a new one atomically (works with or without a prior token). */
  async reissueMigrationToken(userId: string, opId: string, base: string) {
    const op = await this.loadOwnedOp(userId, opId);
    await this.assertCanMigrate(userId, op);
    assertSafeBase(base);
    await this.captureHubBase(opId, op.meta, base);
    const { token, expiresAt } = await this.migrationTokens.reissue(opId);
    await this.auditTokenOrElseRevoke(userId, opId, "import.migration_token.reissue", expiresAt);
    return { opId, token, expiresAt, command: buildMigrationCommand(token, base) };
  }

  /** Persist the hub origin the AUTHENTICATED actor reached us on, so the (untrusted) ingest path can later
   *  hand the agent a download URL on a trusted host instead of trusting the ingest request's Host header. */
  private async captureHubBase(opId: string, meta: unknown, base: string): Promise<void> {
    const m = typeof meta === "object" && meta ? (meta as Record<string, unknown>) : {};
    await this.prisma.bulkOperation.update({ where: { id: opId }, data: { meta: { ...m, hubBase: base } } });
  }

  /** The hash is committed before this runs, so if the audit write fails we must not leave an orphan live
   *  credential the caller never received — best-effort revoke it and surface the error so a retry works. */
  private async auditTokenOrElseRevoke(userId: string, opId: string, action: string, expiresAt: Date): Promise<void> {
    try {
      await this.audit.log({ actor: userId, action, target: opId, meta: { expiresAt } });
    } catch (e) {
      await this.migrationTokens.revoke(opId, userId).catch(() => undefined);
      throw e;
    }
  }

  /** Read-only migration state + a command TEMPLATE. Never returns the live token (hashed at rest): the UI
   *  captures the real command from the mint/reissue response once, then shows active/expiresAt + Reissue. */
  async migrateCommand(userId: string, opId: string, base: string) {
    const op = await this.loadOwnedOp(userId, opId);
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { rolledBackAt?: string }) : {};
    const expiresAt = op.migrationTokenExpiresAt;
    const active = !!op.migrationTokenHash && !!expiresAt && expiresAt.getTime() > Date.now() && !op.cancelRequestedAt && !meta.rolledBackAt;
    return { opId, active, expiresAt: active ? expiresAt : null, commandTemplate: buildMigrationCommandTemplate(base) };
  }

  /**
   * READ-ONLY env-remap preview (S4d-2). For a settled Coolify copy-mode import, propose how each migrated
   * app's env should be rewritten so it points at its new Tugra database instead of the old Coolify host.
   * It writes NOTHING: it decrypts each app's env + each DB's connection facts server-side, runs the pure
   * {@link remapEnv} engine, and returns a SECRET-MASKED diff + a planHash the apply (a later slice) will
   * confirm against. The per-DB mode reflects REALITY: if the Tugra DB's current credentials already match
   * the ones the app's own URL carries (a createForImport provision), only the host is swapped (preserve);
   * otherwise the whole connection is rewritten to the fresh Tugra credentials (rotate) and a split
   * credential var it cannot confirm is reported for manual review — never a half-rewrite.
   */
  async remapEnvPlan(userId: string, opId: string) {
    const { pub } = await this.computeRemapPlan(userId, opId);
    return pub;
  }

  /**
   * The shared remap computation behind BOTH the preview and the apply. It returns the exact secret-free
   * public plan (incl. the planHash) the preview surfaces AND an internal `writes` list carrying the RAW new
   * values — which is NEVER returned to a client. Computing both from one pass guarantees the diff the
   * operator confirmed and the bytes the apply writes can never diverge, and that the planHash the apply
   * re-derives is identical to the one the preview showed.
   */
  private async computeRemapPlan(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId, { reapData: false }); // never kill an in-flight restore
    await this.assertCanMigrate(userId, op); // coolify copy-mode, settled, creator still holds apps:config
    const meta = op.meta as { serverId: string };
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "databases"); // reading DB credentials

    const skipped: Array<{ itemRef: string; kind: "database" | "application"; reason: string }> = [];
    const skippedDbHosts = new Set<string>(); // old hosts whose DB we could NOT load — surfaced per app, not silently clean

    // DONE app destinations → their decrypted env (writer-gated). Fetched first so a DB's mode can be
    // decided from the app URLs that reference it.
    const appEnvs: Array<{ itemRef: string; appId: string; name: string; env: Record<string, string> }> = [];
    for (const t of op.tasks) {
      if (t.status !== "DONE" || t.resourceType !== "application" || !t.resourceId || !t.itemRef) continue;
      let env: Record<string, string>;
      try {
        env = await this.apps.getEnv(userId, t.resourceId);
      } catch {
        skipped.push({ itemRef: t.itemRef, kind: "application", reason: "not-accessible" });
        continue;
      }
      const r = typeof t.result === "object" && t.result ? (t.result as { name?: string }) : {};
      appEnvs.push({ itemRef: t.itemRef, appId: t.resourceId, name: r.name ?? t.itemRef, env });
    }

    // DONE database destinations → their Tugra connection facts (writer view decrypts the creds). A DB we
    // cannot load (deleted / no creds visible) is SKIPPED but recorded, never aborts the whole preview.
    const dbInfos: Array<{ itemRef: string; oldHost: string; dv: DatabaseView }> = [];
    for (const t of op.tasks) {
      if (t.status !== "DONE" || t.resourceType !== "database" || !t.resourceId || !t.itemRef) continue;
      const oldHost = sourceRefOf(t.itemRef);
      if (!oldHost) {
        skipped.push({ itemRef: t.itemRef, kind: "database", reason: "bad-itemref" });
        continue;
      }
      let dv: DatabaseView;
      try {
        dv = await this.dbs.get(userId, t.resourceId);
      } catch {
        skipped.push({ itemRef: t.itemRef, kind: "database", reason: "not-accessible" });
        skippedDbHosts.add(oldHost);
        continue;
      }
      if (!dv.canWrite || !dv.internalHost) {
        skipped.push({ itemRef: t.itemRef, kind: "database", reason: "no-credentials" });
        skippedDbHosts.add(oldHost);
        continue;
      }
      dbInfos.push({ itemRef: t.itemRef, oldHost, dv });
    }

    // Decide each DB's mode from reality. Gather the old creds from EVERY app URL that points at it: preserve
    // only when there is exactly ONE distinct credential set across all apps AND it matches the Tugra DB's
    // current creds; a mismatch, or apps that disagree, falls to rotate (every URL rewritten to the one Tugra
    // credential) and leaves the old identity ambiguous so split vars are reported, never half-rewritten.
    const DB_NAME_ENGINES = new Set(["POSTGRES", "MYSQL", "MARIADB"]); // engines whose URL path is the db-name (not a redis index / mongo params)
    const targets: DbRemapTarget[] = dbInfos.map(({ itemRef, oldHost, dv }) => {
      const distinct = new Map<string, { user?: string; password?: string; database?: string }>();
      for (const a of appEnvs) {
        for (const v of Object.values(a.env)) {
          const c = credsFromUrlForHost(v, oldHost);
          if (c) distinct.set(`${c.user ?? ""}\u0000${c.password ?? ""}\u0000${c.database ?? ""}`, c);
        }
      }
      const rec = distinct.size === 1 ? [...distinct.values()][0] : undefined; // >1 distinct → ambiguous → undefined
      const preserve = !!rec && rec.user === dv.username && rec.password === dv.password && (rec.database === undefined || rec.database === dv.database);
      return {
        itemRef,
        name: dv.name,
        engine: dv.engine,
        mode: preserve ? "preserve" : "rotate",
        oldHost,
        newHost: dv.internalHost!,
        newPort: dv.port,
        newUser: dv.username ?? "",
        newPassword: dv.password ?? "",
        newDatabase: dv.database ?? "",
        oldUser: rec?.user,
        // only pg/mysql/mariadb carry a db-NAME in the URL path; a redis /index or mongo params must not be
        // treated as a db-name (else a REDIS_DB=0 split var would be rewritten to the Tugra slug).
        oldDatabase: DB_NAME_ENGINES.has(dv.engine) ? rec?.database : undefined,
        oldPassword: rec?.password,
      };
    });
    const appTargets: AppRemapTarget[] = appEnvs.map((a) => ({ itemRef: a.itemRef, name: a.name, oldHost: sourceRefOf(a.itemRef) ?? "\u0000none", newHost: `tugra_${a.appId}` }));

    // Raw per-app rewrites ({key,newValue}) the apply writer sets — NEVER returned to a client (secret values).
    const writes: Array<{ appId: string; name: string; itemRef: string; entries: Array<{ key: string; newValue: string }> }> = [];
    // Pass 1 (sync): run the pure engine per app; collect the public diff + the DBs each app references.
    const prepped = appEnvs.map((a) => {
      const res = remapEnv(a.env, { dbs: targets, apps: appTargets.filter((at) => at.itemRef !== a.itemRef) });
      writes.push({ appId: a.appId, name: a.name, itemRef: a.itemRef, entries: res.changes.map((c) => ({ key: c.key, newValue: c.newValue })) });
      const needsManual = res.needsManual.map((n) => ({ key: n.key, reason: n.reason, targetItemRef: n.target }));
      // A value that references a DB we could NOT load looks "unchanged" but actually needs this DB — surface
      // it so an app is never shown as cleanly remapped while a referenced destination was skipped.
      let unchangedCount = res.unchanged.length;
      if (skippedDbHosts.size) {
        for (const key of res.unchanged) {
          const v = a.env[key];
          if ([...skippedDbHosts].some((h) => v.includes(h))) {
            needsManual.push({ key, reason: "target-unavailable", targetItemRef: undefined });
            unchangedCount--;
          }
        }
      }
      // The migrated DBs this app's automatic rewrites point at — the apps that may need the DB network.
      const refDbs = [...new Set(res.changes.filter((c) => c.target.kind === "database").map((c) => c.target.itemRef))].sort();
      return {
        itemRef: a.itemRef,
        appId: a.appId,
        name: a.name,
        changes: res.changes.map((c) => ({
          key: c.key,
          rule: c.rule,
          targetItemRef: c.target.itemRef,
          targetName: c.target.name,
          targetKind: c.target.kind,
          oldMasked: c.oldMasked,
          newMasked: c.newMasked,
          confidence: c.confidence,
        })),
        unchangedCount,
        needsManual,
        refDbs,
      };
    });

    // S4d-4 link eligibility (best-effort preview; setDbNetwork re-validates authoritatively at apply). An app
    // whose rewrites point at a migrated DB may also need to join the node-local DB network (tugra-net) so it
    // resolves tugra_db_<id>. Eligible only for a co-located classic topology; an ineligible app still gets its
    // env rewritten but is flagged needs-manual (it won't connect until networking is wired by hand).
    const candidateIds = prepped.filter((p) => p.refDbs.length > 0).map((p) => p.appId);
    const rows = candidateIds.length
      ? await this.prisma.application.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true, serverId: true, clusterId: true, source: true, dockerOptions: true, dbNetwork: true },
        })
      : [];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    // Exposure disclosure: a linked app can reach EVERY managed DB on the server (tugra-net is shared), and
    // libSQL has no auth — count/flag them so the operator confirms an informed blast radius. Only queried
    // when there IS a candidate app (nothing references a DB otherwise).
    const serverDbs = candidateIds.length
      ? await this.prisma.database.findMany({ where: { serverId: server.id, teamId: server.teamId }, select: { engine: true } })
      : [];
    const serverDbCount = serverDbs.length;
    const hasUnauthEngine = serverDbs.some((d) => d.engine === "LIBSQL");

    const links: Array<{ appId: string; eligible: boolean; dbNetworkPrior: boolean }> = [];
    const apps = prepped.map((p) => {
      const { refDbs, ...pubApp } = p;
      let dbNetwork: { willLink: boolean; reason?: string; databases: string[]; serverDbCount: number; hasUnauthEngine: boolean } | null = null;
      if (refDbs.length > 0) {
        const row = rowById.get(p.appId);
        let reason: string | undefined;
        if (!row) reason = "app-unavailable";
        else if (row.clusterId) reason = "swarm";
        else if (row.source === "COMPOSE") reason = "compose";
        else if (row.serverId !== server.id) reason = "cross-host";
        else if (tokenizeDockerOptions(row.dockerOptions).some((t) => /^(--network|--net)(=|$)/.test(t))) reason = "dockerOptions-network";
        else if (serverDbCount === 0) reason = "no-database"; // mirror setDbNetwork's guard so preview + gate agree
        const eligible = reason === undefined;
        links.push({ appId: p.appId, eligible, dbNetworkPrior: !!row?.dbNetwork });
        dbNetwork = { willLink: eligible, reason, databases: refDbs, serverDbCount, hasUnauthEngine };
        if (!eligible) pubApp.needsManual.push({ key: "(db-network)", reason: "dbnet-unsupported-topology", targetItemRef: undefined });
      }
      return { ...pubApp, dbNetwork };
    });

    // A canonical, SECRET-FREE planHash — the confirmToken the apply step re-computes + requires. It covers the
    // diff AND the link decision (willLink + referenced DBs + the server's DB count), so a drift in the network
    // link set — not just the env diff — forces the operator to re-review (apply returns 409).
    const canonical = JSON.stringify({
      opId,
      apps: apps
        .map((a) => ({
          id: a.appId,
          c: a.changes.map((c) => [c.key, c.rule, c.targetItemRef, c.newMasked]).sort(),
          l: a.dbNetwork ? [a.dbNetwork.willLink, a.dbNetwork.databases, a.dbNetwork.serverDbCount, a.dbNetwork.hasUnauthEngine] : null,
        }))
        .sort((x, y) => x.id.localeCompare(y.id)),
    });
    const planHash = createHash("sha256").update(canonical).digest("hex");

    const pub = {
      opId,
      planHash,
      databases: targets.map((t) => ({ itemRef: t.itemRef, name: t.name, engine: t.engine, mode: t.mode })),
      skipped,
      apps,
      note: "read-only preview — nothing has been changed; review the diff, then apply (a confirm-gated step) to write it",
    };
    return { op, pub, writes, links };
  }

  /**
   * Apply the previewed env-remap (S4d-3) — the FIRST write of the remap flow, fully confirm-gated. It
   * re-computes the SAME plan the preview showed and REFUSES (409) unless `confirmToken` equals that fresh
   * planHash, so any change to the source or the apps' env since the operator reviewed it aborts the write
   * rather than applying a stale diff. For a RELIABLE one-call undo it snapshots every app's prior env
   * (encrypted at rest, same key as everything else — no new exposure) and PERSISTS that undo record BEFORE
   * the first write, as an atomic compare-and-set on op.meta (so two overlapping applies can never both
   * commit and clobber the baseline, and sibling meta keys are never lost to a stale overwrite). Each app's
   * rewrites are then MERGED into a FRESH read of its env (unrelated keys preserved) via the writer-gated
   * {@link ApplicationsService.setEnv}; because the undo record is already committed, even a mid-loop write
   * failure stays fully reversible. Guards: a prior un-undone apply, and a plan with no automatic rewrites,
   * are both refused. Env changes take effect on an app's NEXT deploy — the response says so per app.
   */
  async remapEnvApply(userId: string, opId: string, confirmToken: string) {
    const { op, pub, writes, links } = await this.computeRemapPlan(userId, opId);
    if (pub.planHash !== confirmToken) {
      throw new ConflictException("the plan has changed since you reviewed it — re-open the preview and confirm the new plan");
    }
    if (hasPendingRemap(op.meta)) {
      throw new ConflictException("an env-remap has already been applied for this import — undo it first to re-apply");
    }
    const toWrite = writes.filter((w) => w.entries.length > 0);
    if (toWrite.length === 0) {
      throw new ConflictException("nothing to apply — the preview proposed no automatic rewrites");
    }
    // Apps the preview judged eligible to ALSO join the DB network → appId -> its prior dbNetwork flag (for undo).
    const linkPrior = new Map(links.filter((l) => l.eligible).map((l) => [l.appId, l.dbNetworkPrior]));

    // 1) Snapshot each target's CURRENT env first (fresh, writer-gated). An app we cannot read now (deleted or
    //    no longer writable since the plan) is skipped+reported — never written, never half-snapshotted.
    const undoApps: Array<{ appId: string; name: string; priorEnc: string; keys: string[]; dbNetworkPrior?: boolean }> = [];
    const targets: Array<{ appId: string; name: string; prior: Record<string, string>; entries: Array<{ key: string; newValue: string }> }> = [];
    const unprepared: Array<{ appId: string; name: string }> = [];
    for (const w of toWrite) {
      let prior: Record<string, string>;
      try {
        prior = await this.apps.getEnv(userId, w.appId);
      } catch {
        unprepared.push({ appId: w.appId, name: w.name });
        continue;
      }
      // Record a link-reversal in the undo snapshot ONLY when the apply actually flips the flag (prior false →
      // true). If the app was ALREADY linked (prior true), the apply is a no-op on the flag, so undo must not
      // touch it — and recording only the false case means undo only ever calls setDbNetwork(false), the
      // guard-free direction that cannot throw a topology error and strand the record. Committed before any write.
      const linkEntry = linkPrior.get(w.appId) === false ? { dbNetworkPrior: false } : {};
      undoApps.push({ appId: w.appId, name: w.name, priorEnc: this.crypto.encrypt(JSON.stringify(prior)), keys: w.entries.map((e) => e.key), ...linkEntry });
      targets.push({ appId: w.appId, name: w.name, prior, entries: w.entries });
    }
    if (targets.length === 0) {
      throw new ConflictException("no apps could be prepared for the remap (deleted or no longer writable)");
    }

    // 2) COMMIT the undo record BEFORE any write, as an atomic compare-and-set on op.meta (see casMeta): it
    //    applies only if meta is still what the guard just saw, so two overlapping applies can never both
    //    commit an undo record, and sibling meta keys (hubBase/rolledBackAt) are never lost to a stale write.
    const before = await this.freshMeta(opId);
    if (hasPendingRemap(before)) {
      throw new ConflictException("another env-remap apply is in progress or already applied — re-open the preview");
    }
    await this.casMeta(opId, before, { ...before, remapUndo: { appliedAt: new Date().toISOString(), planHash: pub.planHash, apps: undoApps } });

    // 3) Write. The undo record already covers every target, so a per-app failure here stays reversible. Each
    //    write MERGES onto a FRESH read of the app's env, so an edit landing since the snapshot is preserved.
    //    For an eligible app we then ALSO link the DB network — setDbNetwork re-validates (the authoritative
    //    gate); a link failure is reported but never discards the successful env write.
    const appliedApps: Array<{ appId: string; name: string; written: number; keys: string[]; needsRedeploy: boolean; linked: boolean }> = [];
    const failed: Array<{ appId: string; name: string }> = [...unprepared];
    const linkFailed: Array<{ appId: string; name: string }> = [];
    for (const t of targets) {
      try {
        const current = await this.apps.getEnv(userId, t.appId); // fresh — unrelated edits since the snapshot kept
        const next = { ...current };
        for (const e of t.entries) next[e.key] = e.newValue;
        await this.apps.setEnv(userId, t.appId, next); // writer-gated + audited + encrypted at rest
        let linked = false;
        if (linkPrior.has(t.appId)) {
          try {
            await this.apps.setDbNetwork(userId, t.appId, true); // re-validates topology; takes effect next deploy
            linked = true;
          } catch {
            linkFailed.push({ appId: t.appId, name: t.name }); // env is written; only the network link failed
          }
        }
        appliedApps.push({ appId: t.appId, name: t.name, written: t.entries.length, keys: t.entries.map((e) => e.key), needsRedeploy: true, linked });
      } catch {
        failed.push({ appId: t.appId, name: t.name }); // reversible via undo — the snapshot was committed above
      }
    }
    await this.audit.log({ actor: userId, action: "import.remap_env.apply", target: opId, meta: { applied: appliedApps.map((a) => ({ appId: a.appId, keys: a.keys, linked: a.linked })), failed: failed.map((f) => f.appId), linkFailed: linkFailed.map((f) => f.appId) } });
    return {
      opId,
      applied: failed.length === 0 && linkFailed.length === 0,
      planHash: pub.planHash,
      apps: appliedApps,
      failed,
      linkFailed,
      note: "env rewritten to point at the new Tugra databases (eligible apps also joined the DB network) — redeploy each app for the changes to take effect; an undo is available",
    };
  }

  /**
   * Reverse a {@link remapEnvApply} (S4d-3): revert the keys the remap rewrote back to the snapshot taken
   * before it wrote them. For each app it fresh-reads the CURRENT env and reverts ONLY the remapped keys
   * (restoring a key's prior value, or deleting it if it was absent before), so env edits made after the
   * apply are kept — never a blind whole-env replace. The record is marked consumed ONLY when every app
   * restored: an app that no longer exists is dropped (nothing to restore), while a transient per-app
   * failure keeps that app in the record (un-undone) so undo can be retried and a re-apply stays blocked.
   * Reuses the preview/apply gate (assertCanMigrate → apps:config); refuses (409) when nothing is applied.
   */
  async remapEnvUndo(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId, { reapData: false });
    await this.assertCanMigrate(userId, op);
    const before = metaObj(op.meta); // the meta `undo` is read from — also the compare-and-set precondition below
    const undo = readRemapUndo(before);
    if (!undo || undo.undoneAt || !undo.apps?.length) {
      throw new ConflictException("nothing to undo — no env-remap has been applied for this import");
    }
    const restored: Array<{ appId: string; name: string }> = [];
    const terminal: Array<{ appId: string; name: string; reason: string }> = []; // can never be restored → dropped, not retried forever
    const stillFailed: typeof undo.apps = []; // a TRANSIENT failure — kept so undo can be retried
    for (const a of undo.apps) {
      let prior: Record<string, string>;
      try {
        prior = JSON.parse(this.crypto.decrypt(a.priorEnc)) as Record<string, string>;
      } catch {
        terminal.push({ appId: a.appId, name: a.name, reason: "snapshot-unreadable" }); // corrupt ciphertext — retrying can't help
        continue;
      }
      try {
        const current = await this.apps.getEnv(userId, a.appId);
        const next = { ...current };
        for (const k of a.keys ?? Object.keys(prior)) {
          if (Object.prototype.hasOwnProperty.call(prior, k)) next[k] = prior[k];
          else delete next[k]; // the remap had ADDED this key — reverting means removing it
        }
        await this.apps.setEnv(userId, a.appId, next); // key-scoped revert — post-apply edits to other keys kept
        // Reverse the DB-network link too (only for an app the apply linked) — restore its prior flag.
        if (a.dbNetworkPrior !== undefined) await this.apps.setDbNetwork(userId, a.appId, a.dbNetworkPrior);
        restored.push({ appId: a.appId, name: a.name });
      } catch (e) {
        if (e instanceof NotFoundException) terminal.push({ appId: a.appId, name: a.name, reason: "app-deleted" });
        else if (e instanceof ForbiddenException) terminal.push({ appId: a.appId, name: a.name, reason: "not-writable" });
        else stillFailed.push(a); // transient (e.g. a DB blip) — keep for a retry
      }
    }
    // Consume the record ONLY when nothing transient remains: a terminal app (deleted/unwritable/corrupt) is
    // dropped so a re-apply is never blocked forever; a transient app is kept (un-undone) so undo can retry.
    // On full consumption the encrypted priorEnc snapshots are dropped from meta (hygiene — no secret lingers).
    const after = {
      ...before,
      remapUndo: stillFailed.length
        ? { ...undo, apps: stillFailed, partialUndoAt: new Date().toISOString() }
        : { appliedAt: undo.appliedAt, planHash: undo.planHash, undoneAt: new Date().toISOString(), apps: [] },
    };
    await this.casMeta(opId, before, after);
    await this.audit.log({ actor: userId, action: "import.remap_env.undo", target: opId, meta: { restored: restored.map((r) => r.appId), terminal: terminal.map((t) => ({ appId: t.appId, reason: t.reason })), failed: stillFailed.map((f) => f.appId) } });
    return {
      opId,
      undone: stillFailed.length === 0,
      apps: restored,
      failed: [...terminal.map((t) => ({ appId: t.appId, name: t.name })), ...stillFailed.map((f) => ({ appId: f.appId, name: f.name }))],
      note: stillFailed.length
        ? "reverted the remapped keys for the apps that could be written; some remain pending (a transient failure) — retry undo"
        : "reverted the remapped keys to the pre-remap snapshot (other env edits kept); redeploy to apply the reverted env",
    };
  }

  /** Re-read op.meta from the DB as a fresh mutable object, so a remap commit merges onto the CURRENT meta
   *  (never a stale copy that would lose a sibling key like hubBase/rolledBackAt). */
  private async freshMeta(opId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { meta: true } });
    return metaObj(row?.meta);
  }

  /** Compare-and-set op.meta: write `after` ONLY while the row's meta still equals `before` (Postgres jsonb
   *  value equality — order-independent). A concurrent writer that changed meta first makes this match no row
   *  (count 0) → 409, so two overlapping remap applies/undos can never both commit and clobber the baseline. */
  private async casMeta(opId: string, before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
    const claim = await this.prisma.bulkOperation.updateMany({
      where: { id: opId, meta: { equals: before as Prisma.InputJsonValue } },
      data: { meta: after as Prisma.InputJsonValue },
    });
    if (claim.count !== 1) {
      throw new ConflictException("the operation was modified concurrently — re-open the preview and confirm again");
    }
  }

  /**
   * A migration token authorizes an untrusted host to stream DATA into the op's provisioned resources, so
   * minting is gated to the one state where that is meaningful AND safe: a COPY-mode (coolify) import whose
   * apply has settled with at least one real destination (a DONE app/db resource), that has not been
   * cancelled or rolled back, and whose creator still holds apps:config on the target team. local-docker
   * adopts live containers in place (no empty dest to restore into), a still-running apply has no dest yet,
   * and a rolled-back op's resources are gone — none may mint. (Removing the spec's backwards "finished →
   * 409" gate was right; this replaces it with the correct positive condition.)
   */
  private async assertCanMigrate(
    userId: string,
    op: { meta: unknown; cancelRequestedAt: Date | null; tasks: Array<{ status: string; resourceType: string | null; resourceId: string | null }> },
  ): Promise<void> {
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string; rolledBackAt?: string }) : {};
    if (meta.sourceKind !== "coolify") throw new ConflictException("only a copy-mode (coolify) import can migrate data");
    if (op.cancelRequestedAt) throw new ConflictException("operation was cancelled");
    if (meta.rolledBackAt) throw new ConflictException("operation was rolled back");
    if (!meta.serverId) throw new ConflictException("operation has no target server");
    if (deriveOpStatus(op.tasks.map((t) => t.status as TaskStatus)) === "RUNNING") {
      throw new ConflictException("the import is still running — wait for it to finish before migrating data");
    }
    const hasDest = op.tasks.some((t) => t.status === "DONE" && (t.resourceType === "application" || t.resourceType === "database") && !!t.resourceId);
    if (!hasDest) throw new ConflictException("the import provisioned no resources to migrate data into");
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
  }

  /**
   * Load an op for the migration INGEST path (authenticated by the migration token, not a user session, so it
   * takes actorId instead of userId and does NO permission call — the ingest service re-authorizes per item).
   * Same reaper + ownership + copy-mode eligibility as the mint gate, but tolerant of in-flight `data` tasks
   * (the restore we are driving): it blocks only while the APPLY provisioning (app/db tasks) is still running.
   */
  async loadIngestOp(opId: string, actorId: string) {
    // Reap stale APPLY tasks only — never a `data` task: this runs on every ingest request (incl. status
    // polls), and a legit long restore must not be killed mid-flight (the restore claim handles its own
    // stale-takeover, and S6 adds a heartbeat/longer threshold for data tasks).
    await this.prisma.bulkTask.updateMany({
      where: { opId, kind: { not: "data" }, status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      data: { status: "FAILED", output: "stale: no completion signal (the worker stopped before finishing)", finishedAt: new Date() },
    });
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, include: { tasks: { orderBy: { itemRef: "asc" } } } });
    if (!op || op.kind !== "import") throw new NotFoundException("import operation not found");
    if (op.actorId !== actorId) throw new ForbiddenException("not your operation");
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string; serverId?: string; rolledBackAt?: string }) : {};
    if (meta.sourceKind !== "coolify") throw new ConflictException("only a copy-mode (coolify) import can migrate data");
    if (op.cancelRequestedAt) throw new ConflictException("operation was cancelled");
    if (meta.rolledBackAt) throw new ConflictException("operation was rolled back");
    if (!meta.serverId) throw new ConflictException("operation has no target server");
    // Only the provisioning tasks gate readiness; a RUNNING `data` task is the ingest in progress, not the apply.
    const provisioning = op.tasks.filter((t) => t.kind !== "data").map((t) => t.status as TaskStatus);
    if (deriveOpStatus(provisioning) === "RUNNING") throw new ConflictException("the import is still running — wait for it to finish before migrating data");
    if (!op.tasks.some((t) => t.status === "DONE" && (t.resourceType === "application" || t.resourceType === "database") && !!t.resourceId)) {
      throw new ConflictException("the import provisioned no resources to migrate data into");
    }
    return op;
  }

  private async loadOwnedOp(userId: string, opId: string, opts: { reapData?: boolean } = {}) {
    // Lazily settle tasks stuck RUNNING past the stale threshold — a worker that died or a hub restart mid-
    // adopt would otherwise leave the operation reading RUNNING forever and block rollback. Bounded: only
    // touches genuinely-stale rows (the adopt path's own timeouts are well under a minute). `reapData:false`
    // (used by the read-only remap preview) leaves in-flight `data` restore tasks alone, so a preview can
    // never kill a long migration the way a mutating caller's reaper would.
    const reapData = opts.reapData !== false;
    await this.prisma.bulkTask.updateMany({
      where: { opId, ...(reapData ? {} : { kind: { not: "data" } }), status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
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

/** The encrypted env-remap undo record stashed on op.meta by {@link ImportExecutorService.remapEnvApply}. */
interface RemapUndoRecord {
  appliedAt?: string;
  undoneAt?: string;
  partialUndoAt?: string;
  planHash?: string;
  apps?: Array<{ appId: string; name: string; priorEnc: string; keys?: string[]; dbNetworkPrior?: boolean }>;
}

/** A Prisma Json value as a fresh mutable object ({} when null/absent), safe to merge onto. */
function metaObj(meta: unknown): Record<string, unknown> {
  return typeof meta === "object" && meta ? { ...(meta as Record<string, unknown>) } : {};
}

/** The op's remap undo record, or undefined. */
function readRemapUndo(meta: unknown): RemapUndoRecord | undefined {
  const m = typeof meta === "object" && meta ? (meta as { remapUndo?: RemapUndoRecord }) : {};
  return m.remapUndo;
}

/** True when a remap has been applied and not yet fully undone — the re-apply guard. */
function hasPendingRemap(meta: unknown): boolean {
  const undo = readRemapUndo(meta);
  return !!undo && !undo.undoneAt;
}

/** The source-side reference (a Coolify resource uuid) from an itemRef `<kind>:<serverRef|_>:<sourceRef>`
 *  (import-planner ns()). Everything after the 2nd ':' — kind-agnostic (database: / app:). */
function sourceRefOf(itemRef: string): string | undefined {
  const i1 = itemRef.indexOf(":");
  if (i1 < 0) return undefined;
  const i2 = itemRef.indexOf(":", i1 + 1);
  if (i2 < 0) return undefined;
  const ref = itemRef.slice(i2 + 1);
  return ref.length ? ref : undefined;
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
