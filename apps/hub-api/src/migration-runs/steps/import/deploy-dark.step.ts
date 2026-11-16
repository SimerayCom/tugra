/**
 * Step 8, DEPLOY_DARK (P7 lane A, rollback UNDOABLE): bring the migrated databases up and deploy the migrated apps on the
 * target, "dark" (no production traffic reaches them: DNS/proxy still point at the source).
 *
 * Databases first (each `provision`ed once), then the apps in small batches through `apps.deploy` under the idempotency
 * key `migrun:<runId>:<appId>` (a retry after a failed deploy takes a numbered suffix), so a crash and a re-drive never
 * deploy an app twice. Compensation ids are written before the first side effect; abort stops exactly those apps and
 * databases (never removes anything). Services (compose stacks) are not deployed: they stay stopped unless the operator
 * starts them.
 *
 * Grup-7 safety rules:
 *  - WORKERS (apps with no domain, or marked job runners) are not deployed here: they stay stopped until after the point of
 *    no return (R26/C13; see `baseline/post-ponr.ts`), and an abort never starts them;
 *  - an image app on a floating tag is pinned to the digest the source runs before it is deployed (R11);
 *  - builds run `deployConcurrency` per TARGET server (R25, default 1), and an app already built early (`deployWaves:
 *    earlyBuild`, R27) only costs its start.
 */
import { Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  deployConcurrencyOf,
  makeGate,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { IMPORT_STEPS_PORT, type DeploymentRef, type ImportStepsPort } from "./import-ports";
import { deployKeyBase, failureOf, includedItems, isActiveDeploy, stopRunApps } from "./step-utils";
import { pinFor, isFloatingImage, serverRefOfItem } from "./baseline/image-pins";
import { appTasksOf, workerSetsOfOp } from "./baseline/op-safety";
import { RUN_HINTS, type RunHint, type RunHintStore } from "./baseline/run-hints";
import { workerMarks, workerSets } from "./baseline/workers";
import { resolveOwnerInput } from "../../core/run-contract";

/**
 * A database row can be left PROVISIONING by a hub that died inside `provision` (nothing reaps it; a live provision ends
 * within the agent's 5 minute timeout). Past this patience the step stops polling it.
 */
const PROVISION_PATIENCE_MS = 10 * 60_000;

interface DbRow {
  id: string;
  name: string;
  status: string;
  exists: boolean;
}
interface AppRow {
  id: string;
  name: string;
  status: string;
  exists: boolean;
  deployments: DeploymentRef[];
  /** `held`: a worker kept stopped until after the cutover; `excluded`: a worker this run does not migrate; null: an ordinary app. */
  worker: "held" | "excluded" | null;
  /** The Tugra target server the app lives on (the run's `serverMap` for the item's source server). */
  server: string;
  /** The digest to pin a floating image app to before its deploy, when the operator/host recorded one. */
  pin: string | null;
}

export interface DeployDarkObs extends Observation {
  agentOnline: boolean;
  dbs: DbRow[];
  apps: AppRow[];
}

interface Comp {
  dbIds?: string[];
  appIds?: string[];
  /** dbId -> ISO instant this step first saw the database PROVISIONING (the stuck-provision clock). */
  provisioningSince?: Record<string, string>;
}
const compOf = (ctx: StepContext): Comp => (ctx.step.compensation ?? {}) as Comp;

const latest = (a: AppRow): DeploymentRef | undefined => a.deployments[a.deployments.length - 1];
const appOk = (a: AppRow): boolean => a.exists && latest(a)?.status === "SUCCESS" && a.status === "RUNNING";
/** Workers (held or excluded) are not required to run before the cutover. */
const required = (a: AppRow): boolean => a.worker === null;
const dbOk = (d: DbRow): boolean => d.exists && d.status === "RUNNING";

@Injectable()
export class DeployDarkStep implements StepHandler<DeployDarkObs>, OnModuleInit {
  readonly key = "DEPLOY_DARK" as const;
  readonly kind = "auto" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(IMPORT_STEPS_PORT) private readonly port: ImportStepsPort,
    @Optional() @Inject(RUN_HINTS) private readonly hintStore?: RunHintStore,
  ) {}

  private hints(run: { id: string; promotedFromId: string | null }): Promise<RunHint[]> {
    return this.hintStore ? this.hintStore.list(run.id, run.promotedFromId).catch(() => []) : Promise.resolve([]);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  applicable(): boolean {
    return true;
  }

  async observe(ctx: StepContext): Promise<DeployDarkObs> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    if (!run.opId) return { agentOnline: true, dbs: [], apps: [] };
    const op = await this.port.opSnapshot(userId, run.opId);
    // every target server of the run must have its agent online (a multi-host run deploys on all of them)
    const targets = await Promise.all(ctx.targetServerIds.map((serverId) => this.port.target(userId, { serverId, hosts: [] })));
    const agentOnline = targets.every((t) => t.agentOnline);
    const hints = await this.hints(run);
    const sets = workerSetsOfOp(run, op, hints);
    const imageOf = new Map(op.planItems.map((p) => [p.itemRef, p.image] as const));
    const dbTasks = op.tasks.filter((t) => t.kind === "database" && t.status === "DONE" && t.resourceType === "database" && !!t.resourceId);
    const appTasks = appTasksOf(op);
    const dbs: DbRow[] = [];
    for (const t of dbTasks) {
      const s = await this.port.dbState(userId, t.resourceId!);
      dbs.push({ id: t.resourceId!, name: s.name ?? t.name ?? "", status: s.status, exists: s.exists });
    }
    const apps: AppRow[] = [];
    for (const t of appTasks) {
      const id = t.resourceId!;
      const [s, deployments] = await Promise.all([this.port.appState(userId, id), this.port.deployments(id, deployKeyBase(run.id, id))]);
      const ref = t.itemRef ?? "";
      const image = imageOf.get(ref);
      const pin = image && isFloatingImage(image) ? pinFor(hints, image, serverRefOfItem(ref)) : null;
      apps.push({
        id,
        name: s.name ?? t.name ?? "",
        status: s.status,
        exists: s.exists,
        deployments,
        worker: sets.held.has(ref) ? "held" : sets.excluded.has(ref) ? "excluded" : null,
        server: ctx.targetFor(serverRefOfItem(ref) || null),
        pin,
      });
    }
    const need = apps.filter(required);
    const done = dbs.filter(dbOk).length + need.filter(appOk).length;
    return { agentOnline, dbs, apps, progress: { done, total: dbs.length + need.length, unit: "app" } };
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    if (!run.sessionId) return [{ code: "deploy-dark.projection-unavailable", level: "info" }];
    try {
      const plan = await this.port.plan(ctx.actor.userId, { sessionId: run.sessionId, sourceKind: run.sourceKind, ...(run.applyInput.dbDataModes ? { dbDataModes: run.applyInput.dbDataModes } : {}) });
      const items = includedItems(plan, run).filter((i) => !i.risks.some((r) => r.level === "blocker"));
      const marks = workerMarks(await this.hints(run));
      const policy = resolveOwnerInput(run.inputs, "workerPolicy") ?? "hold-dark";
      const apps = items.filter((i) => i.kind === "app");
      const sets = workerSets(apps.map((i) => ({ itemRef: i.itemRef, kind: i.kind, domain: "domain" in i.proposed ? ((i.proposed.domain as string | null) ?? null) : undefined })), run.applyInput, marks, policy);
      const out: DryRunItem[] = [{ code: "deploy-dark.order", level: "info", params: { databases: items.filter((i) => i.kind === "database").length, apps: apps.length - sets.held.size - sets.excluded.size, services: 0 } }];
      if (sets.held.size) out.push({ code: "deploy-dark.workers-held", level: "info", params: { count: sets.held.size } });
      if (sets.excluded.size) out.push({ code: "deploy-dark.workers-excluded", level: "info", params: { count: sets.excluded.size } });
      return out;
    } catch {
      return [{ code: "deploy-dark.projection-unavailable", level: "info" }];
    }
  }

  preGate(_ctx: StepContext, obs: DeployDarkObs): GateResult {
    void _ctx;
    return makeGate([{ id: "deploy-dark.agent", status: obs.agentOnline ? "pass" : "fail", code: obs.agentOnline ? "deploy-dark.agent-online" : "deploy-dark.agent-offline", evidence: "hub-verified" }], {
      wait: { kind: "operator", code: "deploy-dark.agent-offline" },
    });
  }

  postGate(_ctx: StepContext, obs: DeployDarkObs): GateResult {
    void _ctx;
    const checks: GateCheck[] = [];
    const badDbs = obs.dbs.filter((d) => !dbOk(d));
    const need = obs.apps.filter(required);
    const badApps = need.filter((a) => !appOk(a));
    const held = obs.apps.filter((a) => a.worker === "held").length;
    const excluded = obs.apps.filter((a) => a.worker === "excluded").length;
    if (held) checks.push({ id: "deploy-dark.workers", status: "pass", code: "deploy-dark.workers-held", params: { count: held }, evidence: "hub-verified" });
    if (excluded) checks.push({ id: "deploy-dark.workers-excluded", status: "pass", code: "deploy-dark.workers-excluded", params: { count: excluded }, evidence: "hub-verified" });
    for (const d of badDbs.slice(0, 100)) checks.push({ id: "deploy-dark.db", status: "fail", code: "deploy-dark.db-not-running", subject: d.name, params: { status: d.status }, evidence: "hub-verified" });
    for (const a of badApps.slice(0, 100)) {
      checks.push({ id: "deploy-dark.app", status: "fail", code: "deploy-dark.app-not-running", subject: a.name, params: { deploy: latest(a)?.status ?? "none", status: a.status }, evidence: "hub-verified" });
    }
    checks.push({
      id: "deploy-dark.summary",
      status: badDbs.length || badApps.length ? "fail" : "pass",
      code: "deploy-dark.summary",
      params: { databases: obs.dbs.length, apps: need.length, databasesUp: obs.dbs.length - badDbs.length, appsUp: need.length - badApps.length },
      evidence: "hub-verified",
    });
    return makeGate(checks);
  }

  async act(ctx: StepContext, obs: DeployDarkObs): Promise<ActResult> {
    const userId = ctx.actor.userId;
    const run = ctx.run;
    // compensation ids first: a crash right after a side effect still tells abort what to stop
    // (workers are never deployed here, so an abort has nothing of theirs to stop)
    await ctx.recordCompensation({ dbIds: obs.dbs.map((d) => d.id), appIds: obs.apps.filter(required).map((a) => a.id) });

    // 1) databases, one at a time
    let started = false;
    const since = { ...(compOf(ctx).provisioningSince ?? {}) };
    for (const d of obs.dbs) {
      if (!d.exists) return { outcome: "fail", code: "deploy-dark.db-missing", params: { name: d.name }, retryable: false };
      if (d.status === "RUNNING") continue;
      if (d.status === "PROVISIONING") {
        const first = since[d.id] ?? ctx.now().toISOString();
        if (!since[d.id]) {
          since[d.id] = first;
          await ctx.recordCompensation({ provisioningSince: since });
        }
        if (ctx.now().getTime() - Date.parse(first) <= PROVISION_PATIENCE_MS) {
          started = true;
          continue;
        }
        // stuck far past any live provision (the hub that began it died): the operator's retry provisions it again
        if (ctx.trigger !== "retry") return { outcome: "fail", code: "deploy-dark.db-stuck", params: { name: d.name }, retryable: true };
        delete since[d.id];
        await ctx.recordCompensation({ provisioningSince: since });
      }
      await ctx.assertLease();
      let state;
      try {
        state = await this.port.startDb(userId, d.id);
      } catch (e) {
        throw failureOf(e, "deploy-dark.db");
      }
      if (state.status !== "RUNNING") return { outcome: "fail", code: "deploy-dark.db-failed", params: { name: d.name }, retryable: true };
      started = true;
    }
    if (started) return { outcome: "continue", pollAfterMs: 2000 };

    // 2) apps, in small batches
    const need = obs.apps.filter(required);
    const failed = need.filter((a) => ["FAILED", "CANCELLED"].includes(latest(a)?.status ?? ""));
    if (failed.length && ctx.trigger !== "retry") return { outcome: "fail", code: "deploy-dark.app-failed", params: { name: failed[0].name, count: failed.length }, retryable: true };
    const todo = need.filter((a) => {
      if (!a.exists) return false;
      const l = latest(a);
      return !l || ((l.status === "FAILED" || l.status === "CANCELLED") && ctx.trigger === "retry");
    });
    const missing = need.find((a) => !a.exists);
    if (missing) return { outcome: "fail", code: "deploy-dark.app-missing", params: { name: missing.name }, retryable: false };
    if (!todo.length) return { outcome: "continue", pollAfterMs: 3000 }; // deploys are queued/running: wait for them
    // builds run `deployConcurrency` at a time PER TARGET server (R25): the small hosts of the real fleet (2 CPU / 4 GB) cannot
    // build a handful of images at once. Deploys already queued or running on a server count against its slots.
    const slots = deployConcurrencyOf(run.options);
    const busy = new Map<string, number>();
    for (const a of need) if (a.exists && latest(a) && isActiveDeploy(latest(a)!)) busy.set(a.server, (busy.get(a.server) ?? 0) + 1);
    const batch: AppRow[] = [];
    for (const a of todo) {
      if ((busy.get(a.server) ?? 0) >= slots) continue;
      busy.set(a.server, (busy.get(a.server) ?? 0) + 1);
      batch.push(a);
    }
    if (!batch.length) return { outcome: "continue", pollAfterMs: 3000 }; // every slot is building: wait for one to free
    const results = await Promise.allSettled(
      batch.map(async (a) => {
        if (ctx.signal.aborted) return;
        await ctx.assertLease();
        const base = deployKeyBase(run.id, a.id);
        const key = a.deployments.length === 0 ? base : `${base}:${a.deployments.length}`;
        // R11: an image app on a floating tag runs the digest the source runs, never today's `latest`
        if (a.pin && this.port.pinImage && (await this.port.pinImage(userId, a.id, a.pin)).pinned) await ctx.emit({ level: "info", code: "deploy-dark.image-pinned", params: { name: a.name } });
        const dep = await this.port.deploy(userId, a.id, key);
        if (dep && dep.requestedBy !== userId) throw new StepFailure("deploy-dark.key-collision", undefined, false);
      }),
    );
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw failureOf(rejected.reason, "deploy-dark.deploy");
    return { outcome: "continue", pollAfterMs: 1000 };
  }

  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort") return { outcome: "nothing-to-do" };
    const comp = compOf(ctx);
    const userId = ctx.actor.userId;
    // `apps.deploy` only enqueues: an app whose deploy is still queued or running turns RUNNING after the abort, so those
    // deployments are cancelled first (and an uncancellable one fails the compensation until it settles)
    const apps = await stopRunApps(this.port, userId, ctx.run.id, comp.appIds ?? []);
    let stopped = apps.stopped;
    let failed = apps.failed;
    for (const id of comp.dbIds ?? []) {
      const s = await this.port.dbState(userId, id);
      if (!s.exists || (s.status !== "RUNNING" && s.status !== "PROVISIONING")) continue;
      try {
        await this.port.stopDb(userId, id);
        stopped++;
      } catch {
        failed++;
      }
    }
    if (apps.active > 0) return { outcome: "failed", code: "deploy-dark.deploy-active", params: { count: apps.active } };
    if (failed > 0) return { outcome: "failed", code: "deploy-dark.stop-failed", params: { count: failed } };
    return { outcome: stopped > 0 ? "done" : "nothing-to-do" };
  }
}
