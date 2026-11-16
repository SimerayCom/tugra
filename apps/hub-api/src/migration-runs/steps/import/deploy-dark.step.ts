/**
 * Step 8, DEPLOY_DARK (P7 lane A, rollback UNDOABLE): bring the migrated databases up and deploy the migrated apps on the
 * target, "dark" (no production traffic reaches them: DNS/proxy still point at the source).
 *
 * Databases first (each `provision`ed once), then the apps in small batches through `apps.deploy` under the idempotency
 * key `migrun:<runId>:<appId>` (a retry after a failed deploy takes a numbered suffix), so a crash and a re-drive never
 * deploy an app twice. Compensation ids are written before the first side effect; abort stops exactly those apps and
 * databases (never removes anything). Services (compose stacks) are not deployed: they stay stopped unless the operator
 * starts them.
 */
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
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
import { deployKeyBase, failureOf, includedItems } from "./step-utils";

const BATCH = 3;

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
}

export interface DeployDarkObs extends Observation {
  agentOnline: boolean;
  dbs: DbRow[];
  apps: AppRow[];
}

interface Comp {
  dbIds?: string[];
  appIds?: string[];
}
const compOf = (ctx: StepContext): Comp => (ctx.step.compensation ?? {}) as Comp;

const latest = (a: AppRow): DeploymentRef | undefined => a.deployments[a.deployments.length - 1];
const appOk = (a: AppRow): boolean => a.exists && latest(a)?.status === "SUCCESS" && a.status === "RUNNING";
const dbOk = (d: DbRow): boolean => d.exists && d.status === "RUNNING";

@Injectable()
export class DeployDarkStep implements StepHandler<DeployDarkObs>, OnModuleInit {
  readonly key = "DEPLOY_DARK" as const;
  readonly kind = "auto" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(IMPORT_STEPS_PORT) private readonly port: ImportStepsPort,
  ) {}

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
    const target = await this.port.target(userId, { serverId: run.targetServerId, hosts: [] });
    const dbTasks = op.tasks.filter((t) => t.kind === "database" && t.status === "DONE" && t.resourceType === "database" && !!t.resourceId);
    const appTasks = op.tasks.filter((t) => t.kind === "app" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId);
    const dbs: DbRow[] = [];
    for (const t of dbTasks) {
      const s = await this.port.dbState(userId, t.resourceId!);
      dbs.push({ id: t.resourceId!, name: s.name ?? t.name ?? "", status: s.status, exists: s.exists });
    }
    const apps: AppRow[] = [];
    for (const t of appTasks) {
      const id = t.resourceId!;
      const [s, deployments] = await Promise.all([this.port.appState(userId, id), this.port.deployments(id, deployKeyBase(run.id, id))]);
      apps.push({ id, name: s.name ?? t.name ?? "", status: s.status, exists: s.exists, deployments });
    }
    const done = dbs.filter(dbOk).length + apps.filter(appOk).length;
    return { agentOnline: target.agentOnline, dbs, apps, progress: { done, total: dbs.length + apps.length, unit: "app" } };
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    if (!run.sessionId) return [{ code: "deploy-dark.projection-unavailable", level: "info" }];
    try {
      const plan = await this.port.plan(ctx.actor.userId, { sessionId: run.sessionId, sourceKind: run.sourceKind, ...(run.applyInput.dbDataModes ? { dbDataModes: run.applyInput.dbDataModes } : {}) });
      const items = includedItems(plan, run).filter((i) => !i.risks.some((r) => r.level === "blocker"));
      return [{ code: "deploy-dark.order", level: "info", params: { databases: items.filter((i) => i.kind === "database").length, apps: items.filter((i) => i.kind === "app").length, services: 0 } }];
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
    const badApps = obs.apps.filter((a) => !appOk(a));
    for (const d of badDbs.slice(0, 100)) checks.push({ id: "deploy-dark.db", status: "fail", code: "deploy-dark.db-not-running", subject: d.name, params: { status: d.status }, evidence: "hub-verified" });
    for (const a of badApps.slice(0, 100)) {
      checks.push({ id: "deploy-dark.app", status: "fail", code: "deploy-dark.app-not-running", subject: a.name, params: { deploy: latest(a)?.status ?? "none", status: a.status }, evidence: "hub-verified" });
    }
    checks.push({
      id: "deploy-dark.summary",
      status: badDbs.length || badApps.length ? "fail" : "pass",
      code: "deploy-dark.summary",
      params: { databases: obs.dbs.length, apps: obs.apps.length, databasesUp: obs.dbs.length - badDbs.length, appsUp: obs.apps.length - badApps.length },
      evidence: "hub-verified",
    });
    return makeGate(checks);
  }

  async act(ctx: StepContext, obs: DeployDarkObs): Promise<ActResult> {
    const userId = ctx.actor.userId;
    const run = ctx.run;
    // compensation ids first: a crash right after a side effect still tells abort what to stop
    await ctx.recordCompensation({ dbIds: obs.dbs.map((d) => d.id), appIds: obs.apps.map((a) => a.id) });

    // 1) databases, one at a time
    let started = false;
    for (const d of obs.dbs) {
      if (!d.exists) return { outcome: "fail", code: "deploy-dark.db-missing", params: { name: d.name }, retryable: false };
      if (d.status === "RUNNING") continue;
      if (d.status === "PROVISIONING") {
        started = true;
        continue;
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
    const failed = obs.apps.filter((a) => ["FAILED", "CANCELLED"].includes(latest(a)?.status ?? ""));
    if (failed.length && ctx.trigger !== "retry") return { outcome: "fail", code: "deploy-dark.app-failed", params: { name: failed[0].name, count: failed.length }, retryable: true };
    const todo = obs.apps.filter((a) => {
      if (!a.exists) return false;
      const l = latest(a);
      return !l || ((l.status === "FAILED" || l.status === "CANCELLED") && ctx.trigger === "retry");
    });
    const missing = obs.apps.find((a) => !a.exists);
    if (missing) return { outcome: "fail", code: "deploy-dark.app-missing", params: { name: missing.name }, retryable: false };
    if (!todo.length) return { outcome: "continue", pollAfterMs: 3000 }; // deploys are queued/running: wait for them
    const batch = todo.slice(0, BATCH);
    const results = await Promise.allSettled(
      batch.map(async (a) => {
        if (ctx.signal.aborted) return;
        await ctx.assertLease();
        const base = deployKeyBase(run.id, a.id);
        const key = a.deployments.length === 0 ? base : `${base}:${a.deployments.length}`;
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
    let stopped = 0;
    let failed = 0;
    for (const id of comp.appIds ?? []) {
      const s = await this.port.appState(userId, id);
      if (!s.exists || s.status !== "RUNNING") continue;
      try {
        await this.port.stopApp(userId, id);
        stopped++;
      } catch {
        failed++;
      }
    }
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
    if (failed > 0) return { outcome: "failed", code: "deploy-dark.stop-failed", params: { count: failed } };
    return { outcome: stopped > 0 ? "done" : "nothing-to-do" };
  }
}
