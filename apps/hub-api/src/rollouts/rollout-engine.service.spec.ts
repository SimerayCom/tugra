import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RolloutEngineService } from "./rollout-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { AppBusyException, ApplicationsService } from "../applications/applications.service";
import { NotificationsService } from "../notifications/notifications.service";
import { INTERRUPTED_DEPLOY_NOTE } from "../applications/deployment-reconcile.service";
import { RolloutConfigSchema } from "./rollout-plan";

/**
 * The engine against an in-memory store that honours the compare-and-set shapes the engine relies on
 * (updateMany WHERE id+status / currentWave). The deploy pipeline is a fake port (deployDetached returns a row).
 */
type Row = Record<string, unknown> & { id: string };
const NOW = Date.parse("2026-11-15T10:00:00Z");

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "rollout") return false; // relation filters (the tick's slot self-heal) are not modelled here
    if (k === "OR") continue; // the tick's live-rollout OR → every rollout row qualifies in these fixtures
    const cur = row[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { in?: unknown[]; not?: unknown };
      if (op.in && !op.in.includes(cur)) return false;
      if ("not" in op && (op.not === null ? cur === null : cur === op.not)) return false;
    } else if (cur !== v) return false;
  }
  return true;
}

function table(rows: Row[]) {
  return {
    rows,
    findUnique: jest.fn(async (args: { where: { id?: string; appId_idempotencyKey?: { appId: string; idempotencyKey: string } } }) => {
      if (args.where.appId_idempotencyKey) {
        const k = args.where.appId_idempotencyKey;
        return rows.find((r) => r.appId === k.appId && r.idempotencyKey === k.idempotencyKey) ?? null;
      }
      return rows.find((r) => r.id === args.where.id) ?? null;
    }),
    findMany: jest.fn(async (args: { where?: Record<string, unknown>; select?: unknown; distinct?: string[]; orderBy?: unknown } = {}) => {
      let out = rows.filter((r) => !args.where || matches(r, args.where));
      if (args.distinct?.includes("appId")) {
        const seen = new Set<string>();
        out = [...out].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()).filter((r) => (seen.has(r.appId as string) ? false : (seen.add(r.appId as string), true)));
      }
      return out;
    }),
    findFirst: jest.fn(async (args: { where: Record<string, unknown> } = { where: {} }) => {
      // Only what supersededSince() asks: appId, id.not, createdAt.gt, status.in, NOT.idempotencyKey.startsWith
      const w = args.where as { appId?: string; id?: { not?: string }; createdAt?: { gt?: Date }; status?: { in?: string[] }; NOT?: { idempotencyKey?: { startsWith?: string } } };
      return (
        rows.find(
          (r) =>
            (!w.appId || r.appId === w.appId) &&
            (!w.id?.not || r.id !== w.id.not) &&
            (!w.createdAt?.gt || (r.createdAt as Date) > w.createdAt.gt) &&
            (!w.status?.in || w.status.in.includes(r.status as string)) &&
            (!w.NOT?.idempotencyKey?.startsWith || !String(r.idempotencyKey ?? "").startsWith(w.NOT.idempotencyKey.startsWith)),
        ) ?? null
      );
    }),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === args.where.id)!;
      Object.assign(r, args.data);
      return r;
    }),
    updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r, args.where));
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    }),
  };
}

