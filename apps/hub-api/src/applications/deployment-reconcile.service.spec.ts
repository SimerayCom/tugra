import { DeploymentReconcileService, INTERRUPTED_DEPLOY_NOTE, CLUSTERED_QUEUED_DROP_NOTE } from "./deployment-reconcile.service";

describe("DeploymentReconcileService", () => {
  const BOOT = "boot-new";
  function make(counts: number[] = [0, 0, 0]) {
    let i = 0;
    const updateMany = jest.fn().mockImplementation(async () => ({ count: counts[i++] ?? 0 }));
    const prisma = { deployment: { updateMany } } as never;
    return { svc: new DeploymentReconcileService(prisma, { bootId: BOOT } as never), updateMany };
  }

  it("FIRST releases recoverable RUNNING rows (durable command dispatched, deadline ahead, not ours) for adoption instead of failing them", async () => {
    const { svc, updateMany } = make([1, 2, 0]);
    await svc.onApplicationBootstrap();
    const call = updateMany.mock.calls[0][0];
    expect(call.where.status).toBe("RUNNING");
    expect(call.where.agentReqId).toEqual({ not: null });
    expect(call.where).not.toHaveProperty("deadlineAt"); // journal-first: even a long outage asks the agent before guessing
    expect(call.where.OR).toEqual([{ ownerId: null }, { ownerId: { not: BOOT } }]);
    expect(call.data).toEqual({ ownerId: null, phase: "RECOVERING" });
    // CRUCIAL: the recoverable release keeps the row RUNNING — no status/FAILED/exitCode write.
    expect(call.data).not.toHaveProperty("status");
  });

  it("THEN reaps every other RUNNING row not owned by this process to the exact legacy FAILED shape — NULL-safe on phase (pre-migration rows have phase NULL), never a RECOVERING one, never ours", async () => {
    const { svc, updateMany } = make([0, 2, 0]);
    await svc.onApplicationBootstrap();
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { status: "RUNNING", AND: [{ OR: [{ phase: null }, { phase: { not: "RECOVERING" } }] }, { OR: [{ ownerId: null }, { ownerId: { not: BOOT } }] }] },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE, ownerId: null, phase: null },
    });
    // CRUCIAL: a bare `phase: { not: ... }` would compile to `phase <> x`, which never matches NULL — the reap must
    // carry an explicit `phase: null` branch or every legacy orphan survives and wedges its app.
    const reap = updateMany.mock.calls[1][0].where;
    expect(JSON.stringify(reap)).toContain('{"phase":null}');
  });

  it("cancels CLUSTERED QUEUED deploys at boot (swarm resume deferred) but LEAVES non-clustered QUEUED intact", async () => {
    const { svc, updateMany } = make([0, 0, 1]);
    await svc.onApplicationBootstrap();
    expect(updateMany).toHaveBeenNthCalledWith(3, {
      where: { status: "QUEUED", application: { clusterId: { not: null } } },
      data: { status: "CANCELLED", exitCode: -1, logs: CLUSTERED_QUEUED_DROP_NOTE },
    });
    for (const call of updateMany.mock.calls) {
      if (call[0].where.status === "QUEUED") expect(call[0].where.application).toEqual({ clusterId: { not: null } });
    }
  });

  it("the RUNNING reap never stamps a (misleading) durationMs for an interrupted run", async () => {
    const { svc, updateMany } = make();
    await svc.onApplicationBootstrap();
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty("durationMs");
  });

  it("is a no-op (no throw) when there is nothing to reap", async () => {
    const { svc } = make();
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
