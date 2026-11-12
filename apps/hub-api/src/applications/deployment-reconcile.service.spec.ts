import { DeploymentReconcileService, INTERRUPTED_DEPLOY_NOTE, CLUSTERED_QUEUED_DROP_NOTE } from "./deployment-reconcile.service";

describe("DeploymentReconcileService", () => {
  function make(count: number) {
    const updateMany = jest.fn().mockResolvedValue({ count });
    const prisma = { deployment: { updateMany } } as never;
    return { svc: new DeploymentReconcileService(prisma), updateMany };
  }

  it("fails every deployment left RUNNING at boot so the 409 in-progress guard can no longer wedge the app", async () => {
    const { svc, updateMany } = make(2);
    await svc.onApplicationBootstrap();
    // Two sweeps: (1) RUNNING -> FAILED, (2) CLUSTERED QUEUED -> CANCELLED. The RUNNING reap is first + exact.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { status: "RUNNING" },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE },
    });
  });

  it("cancels CLUSTERED QUEUED deploys at boot (swarm resume deferred) but LEAVES non-clustered QUEUED intact", async () => {
    const { svc, updateMany } = make(1);
    await svc.onApplicationBootstrap();
    // the QUEUED cancel is scoped to clustered apps only — a swarm deploy targets the dynamically-resolved
    // manager, not Application.serverId, so it can't ride the per-server reconnect gate (resume is deferred).
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { status: "QUEUED", application: { clusterId: { not: null } } },
      data: { status: "CANCELLED", exitCode: -1, logs: CLUSTERED_QUEUED_DROP_NOTE },
    });
    // CRUCIAL: a blanket status:QUEUED cancel (which would also drop single-server rows meant to re-drive on
    // reconnect) is NEVER issued — every QUEUED mutation must carry the clustered filter.
    for (const call of updateMany.mock.calls) {
      if (call[0].where.status === "QUEUED") {
        expect(call[0].where.application).toEqual({ clusterId: { not: null } });
      }
    }
  });

  it("the RUNNING reap never stamps a (misleading) durationMs for an interrupted run", async () => {
    const { svc, updateMany } = make(0);
    await svc.onApplicationBootstrap();
    expect(updateMany.mock.calls[0][0].where).toEqual({ status: "RUNNING" });
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty("durationMs");
  });

  it("is a no-op (no throw) when there is nothing to reap", async () => {
    const { svc } = make(0);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
