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
  const apps = { rollback: jest.fn(), deploy: jest.fn(), stop: jest.fn(), setSource: jest.fn(async () => ({ warnings: [] })), setComposeFile: jest.fn(async () => undefined) };
  const proxyOps = { start: jest.fn(), status: jest.fn(async () => ({ status: "running" })) };
  const databases = { provision: jest.fn(async () => ({ status: "RUNNING" })), stop: jest.fn(async () => undefined), setImage: jest.fn(async () => ({ changed: true })) };
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
  describe("pinExact: the record keeps the exact image the Coolify container runs", () => {
    const D1 = `sha256:${"1".repeat(64)}`;
    it("an IMAGE app takes repo:tag@digest of the image the container runs; a host that reported nothing changes nothing", async () => {
      const { w, prisma, apps } = make();
      prisma.application.findUnique.mockResolvedValue({ source: "IMAGE", image: "ghcr.io/x/web:latest" });
      expect(await w.pinExact("u1", { kind: "app", id: "a1", image: "ghcr.io/x/web:latest", repoDigests: [`ghcr.io/x/web@${D1}`] })).toBe(true);
      expect(apps.setSource).toHaveBeenCalledWith("u1", "a1", { image: `ghcr.io/x/web:latest@${D1}` });
      expect(await w.pinExact("u1", { kind: "app", id: "a1", image: "ghcr.io/x/web:latest" })).toBe(false);
      expect(apps.setSource).toHaveBeenCalledTimes(1);
    });
    it("a database that was never started takes the tag the source container runs, pinned to its digest; a started one never changes", async () => {
      const { w, prisma, databases } = make();
      prisma.database.findUnique.mockResolvedValueOnce({ image: "postgres:16", status: "NEW" });
      expect(await w.pinExact("u1", { kind: "database", id: "d1", image: "postgres:16-alpine", repoDigests: [`postgres@${D1}`] })).toBe(true);
      expect(databases.setImage).toHaveBeenCalledWith("u1", "d1", `postgres:16-alpine@${D1}`);
      prisma.database.findUnique.mockResolvedValueOnce({ image: "postgres:16", status: "STOPPED" });
      expect(await w.pinExact("u1", { kind: "database", id: "d1", image: "postgres:16-alpine", repoDigests: [`postgres@${D1}`] })).toBe(false);
      expect(databases.setImage).toHaveBeenCalledTimes(1);
    });
    it("a stack's stored compose gets each member's exact image; a member with no digest keeps what it has", async () => {
      const { w, prisma, apps } = make();
      prisma.application.findUnique.mockResolvedValue({ source: "COMPOSE", composeFile: "services:\n  db:\n    image: postgres:16\n  web:\n    image: nginx:1.27\n" });
      expect(await w.pinExact("u1", { kind: "service", id: "s1", members: [{ service: "db", image: "postgres:16", repoDigests: [`postgres@${D1}`] }, { service: "web", image: "nginx:1.27" }] })).toBe(true);
      const written = (apps.setComposeFile.mock.calls[0] as unknown as [string, string, string])[2];
      expect(written).toContain(`image: postgres:16@${D1}`);
      expect(written).toContain("image: nginx:1.27\n");
    });
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

  it("opServices keeps only the compose services of this team that sit on this server, from the op's service tasks", async () => {
    const { w, prisma } = make();
    prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "service:s:u1", resourceId: "a1" },
      { itemRef: "service:s:u2", resourceId: "a2" },
      { itemRef: "service:s:u3", resourceId: null },
    ]);
    prisma.application.findMany.mockResolvedValue([{ id: "a1" }]);
    expect(await w.opServices("op1", "team1", "srv1")).toEqual([{ appId: "a1", itemRef: "service:s:u1" }]);
    expect(prisma.bulkTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ kind: "service", resourceType: "application", status: "DONE" }) }));
    expect(prisma.application.findMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] }, teamId: "team1", serverId: "srv1" }, select: { id: true } });
    prisma.bulkOperation.findUnique.mockResolvedValueOnce(null as never);
    expect(await w.opServices("nope", "t", "s")).toBeNull();
  });
  it("opApps and opServices never mix: apps are the op's app tasks, services its service tasks", async () => {
    const { w, prisma } = make();
    prisma.bulkTask.findMany.mockResolvedValue([]);
    prisma.application.findMany.mockResolvedValue([]);
    await w.opApps("op1", "t", "s");
    await w.opServices("op1", "t", "s");
    const kinds = prisma.bulkTask.findMany.mock.calls.map((c) => (c[0] as { where: { kind: string } }).where.kind);
    expect(kinds).toEqual(["app", "service"]);
  });
  it("service reads the compose project, the stored compose, its volumes, its network attachments, and whether the takeover can drive it", async () => {
    const { w, prisma } = make();
    prisma.application.findUnique
      .mockResolvedValueOnce({ id: "a1", teamId: "t", serverId: "s", name: "blog", domain: null, extraDomains: [], volumes: [], hostMounts: [] } as never)
      .mockResolvedValueOnce({
        source: "COMPOSE",
        composeFile: "services:\n  web:\n    image: x\n    volumes:\n      - data:/d\nvolumes:\n  data: {}\n",
        composePath: null,
        gitUrl: null,
        composeAdopt: null,
        clusterId: null,
        composeNetworks: [{ network: "n", service: "web", aliases: ["w", 3] }, { bad: 1 }],
      } as never);
    expect(await w.service("a1")).toEqual({
      id: "a1",
      teamId: "t",
      serverId: "s",
      name: "blog",
      hosts: ["svc.example.com"],
      volumes: [],
      hostMounts: [],
      project: "tugra_a1",
      composeFile: expect.stringContaining("services:"),
      composeVolumes: [{ key: "data", dockerName: "tugra_a1_data", external: false }],
      networks: [{ network: "n", service: "web", aliases: ["w"] }],
      usable: true,
    });
  });
  it("a git compose, an adopted project, a clustered app and a non-compose app are not usable", async () => {
    const { w, prisma } = make();
    const base = { id: "a1", teamId: "t", serverId: "s", name: "blog", domain: null, extraDomains: [], volumes: [], hostMounts: [] };
    const compose = { source: "COMPOSE", composeFile: "services:\n  web:\n    image: x\n", composePath: null, gitUrl: null, composeAdopt: null, clusterId: null, composeNetworks: null };
    for (const over of [{ composePath: "docker-compose.yml" }, { gitUrl: "https://x/y.git" }, { composeAdopt: { v: 1 } }, { clusterId: "c1" }, { source: "IMAGE" }, { composeFile: null }]) {
      prisma.application.findUnique.mockResolvedValueOnce(base as never).mockResolvedValueOnce({ ...compose, ...over } as never);
      expect((await w.service("a1"))!.usable).toBe(false);
    }
    prisma.application.findUnique.mockResolvedValueOnce(null as never);
    expect(await w.service("ghost")).toBeNull();
  });
  it("the adopted compose deployment is a successful row that carries the stored compose file, so the rollback path can run the stack", async () => {
    const { w, prisma } = make();
    prisma.application.findUnique.mockResolvedValueOnce({ composeFile: "services:\n  web:\n    image: x\n" } as never);
    expect(await w.createAdoptComposeDeployment("a1")).toBe("dep1");
    expect(prisma.deployment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ appId: "a1", status: "SUCCESS", trigger: "takeover", configSnapshot: { snapV: 2, source: "COMPOSE", composeFile: "services:\n  web:\n    image: x\n" } }),
    });
    prisma.application.findUnique.mockResolvedValueOnce({ composeFile: null } as never);
    await expect(w.createAdoptComposeDeployment("a1")).rejects.toThrow("no stored compose file");
  });
  it("network attachments go through the apps service, which re-checks the owner's rights", async () => {
    const { w, apps } = make();
    (apps as unknown as { setComposeNetworks: jest.Mock }).setComposeNetworks = jest.fn(async () => undefined);
    await w.setComposeNetworks("u", "a1", [{ network: "n", service: "web", aliases: [] }]);
    expect((apps as unknown as { setComposeNetworks: jest.Mock }).setComposeNetworks).toHaveBeenCalledWith("u", "a1", [{ network: "n", service: "web", aliases: [] }]);
  });
});
