import { InPlaceWorldService } from "./inplace-world.service";

function make() {
  const prisma = {
    server: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
    bulkOperation: { findUnique: jest.fn(async () => ({ id: "op1" })) },
    bulkTask: { findMany: jest.fn() },
    application: { findMany: jest.fn(), findUnique: jest.fn() },
    appServiceDomain: { findMany: jest.fn(async () => [{ hostname: "svc.example.com" }]) },
    coolifyTakeover: { count: jest.fn(async () => 0) },
    migrationRun: { count: jest.fn(async () => 0) },
    deployment: { create: jest.fn(async () => ({ id: "dep1" })), update: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn() },
  };
  const agentWs = { sendCommand: jest.fn(async () => ({ exitCode: 0, output: "ok" })) };
  const apps = { rollback: jest.fn(), deploy: jest.fn(), stop: jest.fn() };
  const proxyOps = { start: jest.fn(), status: jest.fn(async () => ({ status: "running" })) };
  const w = new InPlaceWorldService(prisma as never, agentWs as never, apps as never, proxyOps as never);
  return { w, prisma, agentWs, apps, proxyOps };
}

describe("InPlaceWorldService", () => {
  it("opApps keeps only the apps of this team that sit on this server, so another team's op contributes nothing", async () => {
    const { w, prisma } = make();
    prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "app:s:u1", resourceId: "a1", result: { containerPrefix: "pre" } },
      { itemRef: "app:s:u2", resourceId: "a2", result: null },
    ]);
    prisma.application.findMany.mockResolvedValue([{ id: "a1" }]);
    expect(await w.opApps("op1", "team1", "srv1")).toEqual([{ appId: "a1", itemRef: "app:s:u1", containerPrefix: "pre" }]);
    expect(prisma.application.findMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] }, teamId: "team1", serverId: "srv1" }, select: { id: true } });
  });
  it("opApps is null for an unknown op", async () => {
    const { w, prisma } = make();
    prisma.bulkOperation.findUnique.mockResolvedValueOnce(null as never);
    expect(await w.opApps("nope", "t", "s")).toBeNull();
  });
  it("app reads the hosts it serves (domain, extra domains, compose service hosts) and its declared volumes and mounts", async () => {
    const { w, prisma } = make();
    prisma.application.findUnique.mockResolvedValue({ id: "a1", teamId: "t", serverId: "s", name: "web", domain: "a.example.com", extraDomains: ["b.example.com"], volumes: [{ name: "data", path: "/data" }, { bad: 1 }], hostMounts: [{ hostPath: "/srv", containerPath: "/m" }] });
    expect(await w.app("a1")).toEqual({ id: "a1", teamId: "t", serverId: "s", name: "web", hosts: ["a.example.com", "b.example.com", "svc.example.com"], volumes: [{ name: "data", path: "/data" }], hostMounts: [{ hostPath: "/srv", containerPath: "/m" }] });
  });
  it("runs scripts through the agent's deploy capability and nothing else", async () => {
    const { w, agentWs } = make();
    await w.exec("srv1", "echo hi", 5000);
    expect(agentWs.sendCommand).toHaveBeenCalledWith("srv1", "echo hi", "deploy", 5000);
  });
  it("a server is busy while a takeover or a guided run holds it", async () => {
    const { w, prisma } = make();
    expect(await w.serverBusy("s")).toBe(false);
    prisma.coolifyTakeover.count.mockResolvedValueOnce(1);
    expect(await w.serverBusy("s")).toBe(true);
    prisma.migrationRun.count.mockResolvedValueOnce(1);
    expect(await w.serverBusy("s")).toBe(true);
  });
  it("the adopted deployment is a successful row with the tag the rollback path runs, and only takeover rows can be dropped", async () => {
    const { w, prisma } = make();
    expect(await w.createAdoptDeployment("app1", "abc1234")).toBe("dep1");
    expect(prisma.deployment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ appId: "app1", status: "SUCCESS", trigger: "takeover", commitSha: "abc1234" }) });
    expect(prisma.deployment.update).toHaveBeenCalledWith({ where: { id: "dep1" }, data: { imageTag: "tugra_app1:dep1" } });
    await w.dropAdoptDeployment("dep1");
    expect(prisma.deployment.deleteMany).toHaveBeenCalledWith({ where: { id: "dep1", trigger: "takeover" } });
  });
  it("runAdopted is ok only when the rollback succeeded", async () => {
    const { w, apps } = make();
    apps.rollback.mockResolvedValueOnce({ status: "SUCCESS" } as never).mockResolvedValueOnce({ status: "FAILED" } as never).mockResolvedValueOnce(null as never);
    expect(await w.runAdopted("u", "app1", "dep1")).toEqual({ ok: true });
    expect(await w.runAdopted("u", "app1", "dep1")).toEqual({ ok: false });
    expect(await w.runAdopted("u", "app1", "dep1")).toEqual({ ok: false });
    expect(apps.rollback).toHaveBeenCalledWith("u", "app1", "dep1");
  });
  it("deployState maps the row and treats an unknown status as failed", async () => {
    const { w, prisma } = make();
    prisma.deployment.findUnique.mockResolvedValueOnce({ status: "SUCCESS" } as never).mockResolvedValueOnce({ status: "CANCELLED" } as never).mockResolvedValueOnce(null as never);
    expect(await w.deployState("d")).toBe("SUCCESS");
    expect(await w.deployState("d")).toBe("FAILED");
    expect(await w.deployState("d")).toBe("unknown");
  });
});
