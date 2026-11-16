import { Prisma } from "@prisma/client";
import { CutoverWorld } from "./cutover-world.service";
import type { CoolifyProxySnapshot } from "./proxy-swap";

const SNAP: CoolifyProxySnapshot = { containerId: "a".repeat(64), name: "coolify-proxy", image: "traefik:v3.1", restartPolicy: "always", running: true, ports: ["80>80/tcp", "443>443/tcp"] };

function make() {
  const swaps: Array<Record<string, unknown>> = [];
  const prisma = {
    bulkTask: { findMany: jest.fn() },
    application: { findMany: jest.fn(), count: jest.fn() },
    appServiceDomain: { findMany: jest.fn() },
    server: { findUnique: jest.fn(), update: jest.fn() },
    bulkOperation: { findUnique: jest.fn(), updateMany: jest.fn() },
    containerEvent: { count: jest.fn() },
    backup: { findMany: jest.fn() },
    migrationRunSwap: {
      findUnique: jest.fn(async ({ where }: { where: { runId_serverId: { runId: string; serverId: string } } }) => swaps.find((s) => s.runId === where.runId_serverId.runId && s.serverId === where.runId_serverId.serverId) ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `s${swaps.length + 1}`, liveAt: null, ...data };
        swaps.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { runId: string; serverId: string; state: { in: string[] } }; data: Record<string, unknown> }) => {
        const hit = swaps.filter((s) => s.runId === where.runId && s.serverId === where.serverId && where.state.in.includes(s.state as string));
        hit.forEach((s) => Object.assign(s, data));
        return { count: hit.length };
      }),
    },
  };
  const agentWs = { sendCommand: jest.fn(async () => ({ exitCode: 0, output: "ok" })) };
  const settings = { acmeEmailFor: jest.fn(), update: jest.fn() };
  const config = { get: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const world = new CutoverWorld(prisma as never, agentWs as never, settings as never, config as never, audit as never);
  return { world, prisma, agentWs, settings, config, audit, swaps };
}

