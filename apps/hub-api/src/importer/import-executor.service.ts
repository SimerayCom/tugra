import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MigratorService } from "../migrator/migrator.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { planImport } from "./import-planner";
import { seedTasks, deriveOpStatus, type TaskSeed, type TaskStatus } from "./import-executor.logic";
import type { ImportApplyInput } from "./dto";

const CONCURRENCY = 5;
const STALE_RUNNING_MS = 10 * 60_000; // a RUNNING task older than this is treated as a dead worker's leftover
const msg = (e: unknown): string => (e instanceof Error ? e.message : "failed");

/**
 * Applies a local-docker import plan: for each adoptable container it reuses {@link MigratorService.adopt}
 * (which re-checks apps:config, re-inspects the container fresh, and renames it under Tugra). The operation
 * is persisted as a BulkOperation(kind="import") with one typed task per plan item, so progress survives the
 * request and can be polled, cancelled, or rolled back. No secret VALUES are ever stored or returned.
 *
 * Scope note: the only runnable source is local-docker (in-place adoption). Database/volume items are
 * recorded SKIPPED — they are not moved in place. Retry, verify and cutover arrive with the copy-mode
 * (remote PaaS) adapters that need them.
 */
@Injectable()
export class ImportExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly migrator: MigratorService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Re-discover + re-plan, enforce the reviewed plan via planHash, then persist + fan out the adoptions. */
  async apply(userId: string, input: ImportApplyInput): Promise<{ opId: string }> {
    const source = new LocalDockerSource(this.migrator, userId, input.serverId);
    const fleet = await source.discover(); // enforces apps:config + blanks env values
    const plan = planImport(fleet, { sourceKind: "local-docker", targetServerId: input.serverId });
    if (plan.planHash !== input.planHash) {
      throw new ConflictException("the plan changed since it was previewed — re-run the plan and review again");
    }
    // One import per server at a time: refuse if an import for this server still has unsettled tasks.
    // (A tiny check-then-create window remains; adopt's own isTugra/TOCTOU guard backstops a true race.)
    const inflight = await this.prisma.bulkOperation.findFirst({
      where: {
        kind: "import",
        meta: { path: ["serverId"], equals: input.serverId },
        tasks: { some: { status: { in: ["PENDING", "RUNNING"] } } },
      },
      select: { id: true },
    });
    if (inflight) throw new ConflictException("an import for this server is already in progress");
    const seeds = seedTasks(plan, fleet);

    const op = await this.prisma.bulkOperation.create({
      data: {
        actorId: userId,
        command: "",
        kind: "import",
        planId: plan.planHash,
        meta: { sourceKind: "local-docker", serverId: input.serverId },
      },
    });
    const runnable: Array<{ taskId: string; seed: TaskSeed }> = [];
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
      if (s.run && s.adopt) runnable.push({ taskId: task.id, seed: s });
    }
    await this.audit.log({
      actor: userId,
      action: "import.apply",
      target: op.id,
      meta: { sourceKind: "local-docker", serverId: input.serverId, run: runnable.length, total: seeds.length },
    });
    // Fire-and-forget, but never let a worker-level error become an unhandled rejection (would crash the
    // process on modern Node). Per-task DB errors are already contained inside the worker loop.
    void this.fanout(op.id, input.serverId, userId, runnable).catch(() => undefined);
    return { opId: op.id };
  }

  private async fanout(
    opId: string,
    serverId: string,
    userId: string,
    runnable: Array<{ taskId: string; seed: TaskSeed }>,
  ): Promise<void> {
    let i = 0;
    const worker = async () => {
      while (i < runnable.length) {
        const { taskId, seed } = runnable[i++]; // no await between read+increment → safe on the event loop
        try {
          const op = await this.prisma.bulkOperation.findUnique({
            where: { id: opId },
            select: { cancelRequestedAt: true },
          });
          if (op?.cancelRequestedAt) {
            await this.prisma.bulkTask.update({ where: { id: taskId }, data: { status: "CANCELLED", finishedAt: new Date() } });
            continue;
          }
          await this.runAdopt(taskId, serverId, userId, seed);
        } catch {
          // A DB/transport error on one task must not kill the worker or the sibling tasks. Leave the task
          // as-is; the stale-RUNNING reaper in loadOwnedOp settles anything stuck, and the op can be retried.
        }
      }
    };
    const n = Math.min(CONCURRENCY, runnable.length) || 0;
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  private async runAdopt(taskId: string, serverId: string, userId: string, seed: TaskSeed): Promise<void> {
    // Atomically claim the task: only a still-PENDING task transitions to RUNNING. If a concurrent cancel
    // already moved it to CANCELLED, the claim affects 0 rows and we skip — closing the cancel/run race.
    const claimed = await this.prisma.bulkTask.updateMany({
      where: { id: taskId, status: "PENDING" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    if (claimed.count === 0) return;
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

  /** Undo the completed adoptions of an operation (rename each container back + drop its app record). */
  async rollback(userId: string, opId: string) {
    const op = await this.loadOwnedOp(userId, opId);
    // Only roll back a settled operation — never while the fan-out is still adopting (it would race the
    // un-adopt). The caller cancels first, then rolls back once it has stopped.
    if (deriveOpStatus(op.tasks.map((t) => t.status as TaskStatus)) === "RUNNING") {
      throw new ConflictException("the import is still running — cancel it and wait for it to stop before rolling back");
    }
    const serverId = typeof op.meta === "object" && op.meta ? (op.meta as { serverId?: string }).serverId : undefined;
    if (!serverId) throw new ConflictException("operation has no target server to roll back");
    // Primary authz gate (destructive): the per-container unadopt re-checks too (defence in depth).
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");

    const done = op.tasks.filter(
      (t) => t.status === "DONE" && t.resourceType === "application" && t.resourceId,
    );
    for (const t of done) {
      const appId = t.resourceId!;
      const originalName = typeof t.compensation === "object" && t.compensation ? (t.compensation as { originalName?: string }).originalName : undefined;
      if (!originalName) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: original container name not recorded" } });
        continue;
      }
      // Never destroy work the user did AFTER the import. If the adopted app is gone, there is nothing to
      // undo; if it has been (re)deployed since adoption, it is no longer in its as-imported state, so we
      // refuse to delete it and leave it to the user.
      const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { id: true } });
      if (!app) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", output: "app already removed", finishedAt: new Date() } });
        continue;
      }
      const deployments = await this.prisma.deployment.count({ where: { appId } });
      if (deployments > 0) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: "rollback skipped: app has been (re)deployed since import — remove it manually if intended" } });
        continue;
      }
      try {
        await this.migrator.unadopt(userId, serverId, appId, originalName);
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { status: "ROLLED_BACK", finishedAt: new Date() } });
      } catch (e) {
        await this.prisma.bulkTask.update({ where: { id: t.id }, data: { output: `rollback failed: ${msg(e)}` } });
      }
    }
    await this.audit.log({ actor: userId, action: "import.rollback", target: opId, meta: { serverId, count: done.length } });
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

/** Shape the owned operation into a secret-free status view (internal compensation/meta are not exposed). */
function toStatusView(op: {
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
  return {
    id: op.id,
    sourceKind: typeof op.meta === "object" && op.meta ? (op.meta as { sourceKind?: string }).sourceKind ?? null : null,
    serverId: typeof op.meta === "object" && op.meta ? (op.meta as { serverId?: string }).serverId ?? null : null,
    planHash: op.planId,
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
    tasks: op.tasks.map((t) => ({
      itemRef: t.itemRef,
      kind: t.kind,
      name: typeof t.result === "object" && t.result ? (t.result as { name?: string }).name ?? null : null,
      status: t.status,
      resourceType: t.resourceType,
      resourceId: t.resourceId,
      message: t.output,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    })),
  };
}
