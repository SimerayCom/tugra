import { InPlaceWorldService } from "./inplace-world.service";

function make() {
  const prisma = {
    server: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
    bulkOperation: { findUnique: jest.fn(async () => ({ id: "op1" })) },
    bulkTask: { findMany: jest.fn() },
    application: { findMany: jest.fn(), findUnique: jest.fn() },
    database: { findMany: jest.fn(), findUnique: jest.fn() },
    appServiceDomain: { findMany: jest.fn(async () => [{ hostname: "svc.example.com" }]) },
    coolifyTakeover: { count: jest.fn(async () => 0) },
    migrationRun: { count: jest.fn(async () => 0) },
    deployment: { create: jest.fn(async () => ({ id: "dep1" })), update: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn() },
  };
  const agentWs = { sendCommand: jest.fn(async () => ({ exitCode: 0, output: "ok" })) };
  const apps = { rollback: jest.fn(), deploy: jest.fn(), stop: jest.fn() };
  const proxyOps = { start: jest.fn(), status: jest.fn(async () => ({ status: "running" })) };
  const databases = { provision: jest.fn(async () => ({ status: "RUNNING" })), stop: jest.fn(async () => undefined) };
  const crypto = { decrypt: jest.fn((s: string) => s) };
  const w = new InPlaceWorldService(prisma as never, agentWs as never, apps as never, proxyOps as never, databases as never, crypto as never);
  return { w, prisma, agentWs, apps, proxyOps, databases, crypto };
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
  it("the guided run that carries the takeover is not 'another' holder of the server, in either table (rows with no run still count)", async () => {
    const { w, prisma } = make();
    await w.serverBusy("s", "run1");
    expect(prisma.migrationRun.count).toHaveBeenLastCalledWith({ where: expect.objectContaining({ targetServerId: "s", id: { not: "run1" } }) });
    expect(prisma.coolifyTakeover.count).toHaveBeenLastCalledWith({ where: expect.objectContaining({ serverId: "s", OR: [{ runId: null }, { runId: { not: "run1" } }] }) });
    await w.serverBusy("s");
    expect(prisma.migrationRun.count).toHaveBeenLastCalledWith({ where: expect.not.objectContaining({ id: expect.anything() }) });
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

  it("opDatabases keeps only the databases of this team that sit on this server", async () => {
    const { w, prisma } = make();
    prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "database:s:u1", resourceId: "d1" },
      { itemRef: "database:s:u2", resourceId: "d2" },
    ]);
    prisma.database.findMany.mockResolvedValue([{ id: "d1" }]);
    expect(await w.opDatabases("op1", "team1", "srv1")).toEqual([{ databaseId: "d1", itemRef: "database:s:u1" }]);
    expect(prisma.database.findMany).toHaveBeenCalledWith({ where: { id: { in: ["d1", "d2"] }, teamId: "team1", serverId: "srv1" }, select: { id: true } });
    expect(prisma.bulkTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ kind: "database", resourceType: "database", status: "DONE" }) }));
  });
  it("database reads the engine, the image Tugra runs it on, the data mount and the declared extra volumes", async () => {
    const { w, prisma } = make();
    prisma.database.findUnique.mockResolvedValue({ id: "d1", teamId: "t", serverId: "s", name: "main", engine: "POSTGRES", version: "16", image: null, pgParentMount: false, volumes: [{ name: "ext", path: "/ext" }, { bad: 1 }] });
    expect(await w.database("d1")).toEqual({ id: "d1", teamId: "t", serverId: "s", name: "main", engine: "POSTGRES", image: "postgres:16", dataMount: "/var/lib/postgresql/data", volumes: [{ name: "ext", path: "/ext" }] });
  });
  it("a database is started and stopped through the database service, and only a RUNNING provision is ok", async () => {
    const { w, databases, prisma, agentWs } = make();
    prisma.database.findUnique.mockResolvedValue({ serverId: "srv1" });
    agentWs.sendCommand.mockResolvedValue({ exitCode: 0, output: "false\n" });
    expect(await w.runDatabase("u", "d1")).toEqual({ ok: true });
    databases.provision.mockResolvedValueOnce({ status: "FAILED" });
    expect(await w.runDatabase("u", "d1")).toEqual({ ok: false });
    await w.stopDatabase("u", "d1");
    expect(databases.stop).toHaveBeenCalledWith("u", "d1");
  });
  it("stopping Tugra's database is proven: a container that still runs (the service swallows a failed stop) fails it, so the give-back never goes on", async () => {
    const { w, prisma, agentWs } = make();
    prisma.database.findUnique.mockResolvedValue({ serverId: "srv1" });
    agentWs.sendCommand.mockResolvedValueOnce({ exitCode: 0, output: "absent" });
    await expect(w.stopDatabase("u", "d1")).resolves.toBeUndefined();
    agentWs.sendCommand.mockResolvedValueOnce({ exitCode: 0, output: "true" });
    await expect(w.stopDatabase("u", "d1")).rejects.toThrow("database still running");
    agentWs.sendCommand.mockResolvedValueOnce({ exitCode: 0, output: "" });
    await expect(w.stopDatabase("u", "d1")).rejects.toThrow("database still running");
    expect(agentWs.sendCommand).toHaveBeenLastCalledWith("srv1", expect.stringContaining("tugra_db_d1"), "deploy", expect.any(Number));
  });
  it("appMentions searches the decrypted environment for the names and returns nothing of it; an unreadable environment is null", async () => {
    const { w, prisma, crypto } = make();
    prisma.application.findUnique.mockResolvedValue({ env: null, envEnc: "enc" });
    crypto.decrypt.mockReturnValue(JSON.stringify({ DATABASE_URL: "postgres://u:pw-canary@tugra_db_d1:5432/x", OTHER: "x" }));
    expect(await w.appMentions("a1", ["tugra_db_d1"])).toBe(true);
    expect(await w.appMentions("a1", ["tugra_db_d9"])).toBe(false);
    crypto.decrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    expect(await w.appMentions("a1", ["tugra_db_d1"])).toBeNull();
    prisma.application.findUnique.mockResolvedValue(null);
    expect(await w.appMentions("a1", ["x"])).toBeNull();
  });
});