function make(opts: {
  rollout?: Partial<Row>;
  targets: Array<Partial<Row> & { id: string; resourceId: string }>;
  deployments?: Row[];
  apps?: Row[];
  online?: Set<string>;
  deploy?: jest.Mock;
}) {
  const config = RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 10, ...(opts.rollout?.config as object | undefined) });
  const rolloutRow: Row = {
    id: "r1",
    teamId: "t1",
    createdBy: "u1",
    status: "RUNNING",
    currentWave: 0,
    waveCount: 2,
    waveStartedAt: new Date(NOW - 10_000),
    bakeUntil: null,
    haltReason: null,
    haltDetail: null,
    ...opts.rollout,
    config,
  };
  const targets = table(
    opts.targets.map((t, i) => ({
      rolloutId: "r1",
      wave: 0,
      position: i,
      kind: "app_deploy",
      serverId: "s1",
      label: t.resourceId,
      status: "PENDING",
      attempt: 0,
      baselineDeploymentId: null,
      deploymentId: null,
      rollbackDeploymentId: null,
      rollbackAttempt: 0,
      outcome: null,
      detail: null,
      active: true,
      dispatchedAt: null,
      finishedAt: null,
      ...t,
    })),
  );
  const rollouts = table([rolloutRow]);
  // include: targets
  (rollouts as { findUnique: unknown }).findUnique = jest.fn(async (args: { where: { id: string } }) => {
    const r = rollouts.rows.find((x) => x.id === args.where.id);
    return r ? { ...r, targets: [...targets.rows].sort((a, b) => (a.wave as number) - (b.wave as number) || (a.position as number) - (b.position as number)) } : null;
  });
  const deployments = table(opts.deployments ?? []);
  const appDefaults = { status: "RUNNING", serverId: "s1", buildServerId: null, clusterId: null, source: "GIT", rollbackOnFailure: true, healthCheckType: null, imagesToKeep: null, autoDeploy: false };
  const apps = table((opts.apps ?? opts.targets.map((t) => ({ id: t.resourceId }))).map((a) => ({ ...appDefaults, ...a })));
  const prismaBase = { rollout: rollouts, rolloutTarget: targets, deployment: deployments, application: apps };
  const prisma = { ...prismaBase, $transaction: async (cb: (tx: typeof prismaBase) => unknown) => cb(prismaBase) } as unknown as PrismaService;
  const online = opts.online ?? new Set(["s1"]);
  const audit = jest.fn().mockResolvedValue(undefined);
  let seq = (opts.deployments ?? []).length; // fresh ids never collide with fixture rows
  const deploy =
    opts.deploy ??
    jest.fn(async (_u: string, appId: string, o: { key: string }) => {
      const row = { id: `d${++seq}`, appId, idempotencyKey: o.key, status: "RUNNING", kind: "DEPLOY", exitCode: null, logs: null, startedAt: new Date(NOW), createdAt: new Date(NOW) };
      deployments.rows.push(row);
      return row;
    });
  const cancelQueued = jest.fn(async (id: string) => {
    const d = deployments.rows.find((x) => x.id === id);
    if (!d || d.status !== "QUEUED") return false;
    d.status = "CANCELLED";
    return true;
  });
  let rbSeq = 0;
  const rollbackDetached = jest.fn(async (_u: string, appId: string, _target: string, o: { key: string }) => {
    const row = { id: `rb${++rbSeq}`, appId, idempotencyKey: o.key, status: "RUNNING", kind: "ROLLBACK", exitCode: null, logs: null, startedAt: new Date(NOW), createdAt: new Date(NOW) };
    deployments.rows.push(row);
    return row;
  });
  const appsSvc = { deployDetached: deploy, cancelQueuedDeploymentSystem: cancelQueued, rolloutBaseline: jest.fn().mockResolvedValue("base1"), rollbackDetached } as unknown as ApplicationsService;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const svc = new RolloutEngineService(prisma, { log: audit } as unknown as AuditService, { isOnline: (s: string) => online.has(s) } as unknown as AgentWsServer, appsSvc, { fireForEvent } as unknown as NotificationsService);
  (svc as unknown as { now: () => number }).now = () => NOW;
  (svc as unknown as { bootAt: number }).bootAt = NOW - 3_600_000;
  const status = (id: string) => targets.rows.find((t) => t.id === id)!;
  return { svc, rolloutRow, targets, deployments, deploy, cancelQueued, audit, status, online, rollbackDetached, fireForEvent };
}

