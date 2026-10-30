import { DeploymentReconcileService, INTERRUPTED_DEPLOY_NOTE } from "./deployment-reconcile.service";

describe("DeploymentReconcileService", () => {
  function make(count: number) {
    const updateMany = jest.fn().mockResolvedValue({ count });
    const prisma = { deployment: { updateMany } } as never;
    return { svc: new DeploymentReconcileService(prisma), updateMany };
  }

  it("fails every deployment left RUNNING at boot so the 409 in-progress guard can no longer wedge the app", async () => {
    const { svc, updateMany } = make(2);
    await svc.onApplicationBootstrap();
    // two sweeps: RUNNING -> FAILED, then QUEUED -> CANCELLED
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { status: "RUNNING" },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE },
    });
  });

  it("drops QUEUED deploys left by the restart (agents aren't connected yet to drain them)", async () => {
    const { svc, updateMany } = make(1);
    await svc.onApplicationBootstrap();
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { status: "QUEUED" },
      data: { status: "CANCELLED", exitCode: -1, logs: expect.stringContaining("hub restarted") },
    });
  });

  it("only ever targets RUNNING then QUEUED rows — never touches SUCCESS/FAILED history", async () => {
    const { svc, updateMany } = make(0);
    await svc.onApplicationBootstrap();
    expect(updateMany.mock.calls[0][0].where).toEqual({ status: "RUNNING" });
    expect(updateMany.mock.calls[1][0].where).toEqual({ status: "QUEUED" });
    // never stamps a (misleading) durationMs for an interrupted run
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty("durationMs");
  });

  it("is a no-op (no throw) when there is nothing to reap", async () => {
    const { svc } = make(0);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
