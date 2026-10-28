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
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: "RUNNING" },
      data: { status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE },
    });
  });

  it("only ever targets RUNNING rows — never touches SUCCESS/FAILED history", async () => {
    const { svc, updateMany } = make(0);
    await svc.onApplicationBootstrap();
    expect(updateMany.mock.calls[0][0].where).toEqual({ status: "RUNNING" });
    // never stamps a (misleading) durationMs for an interrupted run
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty("durationMs");
  });

  it("is a no-op (no throw) when there is nothing to reap", async () => {
    const { svc } = make(0);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