describe("RolloutEngineService — dispatch", () => {
  it("claims PENDING targets of the current wave (CAS → DEPLOYING, attempt+1, baseline recorded), dispatches detached as the initiator with a per-attempt key, pins the Deployment id", async () => {
    const m = make({ targets: [{ id: "a", resourceId: "app1" }, { id: "b", resourceId: "app2", wave: 1 }] });
    await m.svc.advance("r1");
    expect(m.deploy).toHaveBeenCalledTimes(1);
    expect(m.deploy).toHaveBeenCalledWith("u1", "app1", { key: "rollout:r1:app1:1", noCache: false });
    expect(m.status("a")).toMatchObject({ status: "DEPLOYING", attempt: 1, deploymentId: "d1", baselineDeploymentId: "base1" });
    expect(m.status("b")).toMatchObject({ status: "PENDING" }); // next wave untouched
  });

  it("respects concurrency within a wave and never dispatches to an offline agent", async () => {
    const m = make({
      rollout: { config: { concurrency: 2 } },
      targets: [{ id: "a", resourceId: "app1" }, { id: "b", resourceId: "app2" }, { id: "c", resourceId: "app3" }, { id: "d", resourceId: "app4", serverId: "s2" }],
      apps: [{ id: "app1" }, { id: "app2" }, { id: "app3" }, { id: "app4", serverId: "s2" }],
    });
    await m.svc.advance("r1");
    expect(m.deploy).toHaveBeenCalledTimes(2);
    expect(m.status("c").status).toBe("PENDING");
    expect(m.status("d").status).toBe("PENDING"); // s2 offline → waits
  });

  it("maps dispatch errors: offline → back to PENDING; app gone → SKIPPED; forbidden → FAILED + HALT initiator_lost; queue full → FAILED", async () => {
    const errors = [new AgentOfflineException(), new NotFoundException("application not found"), new ConflictException("deploy queue is full")];
    const m = make({
      targets: [{ id: "a", resourceId: "app1" }, { id: "b", resourceId: "app2" }, { id: "c", resourceId: "app3" }],
      deploy: jest.fn(async () => {
        throw errors.shift();
      }),
    });
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "PENDING", dispatchedAt: null });
    expect(m.status("b")).toMatchObject({ status: "SKIPPED", outcome: "app_gone" });
    expect(m.status("c")).toMatchObject({ status: "FAILED", outcome: "queue_full" });

    const f = make({ targets: [{ id: "a", resourceId: "app1" }], deploy: jest.fn().mockRejectedValue(new ForbiddenException("nope")) });
    await f.svc.advance("r1");
    expect(f.status("a")).toMatchObject({ status: "FAILED", outcome: "forbidden" });
    expect(f.rolloutRow).toMatchObject({ status: "HALTED", haltReason: "initiator_lost" });
  });
});

