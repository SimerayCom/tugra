import { DeploymentReconcileService, INTERRUPTED_DEPLOY_NOTE } from "./deployment-reconcile.service";

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
    const { svc, updateMany } = make([0, 0, 2]);
    await svc.onApplicationBootstrap();
    expect(updateMany).toHaveBeenNthCalledWith(3, {
      where: { status: "RUNNING", AND: [{ OR: [{ phase: null }, { phase: { not: "RECOVERING" } }] }, { OR: [{ ownerId: null }, { ownerId: { not: BOOT } }] }] },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE, ownerId: null, phase: null },
    });
    // CRUCIAL: a bare `phase: { not: ... }` would compile to `phase <> x`, which never matches NULL — the reap must
    // carry an explicit `phase: null` branch or every legacy orphan survives and wedges its app.
    const reap = updateMany.mock.calls[2][0].where;
    expect(JSON.stringify(reap)).toContain('{"phase":null}');
  });

  it("swarm resume: re-queues a swarm deploy caught in its pre-dispatch PREPARING phase (nothing journaled, not ours) BETWEEN the adoption release and the reap", async () => {
    const { svc, updateMany } = make([0, 1, 0]);
    await svc.onApplicationBootstrap();
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { status: "RUNNING", phase: "PREPARING", agentReqId: null, OR: [{ ownerId: null }, { ownerId: { not: BOOT } }] },
      data: { status: "QUEUED", startedAt: null, ownerId: null, heartbeatAt: null, phase: null },
    });
    // the re-queue keeps the row's createdAt (FIFO place) and never writes a terminal shape
    const data = updateMany.mock.calls[1][0].data;
    expect(data).not.toHaveProperty("createdAt");
    expect(data).not.toHaveProperty("exitCode");
    expect(data).not.toHaveProperty("logs");
  });

  it("swarm resume: a journaled swarm command (DISPATCHED, agentReqId set) is released for ADOPTION, never re-queued — the command is not re-sent (no double-apply)", async () => {
    const { svc, updateMany } = make([1, 0, 0]);
    await svc.onApplicationBootstrap();
    expect(updateMany.mock.calls[0][0].data).toEqual({ ownerId: null, phase: "RECOVERING" });
    // the re-queue is scoped to rows WITHOUT a journaled command, so it can never grab an adoptable row
    expect(updateMany.mock.calls[1][0].where.agentReqId).toBeNull();
  });

  it("idempotent across repeated restarts: every statement is scoped to rows not owned by this boot, so a second boot re-running it matches nothing", async () => {
    const { svc, updateMany } = make();
    await svc.onApplicationBootstrap();
    await svc.onApplicationBootstrap();
    expect(updateMany).toHaveBeenCalledTimes(6);
    for (const call of updateMany.mock.calls) expect(JSON.stringify(call[0].where)).toContain(`{"ownerId":{"not":"${BOOT}"}}`);
  });

  it("does NOT cancel any QUEUED deploy, clustered or not — every statement targets RUNNING rows only", async () => {
    const { svc, updateMany } = make([1, 1, 1]);
    await svc.onApplicationBootstrap();
    for (const call of updateMany.mock.calls) expect(call[0].where.status).toBe("RUNNING");
    for (const call of updateMany.mock.calls) expect(call[0].data.status).not.toBe("CANCELLED");
  });

  it("the RUNNING reap never stamps a (misleading) durationMs for an interrupted run", async () => {
    const { svc, updateMany } = make();
    await svc.onApplicationBootstrap();
    expect(updateMany.mock.calls[2][0].data).not.toHaveProperty("durationMs");
  });

  it("is a no-op (no throw) when there is nothing to reap", async () => {
    const { svc } = make();
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
