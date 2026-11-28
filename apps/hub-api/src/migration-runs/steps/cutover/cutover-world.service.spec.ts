import { unwrapHostScript } from "../../../common/host-exec";
import { Prisma } from "@prisma/client";
import { CutoverWorld, isMinioResult, sanitizeRepo } from "./cutover-world.service";
import type { CoolifyProxySnapshot } from "./proxy-swap";

const SNAP: CoolifyProxySnapshot = { containerId: "a".repeat(64), name: "coolify-proxy", image: "traefik:v3.1", restartPolicy: "always", running: true, ports: ["80>80/tcp", "443>443/tcp"] };

function make() {
  const swaps: Array<Record<string, unknown>> = [];
  const prisma = {
    bulkTask: { findMany: jest.fn() },
    objectMigration: { findMany: jest.fn() },
    objectMigrationBucket: { findMany: jest.fn() },
    application: { findMany: jest.fn(), count: jest.fn() },
    appServiceDomain: { findMany: jest.fn() },
    gitSource: { findMany: jest.fn().mockResolvedValue([]) },
    server: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    bulkOperation: { findUnique: jest.fn(), updateMany: jest.fn() },
    containerEvent: { count: jest.fn() },
    backup: { findMany: jest.fn() },
    migrationRun: { findMany: jest.fn() },
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
  const crypto = { decrypt: jest.fn((t: string) => t.replace(/^enc:/, "")) };
  const world = new CutoverWorld(prisma as never, agentWs as never, settings as never, config as never, audit as never, crypto as never);
  return { world, prisma, agentWs, settings, config, audit, swaps, crypto };
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
    // compose services are applications too
    expect(m.prisma.bulkTask.findMany).toHaveBeenCalledWith({ where: { opId: "op1", kind: { in: ["app", "service"] }, status: "DONE", resourceType: "application" }, select: { itemRef: true, kind: true, resourceId: true, dependsOn: true, result: true } });
  });

  it("opApps carries compose services (kind, server, status, MinIO member) and counts a service with data volumes as stateful", async () => {
    const m = make();
    m.prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "service:_:s1", kind: "service", resourceId: "a1", dependsOn: [], result: { kind: "service", members: ["minio"], volumes: [{ key: "data", policy: "copy" }] } },
      { itemRef: "service:_:s2", kind: "service", resourceId: "a2", dependsOn: [], result: { kind: "service", members: ["gotenberg"], volumes: [{ key: "tmp", policy: "skip" }] } },
      { itemRef: "app:_:1", kind: "app", resourceId: "a3", dependsOn: [], result: {} },
    ]);
    m.prisma.application.findMany.mockResolvedValue([
      { id: "a1", domain: null, extraDomains: [], clusterId: null, serverId: "srv-a", status: "STOPPED" },
      { id: "a2", domain: null, extraDomains: [], clusterId: null, serverId: "srv-b", status: "RUNNING" },
      { id: "a3", domain: "x.example.test", extraDomains: [], clusterId: null, serverId: "srv-b", status: "RUNNING" },
    ]);
    m.prisma.appServiceDomain.findMany.mockResolvedValue([{ applicationId: "a1", hostname: "S3.Example.test" }]);
    const apps = await m.world.opApps("op1");
    expect(apps.map((a) => [a.appId, a.kind, a.serverId, a.status, a.hasData, a.objectStore])).toEqual([
      ["a1", "service", "srv-a", "STOPPED", true, true],
      ["a2", "service", "srv-b", "RUNNING", false, false],
      ["a3", "app", "srv-b", "RUNNING", false, false],
    ]);
    expect(apps[0].serviceHosts).toEqual(["s3.example.test"]);
  });

  it("appObjectKeys returns only the env NAMES that point at an object store, from the encrypted env or the plain one, and never a value", async () => {
    const m = make();
    m.prisma.application.findMany.mockResolvedValue([
      { id: "a1", env: {}, envEnc: `enc:${JSON.stringify({ S3_ENDPOINT: "https://secret.example.test", DATABASE_URL: "postgres://u:p@h/db", MINIO_ROOT_PASSWORD: "x" })}` },
      { id: "a2", env: { PORT: "80" }, envEnc: null },
      { id: "a3", env: {}, envEnc: "enc:{not json" },
    ]);
    const out = await m.world.appObjectKeys(["a1", "a2", "a3"]);
    expect([...out]).toEqual([["a1", ["MINIO_ROOT_PASSWORD", "S3_ENDPOINT"]]]);
    expect(JSON.stringify([...out])).not.toContain("secret.example.test");
    expect(m.prisma.application.findMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2", "a3"] } }, select: { id: true, env: true, envEnc: true } });
  });

  it("appObjectKeys is empty without a crypto service or without apps (no names are invented)", async () => {
    const m = make();
    expect((await m.world.appObjectKeys([])).size).toBe(0);
    const bare = new CutoverWorld(m.prisma as never, m.agentWs as never, m.settings as never, m.config as never, m.audit as never);
    expect((await bare.appObjectKeys(["a1"])).size).toBe(0);
    expect(m.prisma.application.findMany).not.toHaveBeenCalled();
  });

  it("objectsVerification counts the selected buckets of the run's team migrations only", async () => {
    const m = make();
    expect(await m.world.objectsVerification("team1", [])).toBeNull();
    m.prisma.objectMigration.findMany.mockResolvedValue([{ id: "o1" }]);
    m.prisma.objectMigrationBucket.findMany.mockResolvedValue([{ status: "VERIFIED" }, { status: "VERIFIED" }, { status: "DIFFERS" }, { status: "SEEDED" }]);
    expect(await m.world.objectsVerification("team1", ["o1", "o9"])).toEqual({ attached: 1, selectedBuckets: 4, verified: 2, problems: 1 });
    expect(m.prisma.objectMigration.findMany).toHaveBeenCalledWith({ where: { id: { in: ["o1", "o9"] }, teamId: "team1" }, select: { id: true } });
    expect(m.prisma.objectMigrationBucket.findMany).toHaveBeenCalledWith({ where: { migrationId: { in: ["o1"] }, selected: true }, select: { status: true } });
    m.prisma.objectMigration.findMany.mockResolvedValue([]);
    expect(await m.world.objectsVerification("team1", ["other-team"])).toEqual({ attached: 0, selectedBuckets: 0, verified: 0, problems: 0 });
  });

  it("gitWebhookApps tells a GitHub-App source (shared webhook) from a per-app deploy webhook and never echoes a credential", async () => {
    const m = make();
    m.prisma.application.findMany.mockResolvedValue([
      { id: "a1", name: "web", gitUrl: "https://x-access-token:abc123@github.com/acme/web.git", gitSourceId: "src1", autoDeploy: true },
      { id: "a2", name: "api", gitUrl: "git@github.com:acme/api.git", gitSourceId: null, autoDeploy: false },
      { id: "a3", name: "odd", gitUrl: "not a url", gitSourceId: null, autoDeploy: true },
    ]);
    m.prisma.gitSource.findMany.mockResolvedValue([{ id: "src1", provider: "github", webhookSecretEnc: "enc:whsec" }]);
    const out = await m.world.gitWebhookApps(["a1", "a2", "a3"]);
    expect(JSON.stringify(m.prisma.gitSource.findMany.mock.calls)).toContain("webhookSecretEnc");
    expect(out).toEqual([
      { appId: "a1", name: "web", kind: "github-app", repo: "github.com/acme/web", sourceId: "src1", autoDeploy: true },
      { appId: "a2", name: "api", kind: "deploy-token", repo: "github.com/acme/api", sourceId: null, autoDeploy: false },
      { appId: "a3", name: "odd", kind: "deploy-token", repo: null, sourceId: null, autoDeploy: true },
    ]);
    expect(JSON.stringify(out)).not.toContain("abc123");
    expect(await m.world.gitWebhookApps([])).toEqual([]);
  });

  it("gitWebhookApps gives an app on a token provider (or a source without a webhook secret) the per-app deploy webhook, never the shared GitHub endpoint", async () => {
    const m = make();
    m.prisma.application.findMany.mockResolvedValue([
      { id: "a1", name: "gh", gitUrl: "https://github.com/acme/gh.git", gitSourceId: "src-gh", autoDeploy: true },
      { id: "a2", name: "gt", gitUrl: "https://git.example.test/acme/gt.git", gitSourceId: "src-gitea", autoDeploy: true },
      { id: "a3", name: "cb", gitUrl: "https://codeberg.org/acme/cb.git", gitSourceId: "src-cb", autoDeploy: false },
      { id: "a4", name: "nosecret", gitUrl: "https://github.com/acme/ns.git", gitSourceId: "src-ns", autoDeploy: true },
      { id: "a5", name: "gone", gitUrl: "https://github.com/acme/gone.git", gitSourceId: "src-missing", autoDeploy: true },
    ]);
    m.prisma.gitSource.findMany.mockResolvedValue([
      { id: "src-gh", provider: "github", webhookSecretEnc: "enc:x" },
      { id: "src-gitea", provider: "gitea", webhookSecretEnc: null },
      { id: "src-cb", provider: "codeberg", webhookSecretEnc: "enc:y" },
      { id: "src-ns", provider: "github", webhookSecretEnc: null },
    ]);
    const out = await m.world.gitWebhookApps(["a1", "a2", "a3", "a4", "a5"]);
    expect(out.map((w) => [w.name, w.kind, w.sourceId])).toEqual([["gh", "github-app", "src-gh"], ["gt", "deploy-token", null], ["cb", "deploy-token", null], ["nosecret", "deploy-token", null], ["gone", "deploy-token", null]]);
  });

  it("appObjectEnv names the apps whose env could not be read instead of reading them as having no keys", async () => {
    const m = make();
    m.prisma.application.findMany.mockResolvedValue([
      { id: "a1", env: {}, envEnc: `enc:${JSON.stringify({ S3_BUCKET: "x" })}` },
      { id: "a2", env: { PORT: "80" }, envEnc: null },
      { id: "a3", env: {}, envEnc: "enc:{not json" },
      { id: "a4", env: {}, envEnc: "enc:[1,2]" },
    ]);
    const out = await m.world.appObjectEnv(["a1", "a2", "a3", "a4"]);
    expect([...out.keys]).toEqual([["a1", ["S3_BUCKET"]]]);
    expect(out.unreadable).toEqual(["a3", "a4"]);
    m.crypto.decrypt.mockImplementationOnce(() => {
      throw new Error("bad key");
    });
    m.prisma.application.findMany.mockResolvedValue([{ id: "a9", env: {}, envEnc: "enc:{}" }]);
    expect((await m.world.appObjectEnv(["a9"])).unreadable).toEqual(["a9"]);
  });

  it("without a crypto service every app's env reads as unreadable (the dependency is unknown, never absent)", async () => {
    const m = make();
    const bare = new CutoverWorld(m.prisma as never, m.agentWs as never, m.settings as never, m.config as never, m.audit as never);
    expect(await bare.appObjectEnv(["a1", "a2"])).toEqual({ keys: new Map(), unreadable: ["a1", "a2"] });
    expect(await bare.appObjectEnv([])).toEqual({ keys: new Map(), unreadable: [] });
  });

  it("hubPublicUrl is the configured https/http base without a trailing slash, else null", () => {
    const m = make();
    m.config.get.mockReturnValue("https://hub.example.test/");
    expect(m.world.hubPublicUrl()).toBe("https://hub.example.test");
    m.config.get.mockReturnValue("hub.example.test");
    expect(m.world.hubPublicUrl()).toBeNull();
    m.config.get.mockReturnValue(undefined);
    expect(m.world.hubPublicUrl()).toBeNull();
  });

  it("opContainerNames lists the run's app and database containers", async () => {
    const m = make();
    m.prisma.bulkTask.findMany.mockImplementation(async ({ where }: { where: { kind: string | { in: string[] } } }) => (typeof where.kind === "object" ? [{ itemRef: "x", resourceId: "a1", dependsOn: [] }] : [{ resourceId: "d1" }]));
    m.prisma.application.findMany.mockResolvedValue([{ id: "a1", domain: null, extraDomains: [], clusterId: null }]);
    m.prisma.appServiceDomain.findMany.mockResolvedValue([]);
    expect(await m.world.opContainerNames("op1")).toEqual(["tugra_a1", "tugra_db_d1"]);
  });

  it("exec runs the script through the agent with the deploy capability", async () => {
    const m = make();
    await m.world.exec("srv1", "echo hi", 5000);
    expect(m.agentWs.sendCommand).toHaveBeenCalledWith("srv1", "echo hi", "deploy", 5000);
  });

  it("the host-context flags wrap the script (host network / host namespaces); no flag sends it as it is", async () => {
    const m = make();
    await m.world.exec("srv1", "echo hi", 5000, { hostNetwork: true });
    await m.world.exec("srv1", "echo hi", 5000, { hostNamespaces: true });
    const [net, ns] = m.agentWs.sendCommand.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(net).toContain("--network host");
    expect(unwrapHostScript(net)).toBe("echo hi");
    expect(ns).toContain("nsenter -t 1 -m");
    expect(unwrapHostScript(ns)).toBe("echo hi");
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
    m.prisma.user.findUnique.mockResolvedValue({ isInstanceOwner: true });
    m.settings.acmeEmailFor.mockResolvedValueOnce("owner@realco.io").mockResolvedValueOnce(undefined);
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io", "u1")).toBe(false);
    expect(m.settings.update).not.toHaveBeenCalled();
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io", "u1")).toBe(true);
    expect(m.settings.update).toHaveBeenCalledWith({ acmeEmail: "run@realco.io" });
    m.settings.acmeEmailFor.mockResolvedValueOnce(undefined);
    expect(await m.world.acmeEmailKnown()).toBe(false);
  });

  it("the instance-wide ACME email is written only for the instance owner, and the write is audited like PATCH /instance/settings", async () => {
    const m = make();
    m.settings.acmeEmailFor.mockResolvedValue(undefined);
    m.prisma.user.findUnique.mockResolvedValueOnce({ isInstanceOwner: false });
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io", "member")).toBe(false);
    m.prisma.user.findUnique.mockResolvedValueOnce(null);
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io", "ghost")).toBe(false);
    expect(m.settings.update).not.toHaveBeenCalled();
    expect(m.audit.log).not.toHaveBeenCalled();
    m.prisma.user.findUnique.mockResolvedValueOnce({ isInstanceOwner: true });
    expect(await m.world.applyAcmeEmailIfMissing("run@realco.io", "owner1")).toBe(true);
    expect(m.settings.update).toHaveBeenCalledWith({ acmeEmail: "run@realco.io" });
    expect(m.audit.log).toHaveBeenCalledWith({ actor: "owner1", action: "instance_settings.update", target: "singleton", meta: { by: "migration-run", fields: ["acmeEmail"] } });
    expect(m.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "owner1" }, select: { isInstanceOwner: true } });
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
    // a compose app runs as `tugra_<appId>-<service>-<n>`: each name matches itself and its services
    expect(m.prisma.containerEvent.count).toHaveBeenCalledWith({ where: { serverId: "srv1", ts: { gte: since }, OR: [{ containerName: { in: ["tugra_a1"] } }, { containerName: { startsWith: "tugra_a1-" } }] } });
    expect(await m.world.crashEventsSince("srv1", [], since)).toBe(0);
  });

  it("backupCoverage reports a database as covered only with a SUCCESS backup", async () => {
    const m = make();
    m.prisma.backup.findMany.mockResolvedValue([{ databaseId: "d1" }]);
    expect(await m.world.backupCoverage(["d1", "d2"])).toEqual([{ databaseId: "d1", hasSuccess: true }, { databaseId: "d2", hasSuccess: false }]);
    expect(m.prisma.backup.findMany).toHaveBeenCalledWith({ where: { databaseId: { in: ["d1", "d2"] }, status: "SUCCESS" }, select: { databaseId: true }, distinct: ["databaseId"] });
    expect(await m.world.backupCoverage([])).toEqual([]);
  });

  it("siblingRuns counts the other real runs of the same source: unsettled ones as live, finished takeovers that never stopped their hosts as undecommissioned", async () => {
    const m = make();
    const same = { sourceHost: "coolify.example.test", serverMap: null, sourceBaseline: null };
    m.prisma.migrationRun.findMany.mockResolvedValue([
      { ...same, status: "RUNNING", mode: "copy", steps: [] },
      { ...same, status: "FAILED", mode: "takeover", steps: [] }, // a retry resumes it
      { ...same, status: "COMPLETED", mode: "copy", steps: [] }, // finished, nothing to stop
      { ...same, status: "COMPLETED", mode: "takeover", steps: [{ status: "PENDING" }] },
      { ...same, status: "COMPLETED", mode: "takeover", steps: [] },
      { ...same, status: "COMPLETED", mode: "takeover", steps: [{ status: "PASSED" }] },
      { ...same, status: "COMPLETED", mode: "takeover", steps: [{ status: "SKIPPED" }] },
    ]);
    expect(await m.world.siblingRuns({ id: "r1", teamId: "t1", actorId: "u1", sourceKind: "coolify", sourceHost: "coolify.example.test" })).toEqual({ live: 2, undecommissioned: 2 });
    expect(m.prisma.migrationRun.findMany).toHaveBeenCalledWith({
      where: { id: { not: "r1" }, OR: [{ teamId: "t1" }, { actorId: "u1" }], sourceKind: "coolify", dryRun: false, status: { notIn: ["ABORTED", "ROLLED_BACK", "REVERSED", "DRY_RUN_DONE"] } },
      select: { status: true, mode: true, sourceHost: true, serverMap: true, sourceBaseline: true, steps: { where: { key: "DECOMMISSION" }, select: { status: true } } },
    });
  });

  it("siblingRuns finds the same Coolify entered under another host form, through a shared source server uuid or a shared resource ref", async () => {
    const m = make();
    m.prisma.migrationRun.findMany.mockResolvedValue([
      { status: "RUNNING", mode: "copy", sourceHost: "203.0.113.5:8000", serverMap: { "srv-a": "t1" }, sourceBaseline: null }, // same server uuid
      { status: "RUNNING", mode: "copy", sourceHost: "203.0.113.5:8000", serverMap: null, sourceBaseline: { capturedAt: "x", entries: [{ ref: "app-9" }] } }, // same resource ref
      { status: "RUNNING", mode: "copy", sourceHost: "other.example.test", serverMap: { "srv-z": "t9" }, sourceBaseline: { entries: [{ ref: "app-77" }] } }, // another instance
      { status: "RUNNING", mode: "copy", sourceHost: null, serverMap: null, sourceBaseline: null }, // says nothing about its source
    ]);
    const r = await m.world.siblingRuns({ id: "r1", teamId: "t1", actorId: "u1", sourceKind: "coolify", sourceHost: "coolify.example.test", serverMap: { "srv-a": "t2" }, sourceBaseline: { entries: [{ ref: "app-9" }, { ref: "app-10" }] } });
    expect(r).toEqual({ live: 2, undecommissioned: 0 });
  });

  it("siblingRuns of a run that offers no source identity at all is unknown (null), never none, and reads nothing", async () => {
    const m = make();
    expect(await m.world.siblingRuns({ id: "r1", teamId: "t1", actorId: "u1", sourceKind: "coolify", sourceHost: null })).toBeNull();
    expect(await m.world.siblingRuns({ id: "r1", teamId: "t1", actorId: "u1", sourceKind: "coolify", sourceHost: null, serverMap: {}, sourceBaseline: { entries: [] } })).toBeNull();
    expect(m.prisma.migrationRun.findMany).not.toHaveBeenCalled();
  });

  it("serverFacts returns null for an unknown server", async () => {
    const m = make();
    m.prisma.server.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s", name: "n", teamId: "t", publicIp: null, proxyBind: "public" });
    expect(await m.world.serverFacts("x")).toBeNull();
    expect(await m.world.serverFacts("s")).toEqual({ id: "s", name: "n", teamId: "t", publicIp: null, proxyBind: "public" });
  });
});

describe("helpers", () => {
  it("isMinioResult reads the kept member names of a service result", () => {
    expect(isMinioResult({ members: ["minio", "console"] })).toBe(true);
    expect(isMinioResult({ members: ["meilisearch"] })).toBe(false);
    expect(isMinioResult(null)).toBe(false);
    expect(isMinioResult({ members: "minio" })).toBe(false);
  });

  it("sanitizeRepo keeps host/owner/repo and drops userinfo, .git, query and anything that is not a git url", () => {
    expect(sanitizeRepo("https://user:tok@github.com/acme/web.git")).toBe("github.com/acme/web");
    expect(sanitizeRepo("ssh://git@git.example.test:2222/acme/web")).toBe("git.example.test/acme/web");
    expect(sanitizeRepo("git@gitlab.example.test:grp/sub/repo.git")).toBe("gitlab.example.test/grp/sub/repo");
    expect(sanitizeRepo("https://github.com/acme/web/")).toBe("github.com/acme/web");
    expect(sanitizeRepo("")).toBeNull();
    expect(sanitizeRepo(null)).toBeNull();
    expect(sanitizeRepo("just words")).toBeNull();
  });
});