describe("RolloutEngineService — settle, waves, halt", () => {
  const deployingTarget = (id: string, app: string, depId: string, wave = 0) => ({ id, resourceId: app, wave, status: "DEPLOYING", attempt: 1, deploymentId: depId });
  const depRow = (id: string, app: string, over: Partial<Row> = {}): Row => ({ id, appId: app, status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 5000), createdAt: new Date(NOW - 6000), ...over });

  it("a passed wave promotes to the next wave (CAS on currentWave) and immediately dispatches it; the last wave completes and releases the apps' slots", async () => {
    const m = make({ targets: [deployingTarget("a", "app1", "d1"), { id: "b", resourceId: "app2", wave: 1 }], deployments: [depRow("d1", "app1")] });
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "SUCCEEDED", outcome: "passed" });
    expect(m.rolloutRow).toMatchObject({ currentWave: 1, status: "RUNNING" });
    // the promote re-ran the pass for wave 1 inside the same advance()
    expect(m.status("b").status).toBe("DEPLOYING");
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "rollout.wave.promote", meta: expect.objectContaining({ from: 0, to: 1 }) }));

    // wave 1 passes → complete
    m.deployments.rows.find((d) => d.id === "d2")!.status = "SUCCESS";
    await m.svc.advance("r1");
    expect(m.rolloutRow).toMatchObject({ status: "COMPLETED" });
    expect(m.targets.rows.every((t) => t.active === false)).toBe(true);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "rollout.complete" }));
    expect(m.fireForEvent).toHaveBeenCalledWith("t1", "rollout_completed", expect.objectContaining({ rolloutId: "r1", waves: 2, total: 2, passed: 2 }));
  });

  it("FAIL FAST: a rejected (auto-rolled-back) deploy halts the wave at once — still-QUEUED siblings are cancelled (CANCELLED/halted), a RUNNING one finishes and is settled while HALTED, nothing new is dispatched", async () => {
    const m = make({
      targets: [deployingTarget("a", "app1", "d1"), deployingTarget("b", "app2", "d2"), deployingTarget("c", "app3", "d3"), { id: "d", resourceId: "app4" }],
      deployments: [
        depRow("d1", "app1", { status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 4 }),
        depRow("d2", "app2", { status: "QUEUED", startedAt: null }),
        depRow("d3", "app3", { status: "RUNNING" }),
      ],
    });
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "FAILED", outcome: "rejected_safe" });
    expect(m.rolloutRow).toMatchObject({ status: "HALTED", haltReason: "wave_failed" });
    expect(m.status("b")).toMatchObject({ status: "CANCELLED", outcome: "halted" });
    expect(m.status("c").status).toBe("DEPLOYING");
    expect(m.status("d").status).toBe("PENDING");
    expect(m.deploy).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "rollout.halt", meta: expect.objectContaining({ reason: "wave_failed" }) }));
    expect(m.fireForEvent).toHaveBeenCalledWith("t1", "rollout_halted", expect.objectContaining({ reason: "wave_failed", wave: 1, waves: 2 }));
    m.deployments.rows.find((d) => d.id === "d3")!.status = "SUCCESS";
    await m.svc.advance("r1");
    expect(m.status("c")).toMatchObject({ status: "SUCCEEDED" });
    expect(m.rolloutRow.status).toBe("HALTED");
  });

  it("dispatch re-checks the rollout right before claiming: a halt/cancel that landed mid-pass dispatches nothing more", async () => {
    const m = make({ targets: [{ id: "a", resourceId: "app1" }, { id: "b", resourceId: "app2" }] });
    m.deploy.mockImplementationOnce(async (_u: string, appId: string, o: { key: string }) => {
      m.rolloutRow.status = "HALTED"; // an operator halts while the first dispatch is in flight
      const row = { id: "dX", appId, idempotencyKey: o.key, status: "RUNNING", kind: "DEPLOY", exitCode: null, logs: null, startedAt: new Date(NOW), createdAt: new Date(NOW) };
      m.deployments.rows.push(row);
      return row;
    });
    await m.svc.advance("r1");
    expect(m.deploy).toHaveBeenCalledTimes(1);
    expect(m.status("a").status).toBe("DEPLOYING");
    expect(m.status("b").status).toBe("PENDING");
  });

  it("re-preflights the CURRENT app row at dispatch: an app that lost its gate since the plan is SKIPPED, never deployed ungated", async () => {
    const m = make({ targets: [{ id: "a", resourceId: "app1" }, { id: "b", resourceId: "app2" }], apps: [{ id: "app1", rollbackOnFailure: false }, { id: "app2", clusterId: "c1" }] });
    await m.svc.advance("r1");
    expect(m.deploy).not.toHaveBeenCalled();
    expect(m.status("a")).toMatchObject({ status: "SKIPPED", outcome: "preflight" });
    expect(m.status("b")).toMatchObject({ status: "SKIPPED", outcome: "preflight" });
  });

  it("a deploy that WAS enqueued is never written off: when pinning fails (or the process died before it), the row is recovered by its idempotency key", async () => {
    const m = make({ targets: [{ id: "a", resourceId: "app1" }] });
    m.deploy.mockImplementationOnce(async (_u: string, appId: string, o: { key: string }) => {
      m.deployments.rows.push({ id: "dReal", appId, idempotencyKey: o.key, status: "RUNNING", kind: "DEPLOY", exitCode: null, logs: null, startedAt: new Date(NOW), createdAt: new Date(NOW) });
      throw new Error("socket hang up after the enqueue");
    });
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "DEPLOYING", deploymentId: "dReal" });
    // crash window: DEPLOYING with no pinned id → the snapshot recovers it before judging
    const c = make({ targets: [{ id: "a", resourceId: "app1", status: "DEPLOYING", attempt: 1, deploymentId: null }], deployments: [{ id: "dOld", appId: "app1", idempotencyKey: "rollout:r1:app1:1", status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 5000), createdAt: new Date(NOW - 6000) }] });
    await c.svc.advance("r1");
    expect(c.status("a")).toMatchObject({ status: "SUCCEEDED", deploymentId: "dOld" });
  });

  it("queue_timeout only abandons a deploy that is STILL queued; one that started meanwhile keeps its target DEPLOYING", async () => {
    const stale = { status: "QUEUED", startedAt: null, createdAt: new Date(NOW - 3000_000) };
    const m = make({ targets: [deployingTarget("a", "app1", "d1"), deployingTarget("b", "app2", "d2")], deployments: [depRow("d1", "app1", stale), depRow("d2", "app2", stale)] });
    m.cancelQueued.mockImplementation(async (id: string) => id === "d1"); // d2 started between the snapshot and the cancel
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "FAILED", outcome: "queue_timeout" });
    expect(m.status("b").status).toBe("DEPLOYING");
  });

  it("halt cancels the rollout's still-QUEUED deploys (CANCELLED/halted) but never a RUNNING one; late results are settled while HALTED", async () => {
    const m = make({
      targets: [deployingTarget("a", "app1", "d1"), deployingTarget("b", "app2", "d2")],
      deployments: [depRow("d1", "app1", { status: "QUEUED", startedAt: null }), depRow("d2", "app2", { status: "RUNNING" })],
    });
    expect(await m.svc.halt("r1", "manual", { by: "u1" }, "u1")).toBe(true);
    expect(m.cancelQueued).toHaveBeenCalledWith("d1", expect.any(String));
    expect(m.status("a")).toMatchObject({ status: "CANCELLED", outcome: "halted" });
    expect(m.status("b").status).toBe("DEPLOYING");
    expect(await m.svc.halt("r1", "manual", undefined, "u1")).toBe(false); // already HALTED → CAS no-op
    m.deployments.rows.find((d) => d.id === "d2")!.status = "SUCCESS";
    await m.svc.advance("r1");
    expect(m.status("b")).toMatchObject({ status: "SUCCEEDED" });
    expect(m.rolloutRow.status).toBe("HALTED"); // no advance while halted
  });

  it("an interrupted deploy (hub restart) halts with reason interrupted and dispatches nothing else", async () => {
    const m = make({
      targets: [deployingTarget("a", "app1", "d1"), { id: "b", resourceId: "app2" }],
      deployments: [depRow("d1", "app1", { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE })],
    });
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "FAILED", outcome: "interrupted" });
    expect(m.rolloutRow).toMatchObject({ status: "HALTED", haltReason: "interrupted" });
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("tick() advances every live rollout and isolates a failing one", async () => {
    const m = make({ targets: [{ id: "a", resourceId: "app1" }] });
    const findMany = (m.svc as unknown as { prisma: { rollout: { findMany: jest.Mock } } }).prisma.rollout.findMany;
    findMany.mockResolvedValueOnce([{ id: "ghost" }, { id: "r1" }]);
    await m.svc.tick();
    expect(m.status("a").status).toBe("DEPLOYING");
  });

  it("a settle never overwrites a terminal target (late duplicate verdicts are no-ops)", async () => {
    const m = make({ targets: [{ id: "a", resourceId: "app1", status: "SUCCEEDED", outcome: "passed", deploymentId: "d1", attempt: 1 }], deployments: [depRow("d1", "app1", { status: "FAILED" })] });
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "SUCCEEDED", outcome: "passed" });
  });
});

