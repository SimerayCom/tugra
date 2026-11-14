import { DeployLeaseService } from "./deploy-lease.service";

describe("DeployLeaseService", () => {
  it("has a per-process bootId (different every construction) and heartbeats only the RUNNING rows it owns", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const a = new DeployLeaseService({ deployment: { updateMany } } as never);
    const b = new DeployLeaseService({ deployment: { updateMany } } as never);
    expect(a.bootId).not.toBe(b.bootId);
    expect(a.bootId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(a.beat()).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledWith({ where: { status: "RUNNING", ownerId: a.bootId }, data: { heartbeatAt: expect.any(Date) } });
  });
  it("a heartbeat failure is swallowed (never crashes the process) and does not start a timer under NODE_ENV=test", async () => {
    const svc = new DeployLeaseService({ deployment: { updateMany: jest.fn().mockRejectedValue(new Error("db down")) } } as never);
    await expect(svc.beat()).resolves.toBe(0);
    svc.onApplicationBootstrap();
    expect((svc as unknown as { timer?: unknown }).timer).toBeUndefined();
    svc.onModuleDestroy();
  });
});