describe("CutoverWorld", () => {
  it("opApps marks an app stateful when it depends on a database or a volume, whatever its data task says, and carries its hosts", async () => {
    const m = make();
    m.prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "app:_:1", resourceId: "a1", dependsOn: ["database:_:9"] },
      { itemRef: "app:_:2", resourceId: "a2", dependsOn: ["volume:_:3", "other:x"] },
      { itemRef: "app:_:3", resourceId: "a3", dependsOn: [] },
      { itemRef: "app:_:4", resourceId: "gone", dependsOn: [] },
    ]);
    m.prisma.application.findMany.mockResolvedValue([
      { id: "a1", domain: "A.example.com", extraDomains: ["x.example.com"], clusterId: null },
      { id: "a2", domain: null, extraDomains: [], clusterId: "cl1" },
      { id: "a3", domain: "c.example.com", extraDomains: [], clusterId: null },
    ]);
    m.prisma.appServiceDomain.findMany.mockResolvedValue([{ applicationId: "a1", hostname: "Svc.Example.com" }]);
    const apps = await m.world.opApps("op1");
    expect(apps.map((a) => [a.appId, a.hasData])).toEqual([["a1", true], ["a2", true], ["a3", false]]);
    expect(apps[0]).toMatchObject({ domain: "A.example.com", extraDomains: ["x.example.com"], serviceHosts: ["svc.example.com"] });
    expect(m.prisma.bulkTask.findMany).toHaveBeenCalledWith({ where: { opId: "op1", kind: "app", status: "DONE", resourceType: "application" }, select: { itemRef: true, resourceId: true, dependsOn: true } });
  });

  it("opContainerNames lists the run's app and database containers", async () => {
    const m = make();
    m.prisma.bulkTask.findMany.mockImplementation(async ({ where }: { where: { kind: string } }) => (where.kind === "app" ? [{ itemRef: "x", resourceId: "a1", dependsOn: [] }] : [{ resourceId: "d1" }]));
    m.prisma.application.findMany.mockResolvedValue([{ id: "a1", domain: null, extraDomains: [], clusterId: null }]);
    m.prisma.appServiceDomain.findMany.mockResolvedValue([]);
    expect(await m.world.opContainerNames("op1")).toEqual(["tugra_a1", "tugra_db_d1"]);
  });

  it("exec runs the script through the agent with the deploy capability", async () => {
    const m = make();
    await m.world.exec("srv1", "echo hi", 5000);
    expect(m.agentWs.sendCommand).toHaveBeenCalledWith("srv1", "echo hi", "deploy", 5000);
  });

  it("the swap row: create is idempotent (a second call or a lost race returns the existing row, never overwrites its snapshot)", async () => {
    const m = make();
    const a = await m.world.createSwap("run1", "srv1", SNAP, "none");
    expect(a).toMatchObject({ state: "PLANNED", tugraProxyBindBefore: "none", coolifyProxy: SNAP });
    const b = await m.world.createSwap("run1", "srv1", { ...SNAP, image: "other" }, "public");
    expect(b.coolifyProxy.image).toBe("traefik:v3.1");
    expect(m.prisma.migrationRunSwap.create).toHaveBeenCalledTimes(1);
    // a lost unique-race
    const m2 = make();
    m2.prisma.migrationRunSwap.findUnique.mockResolvedValueOnce(null);
    m2.prisma.migrationRunSwap.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }));
    m2.swaps.push({ id: "s0", runId: "run1", serverId: "srv1", state: "STOPPING_SOURCE_PROXY", coolifyProxy: SNAP, tugraProxyBindBefore: "none", liveAt: null });
    expect((await m2.world.createSwap("run1", "srv1", SNAP, "none")).state).toBe("STOPPING_SOURCE_PROXY");
  });

  it("setSwapState is a compare-and-set that stamps the milestones", async () => {
    const m = make();
    await m.world.createSwap("run1", "srv1", SNAP, "none");
    expect(await m.world.setSwapState("run1", "srv1", ["LIVE"], "REVERSING")).toBe(false); // not in `from`
    expect(await m.world.setSwapState("run1", "srv1", ["PLANNED"], "STOPPING_SOURCE_PROXY")).toBe(true);
    expect(await m.world.setSwapState("run1", "srv1", ["STOPPING_SOURCE_PROXY"], "STARTING_TARGET_PROXY")).toBe(true);
    expect(m.swaps[0].stoppedAt).toBeInstanceOf(Date);
    expect(await m.world.setSwapState("run1", "srv1", ["STARTING_TARGET_PROXY"], "LIVE")).toBe(true);
    const live = await m.world.getSwap("run1", "srv1");
    expect(live).toMatchObject({ state: "LIVE" });
    expect(live!.liveAt).toBeInstanceOf(Date);
    expect(await m.world.setSwapState("run1", "srv1", ["LIVE"], "REVERSING")).toBe(true);
    expect(await m.world.setSwapState("run1", "srv1", ["REVERSING"], "REVERSED")).toBe(true);
    expect(m.swaps[0].reversedAt).toBeInstanceOf(Date);
    expect(await m.world.getSwap("run1", "other")).toBeNull();
  });

  it("the migration token is revoked with the same single-row update as the token service, audited only when it took effect", async () => {
    const m = make();
    m.prisma.bulkOperation.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await m.world.revokeMigrationToken("op1", "user1")).toBe(true);
    expect(m.prisma.bulkOperation.updateMany).toHaveBeenCalledWith({ where: { id: "op1", migrationTokenHash: { not: null } }, data: { migrationTokenHash: null, migrationTokenExpiresAt: null } });
    expect(m.audit.log).toHaveBeenCalledWith({ actor: "user1", action: "import.migration_token.revoke", target: "op1", meta: { by: "migration-run" } });
    expect(await m.world.revokeMigrationToken("op1", "user1")).toBe(false);
    expect(m.audit.log).toHaveBeenCalledTimes(1);
    m.prisma.bulkOperation.findUnique.mockResolvedValueOnce({ migrationTokenHash: "h" }).mockResolvedValueOnce({ migrationTokenHash: null });
    expect(await m.world.migrationTokenActive("op1")).toBe(true);
    expect(await m.world.migrationTokenActive("op1")).toBe(false);
  });

  it("applyAcmeEmailIfMissing never overwrites an env or owner email", async () => {
    const m = make();
    m.settings.acmeEmailFor.mockResolvedValueOnce("owner@realco.io").mockResolvedValueOnce(undefined);
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io")).toBe(false);
    expect(m.settings.update).not.toHaveBeenCalled();
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io")).toBe(true);
    expect(m.settings.update).toHaveBeenCalledWith({ acmeEmail: "run@realco.io" });
    m.settings.acmeEmailFor.mockResolvedValueOnce(undefined);
    expect(await m.world.acmeEmailKnown()).toBe(false);
  });

  it("setProxyBind writes only the bind; otherLiveApps counts RUNNING apps outside the op", async () => {
    const m = make();
    await m.world.setProxyBind("srv1", "none");
    expect(m.prisma.server.update).toHaveBeenCalledWith({ where: { id: "srv1" }, data: { proxyBind: "none" } });
    m.prisma.application.count.mockResolvedValue(3);
    expect(await m.world.otherLiveApps("srv1", ["a1"])).toBe(3);
    expect(m.prisma.application.count).toHaveBeenCalledWith({ where: { serverId: "srv1", status: "RUNNING", id: { notIn: ["a1"] } } });
  });

  it("crash events are counted per server, container and time; nothing to ask without containers", async () => {
    const m = make();
    m.prisma.containerEvent.count.mockResolvedValue(2);
    const since = new Date();
    expect(await m.world.crashEventsSince("srv1", ["tugra_a1"], since)).toBe(2);
    expect(m.prisma.containerEvent.count).toHaveBeenCalledWith({ where: { serverId: "srv1", containerName: { in: ["tugra_a1"] }, ts: { gte: since } } });
    expect(await m.world.crashEventsSince("srv1", [], since)).toBe(0);
  });

  it("backupCoverage reports a database as covered only with a SUCCESS backup", async () => {
    const m = make();
    m.prisma.backup.findMany.mockResolvedValue([{ databaseId: "d1" }]);
    expect(await m.world.backupCoverage(["d1", "d2"])).toEqual([{ databaseId: "d1", hasSuccess: true }, { databaseId: "d2", hasSuccess: false }]);
    expect(m.prisma.backup.findMany).toHaveBeenCalledWith({ where: { databaseId: { in: ["d1", "d2"] }, status: "SUCCESS" }, select: { databaseId: true }, distinct: ["databaseId"] });
    expect(await m.world.backupCoverage([])).toEqual([]);
  });

  it("serverFacts returns null for an unknown server", async () => {
    const m = make();
    m.prisma.server.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s", name: "n", teamId: "t", publicIp: null, proxyBind: "public" });
    expect(await m.world.serverFacts("x")).toBeNull();
    expect(await m.world.serverFacts("s")).toEqual({ id: "s", name: "n", teamId: "t", publicIp: null, proxyBind: "public" });
  });
});