describe("RolloutEngineService — fleet rollback", () => {
  const revertingTarget = (id: string, app: string, over: Partial<Row> = {}) => ({ id, resourceId: app, status: "REVERTING", attempt: 1, deploymentId: `d-${id}`, baselineDeploymentId: `base-${app}`, ...over });

  it("dispatches the detached per-app rollback to the baseline under the operator with a per-attempt key, pins the ROLLBACK row, then judges it → ROLLED_BACK and finishes + notifies", async () => {
    const ourDeploy = { id: "d-a", appId: "app1", status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 7000), createdAt: new Date(NOW - 8000) };
    const m = make({ rollout: { status: "ROLLING_BACK", createdBy: "op2" }, targets: [revertingTarget("a", "app1")], deployments: [ourDeploy] });
    await m.svc.advance("r1");
    expect(m.rollbackDetached).toHaveBeenCalledWith("op2", "app1", "base-app1", { key: "rollout:rb:r1:app1:1" });
    expect(m.status("a")).toMatchObject({ status: "REVERTING", rollbackAttempt: 1, rollbackDeploymentId: "rb1" });
    m.deployments.rows.find((d) => d.id === "rb1")!.status = "SUCCESS";
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "ROLLED_BACK", outcome: "reverted" });
    expect(m.rolloutRow.status).toBe("ROLLED_BACK");
    expect(m.targets.rows.every((t) => t.active === false)).toBe(true);
    expect(m.fireForEvent).toHaveBeenCalledWith("t1", "rollout_rolled_back", expect.objectContaining({ rolloutId: "r1" }));
  });

  it("a busy app (409) is retried next tick without burning the attempt; a missing baseline artifact (404) and a failed rollback deploy end ROLLBACK_FAILED + notify", async () => {
    const m = make({
      rollout: { status: "ROLLING_BACK" },
      targets: [revertingTarget("a", "app1"), revertingTarget("b", "app2"), revertingTarget("c", "app3", { baselineDeploymentId: null })],
      deployments: ["a", "b"].map((id) => ({ id: `d-${id}`, appId: id === "a" ? "app1" : "app2", status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 7000), createdAt: new Date(NOW - 8000) })),
    });
    m.rollbackDetached.mockImplementationOnce(async () => {
      throw new AppBusyException();
    });
    m.rollbackDetached.mockImplementationOnce(async () => {
      throw new NotFoundException("no rollbackable deployment with that id");
    });
    await m.svc.advance("r1");
    // the first (refused) try stamps the busy clock; the attempt counter is rolled back
    expect(m.status("a")).toMatchObject({ status: "REVERTING", rollbackAttempt: 0, rollbackDeploymentId: null, dispatchedAt: new Date(NOW) });
    expect(m.status("b")).toMatchObject({ status: "ROLLBACK_FAILED", outcome: "baseline_unavailable" });
    expect(m.status("c")).toMatchObject({ status: "ROLLBACK_FAILED", outcome: "no_baseline" });
    // next tick: a dispatches for real, its rollback fails on the agent
    await m.svc.advance("r1");
    expect(m.rollbackDetached).toHaveBeenLastCalledWith("u1", "app1", "base-app1", { key: "rollout:rb:r1:app1:1" });
    m.deployments.rows.find((d) => d.id === "rb1")!.status = "FAILED";
    (m.deployments.rows.find((d) => d.id === "rb1") as Row).exitCode = 7;
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "ROLLBACK_FAILED", outcome: "revert_failed", detail: "exit 7" });
    expect(m.rolloutRow.status).toBe("ROLLBACK_FAILED");
    expect(m.fireForEvent).toHaveBeenCalledWith("t1", "rollout_rollback_failed", expect.objectContaining({ failed: 3 }));
  });

  it("re-checks supersession at DISPATCH time: an app deployed again since (success, or merely queued behind) is left untouched — SKIPPED/superseded, rollback never called; this rollout's own rollback rows don't count; a pruned deploy row means 'never revert blind'", async () => {
    const ours = { id: "d-a", appId: "app1", status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 7000), createdAt: new Date(NOW - 8000) };
    const newer = { id: "dNew", appId: "app1", status: "QUEUED", kind: "DEPLOY", exitCode: null, logs: null, startedAt: null, createdAt: new Date(NOW - 100) };
    const m = make({ rollout: { status: "ROLLING_BACK" }, targets: [revertingTarget("a", "app1")], deployments: [ours, newer] });
    await m.svc.advance("r1");
    expect(m.rollbackDetached).not.toHaveBeenCalled();
    expect(m.status("a")).toMatchObject({ status: "SKIPPED", outcome: "superseded" });
    await m.svc.advance("r1"); // next tick: nothing left reverting → finished (0 reverted, 0 failed)
    expect(m.rolloutRow.status).toBe("ROLLED_BACK");
    // our own earlier rollback attempt row is not "newer"
    const ownRb = { id: "rbOld", appId: "app1", idempotencyKey: "rollout:rb:r1:app1:1", status: "SUCCESS", kind: "ROLLBACK", exitCode: 0, logs: null, startedAt: new Date(NOW - 50), createdAt: new Date(NOW - 60) };
    const own = make({ rollout: { status: "ROLLING_BACK" }, targets: [revertingTarget("a", "app1", { rollbackAttempt: 1 })], deployments: [ours, ownRb] });
    await own.svc.advance("r1");
    expect(own.status("a")).toMatchObject({ status: "ROLLED_BACK", rollbackDeploymentId: "rbOld" });
    // pruned deploy row → unverifiable → skipped
    const pruned = make({ rollout: { status: "ROLLING_BACK" }, targets: [revertingTarget("a", "app1")], deployments: [] });
    await pruned.svc.advance("r1");
    expect(pruned.rollbackDetached).not.toHaveBeenCalled();
    expect(pruned.status("a")).toMatchObject({ status: "SKIPPED", outcome: "superseded" });
  });

  it("Forbidden / generic dispatch failures end ROLLBACK_FAILED with their outcome; a failing notification never breaks the finish", async () => {
    const ours = (app: string, id: string) => ({ id, appId: app, status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 7000), createdAt: new Date(NOW - 8000) });
    const m = make({ rollout: { status: "ROLLING_BACK" }, targets: [revertingTarget("a", "app1"), revertingTarget("b", "app2")], deployments: [ours("app1", "d-a"), ours("app2", "d-b")] });
    m.rollbackDetached.mockRejectedValueOnce(new ForbiddenException("nope")).mockRejectedValueOnce(new Error("boom"));
    m.fireForEvent.mockRejectedValue(new Error("smtp down"));
    await expect(m.svc.advance("r1")).resolves.toBeUndefined();
    expect(m.status("a")).toMatchObject({ status: "ROLLBACK_FAILED", outcome: "forbidden" });
    expect(m.status("b")).toMatchObject({ status: "ROLLBACK_FAILED", outcome: "revert_dispatch_failed" });
    await expect(m.svc.advance("r1")).resolves.toBeUndefined(); // the finish fires the (failing) notification
    expect(m.rolloutRow.status).toBe("ROLLBACK_FAILED");
  });

  it("a conflict that is NOT 'busy' (swarm app, key collision) is final: ROLLBACK_FAILED/revert_refused, no retry", async () => {
    const m = make({ rollout: { status: "ROLLING_BACK" }, targets: [revertingTarget("a", "app1")], deployments: [{ id: "d-a", appId: "app1", status: "SUCCESS", kind: "DEPLOY", exitCode: 0, logs: null, startedAt: new Date(NOW - 7000), createdAt: new Date(NOW - 8000) }] });
    m.rollbackDetached.mockRejectedValueOnce(new ConflictException("swarm apps cannot be rolled back by a rollout"));
    await m.svc.advance("r1");
    expect(m.status("a")).toMatchObject({ status: "ROLLBACK_FAILED", outcome: "revert_refused" });
  });

  it("a revert dispatch that died after the row was created is recovered by its key (never a duplicate rollback)", async () => {
    const m = make({ rollout: { status: "ROLLING_BACK" }, targets: [revertingTarget("a", "app1", { rollbackAttempt: 1 })], deployments: [{ id: "rbX", appId: "app1", idempotencyKey: "rollout:rb:r1:app1:1", status: "SUCCESS", kind: "ROLLBACK", exitCode: 0, logs: null, startedAt: new Date(NOW - 50), createdAt: new Date(NOW - 60) }] });
    await m.svc.advance("r1");
    expect(m.rollbackDetached).not.toHaveBeenCalled();
    expect(m.status("a")).toMatchObject({ status: "ROLLED_BACK", rollbackDeploymentId: "rbX" });
  });
});
