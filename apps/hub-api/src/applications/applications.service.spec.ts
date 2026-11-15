import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, Role } from "@prisma/client";
import { AppBusyException, ApplicationsService } from "./applications.service";
import { SetEnvironmentSchema } from "./dto";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { CryptoService } from "../crypto/crypto.service";
import { TEMPLATES, templateMetaList } from "../templates/catalog";
import type { TemplateCatalogService } from "../catalog/template-catalog.service";
import { COMPOSE_RENDERED_MARKER, COMPOSE_SHA_MARKER } from "../deploy/compose-git";

// listDomains probes TLS over the network; stub it so the unit test stays offline.
jest.mock("./ssl-probe", () => ({
  probeSsl: jest.fn().mockResolvedValue({ state: "ok", daysRemaining: 90, issuer: "Let's Encrypt" }),
}));

// OWNER/ADMIN hold every granular permission; a fresh Set per call keeps mocks isolated.
const OWNER_PERMS = () =>
  new Set([
    "apps:deploy",
    "apps:config",
    "databases",
    "backups",
    "servers:manage",
    "servers:ops",
    "terminal",
    "bulk",
    "monitors",
    "projects",
    "integrations",
    "variables",
  ]);

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s,
} as unknown as CryptoService;

function makeDeployLogs(): DeployLogHub {
  return {
    begin: jest.fn(),
    push: jest.fn(),
    finish: jest.fn(),
    subscribe: jest.fn(),
  } as unknown as DeployLogHub;
}

type MonitorsMock = { createForApp: jest.Mock; removeForApp: jest.Mock };

function makeMonitors(): MonitorsMock {
  return { createForApp: jest.fn().mockResolvedValue(undefined), removeForApp: jest.fn().mockResolvedValue(undefined) };
}

// Permissive per-resource-scoping defaults so tests that don't exercise scoping stay green;
// a test overrides any of these to assert scoping behaviour.
function accessWith(access: Partial<TeamAccessService>): TeamAccessService {
  return {
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    requireProjectAccess: jest.fn().mockResolvedValue(undefined),
    grantResourceAccess: jest.fn().mockResolvedValue(undefined),
    grantProjectAccess: jest.fn().mockResolvedValue(undefined),
    membershipAccess: jest.fn().mockResolvedValue(null),
    accessByTeam: jest.fn().mockResolvedValue(new Map()),
    // requireWrite() gates on requirePermission — default to a permissive member; denial tests override.
    requirePermission: jest.fn().mockResolvedValue(undefined),
    // require() still uses teamRole for a plain membership check; canWrite/list now derive
    // from the granular permission sets. Default to a full-access member; tests override.
    teamRole: jest.fn().mockResolvedValue(Role.OWNER),
    membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map()),
    ...access,
  } as unknown as TeamAccessService;
}

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer>,
  deployLogs: DeployLogHub = makeDeployLogs(),
  monitors: MonitorsMock = makeMonitors(),
  ai: { analyze: jest.Mock } = { analyze: jest.fn().mockResolvedValue("analysis") },
  teamDefaults: { resolveDefaultEnvironmentId: jest.Mock } = {
    resolveDefaultEnvironmentId: jest.fn().mockResolvedValue("env-default"),
  },
  portAlloc: { allocate: jest.Mock; probeUsedPorts?: jest.Mock } = { allocate: jest.fn().mockResolvedValue([]) },
  swarm: { status?: jest.Mock } = { status: jest.fn().mockResolvedValue({ live: [] }) },
  dns: { previewRecords?: jest.Mock; applyRecords?: jest.Mock; verify?: jest.Mock; cleanup?: jest.Mock; purgeDomains?: jest.Mock; manualRecords?: jest.Mock } = {},
  dbLinks: { resolveLinkedEnv?: jest.Mock } = {},
  panelDomain: string | null = null, // when set, the reserved control-panel hostname (collision guard)
  secretRefs: { resolveSecretEnv?: jest.Mock } = {},
  lease: { bootId: string; bootAt: Date } = { bootId: TEST_BOOT_ID, bootAt: new Date() },
  imageUpdate: { checkApp?: jest.Mock; intervalMin?: jest.Mock } = {},
  logDrainPush: { targetServerIds?: jest.Mock; pushForServers?: jest.Mock } = {},
) {
  // createFromTemplate v2 probes listening ports (outside the tx) before allocating.
  portAlloc.probeUsedPorts = portAlloc.probeUsedPorts ?? jest.fn().mockResolvedValue(new Set());
  // Durable-dispatch gate: existing deploy tests stub only sendCommand and model an OLD agent (no cmd_journal_v1),
  // so they keep exercising the legacy path byte-for-byte. Mutated in place (not spread) so a test's later
  // assertions on its own agentWs object still see the same jest.fn()s.
  const aw = agentWs as Partial<AgentWsServer> & Record<string, unknown>;
  if (typeof aw.agentSupports !== "function") aw.agentSupports = jest.fn().mockReturnValue(false);
  if (typeof aw.isOnline !== "function") aw.isOnline = jest.fn().mockReturnValue(true);
  // view() now resolves a server's public IP to synthesize a domainless app's
  // http://<ip>:<hostPort> URL; every test path through get()/list()/listPreviews()
  // hits server.findUnique/findMany. Default to "no IP" so unrelated tests stay
  // green; tests that assert the fallback URL override server on their own prisma.
  const withServerDefaults = {
    ...prisma,
    server: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      ...(prisma as { server?: object }).server,
    },
    // App-move guards (assertNoActiveMove / claimNext / list): default to "no live move" so every existing test is unchanged.
    appMove: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      ...(prisma as { appMove?: object }).appMove,
    },
    // Compose deploys/rollbacks load per-service domains; default to none so existing tests need no stub.
    appServiceDomain: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
      ...(prisma as { appServiceDomain?: object }).appServiceDomain,
    },
  } as unknown as Partial<PrismaService>;
  // Deploy-queue defaults: existing deploy tests stub only the old runDeploy shape (create/update/findUnique/
  // findFirst). submitDeploy→claimNext now also needs count/updateMany/$queryRaw and must be able to CLAIM the
  // just-created QUEUED row. Model a faithful 1-row queue here so those tests exercise submit→claim→execute→
  // drain unchanged: remember the row create() made, hand it to claimNext's findFirst(QUEUED) until the claim
  // CAS (updateMany → RUNNING) consumes it. Multi-row queue + cancel races get their own stateful-store tests.
  const providedDep = ((prisma as { deployment?: Record<string, jest.Mock> }).deployment ?? {}) as Record<string, jest.Mock>;
  if (providedDep.create) {
    let pending: { id: string } | null = null;
    (withServerDefaults as { deployment?: object }).deployment = {
      count: jest.fn().mockResolvedValue(0),
      ...providedDep,
      create: jest.fn(async (args: { data?: { status?: string } }) => {
        const r = (await providedDep.create(args)) as { id: string };
        if (args?.data?.status === "QUEUED") pending = r; // only a queue submission is claimable (rollback writes RUNNING directly)
        return r;
      }),
      findFirst: jest.fn(async (args: { where?: { status?: string } }) => {
        // The wrapper OWNS QUEUED lookups (claimNext); a test's own findFirst is for the RUNNING/SUCCESS
        // queries (ensureNoActiveDeploy, prev-success rollback) and must never answer a QUEUED claim.
        if (args?.where?.status === "QUEUED") return pending;
        return providedDep.findFirst ? await providedDep.findFirst(args) : null;
      }),
      updateMany: jest.fn(async (args: { where?: { id?: string }; data?: { status?: string; phase?: string } }) => {
        const r = providedDep.updateMany ? ((await providedDep.updateMany(args)) as { count?: number } | undefined) : undefined;
        if (args?.data?.status === "RUNNING" && pending && args?.where?.id === pending.id) pending = null; // claimed
        // A test's own count is honoured for the lease CAS writes (dispatch / release) so it can model a lost
        // lease; the queue claim itself always succeeds here (the 1-row model above owns that).
        if (args?.data?.phase && r && typeof r.count === "number") return r;
        return { count: 1 };
      }),
    };
  }
  // upsertPreview takes a pg advisory xact lock (`$executeRaw`) inside the same $transaction: default it to a no-op spy.
  (withServerDefaults as { $executeRaw?: unknown }).$executeRaw =
    (prisma as { $executeRaw?: unknown }).$executeRaw ?? jest.fn().mockResolvedValue(0);
  (withServerDefaults as { $queryRaw?: unknown }).$queryRaw =
    (prisma as { $queryRaw?: unknown }).$queryRaw ?? jest.fn().mockResolvedValue([]);
  // createFromTemplate v2 runs allocate+insert in a $transaction; default it to run the callback
  // against the same stub (tx === prisma) unless a test supplies its own.
  (withServerDefaults as { $transaction?: unknown }).$transaction =
    (prisma as { $transaction?: unknown }).$transaction ??
    ((cb: (tx: unknown) => unknown) => cb(withServerDefaults));
  return new ApplicationsService(
    withServerDefaults as PrismaService,
    accessWith(access),
    audit,
    agentWs as AgentWsServer,
    deployLogs,
    { stream: jest.fn() } as unknown as import("../agent-gateway/log-stream.service").LogStreamService,
    { ensureProxy: jest.fn() } as unknown as import("./proxy.service").ProxyService,
    crypto,
    monitors as unknown as import("../monitors/monitors.service").MonitorsService,
    { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as import("../notifications/notifications.service").NotificationsService,
    { installationToken: jest.fn().mockResolvedValue("ghs_inst"), cloneToken: jest.fn().mockResolvedValue("ghs_inst") } as unknown as import("../git-sources/git-sources.service").GitSourcesService,
    ai as unknown as import("./ai.service").AiService,
    teamDefaults as unknown as import("../teams/team-defaults.service").TeamDefaultsService,
    { forApp: jest.fn().mockResolvedValue({ containers: [] }) } as unknown as import("../metrics/container-metrics.service").ContainerMetricsService,
    portAlloc as unknown as import("./port-allocator.service").PortAllocatorService,
    {
      get: (slug: string) => TEMPLATES[slug],
      metaList: () => templateMetaList(),
      all: () => TEMPLATES,
    } as unknown as TemplateCatalogService,
    {
      deploy: jest.fn().mockResolvedValue({ exitCode: 0, output: "", digest: null, registryRef: null }),
      scale: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }),
      restart: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }),
      remove: jest.fn().mockResolvedValue(undefined),
      status: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    } as unknown as import("../clusters/swarm-deploy.service").SwarmDeployService,
    { status: swarm.status ?? jest.fn().mockResolvedValue({ live: [] }) } as unknown as import("../clusters/swarm.service").SwarmService,
    {
      previewRecords: dns.previewRecords ?? jest.fn(),
      applyRecords: dns.applyRecords ?? jest.fn(),
      verify: dns.verify ?? jest.fn(),
      cleanup: dns.cleanup ?? jest.fn().mockResolvedValue({ removed: 0 }),
      purgeDomains: dns.purgeDomains ?? jest.fn().mockResolvedValue({ removed: 0 }),
      manualRecords: dns.manualRecords ?? jest.fn(),
    } as unknown as import("../dns/dns-automation.service").DnsAutomationService,
    {
      resolveLinkedEnv: dbLinks.resolveLinkedEnv ?? jest.fn().mockResolvedValue({}),
    } as unknown as import("./app-database-links.service").AppDatabaseLinksService,
    {
      resolveSecretEnv: secretRefs.resolveSecretEnv ?? jest.fn().mockResolvedValue({}),
    } as unknown as import("./app-secret-refs.service").AppSecretRefsService,
    {
      // One token-agnostic stub serves every lazy ModuleRef.get() the service makes: the tunnel service
      // (syncIngress), InstanceSettingsService (panelDomainFor) and ConfigService (get). panelDomain is
      // null by default so the reserved-domain guard is a no-op for all existing tests.
      get: () => ({
        syncIngress: jest.fn().mockResolvedValue(undefined),
        panelDomainFor: jest.fn().mockResolvedValue(panelDomain),
        get: (key: string) =>
          key === "PANEL_DOMAIN" ? (panelDomain ?? undefined) : key === "PANEL_TLS" ? (panelDomain ? "1" : undefined) : undefined,
      }),
    } as unknown as import("@nestjs/core").ModuleRef,
    lease as unknown as import("./deploy-lease.service").DeployLeaseService,
    { checkApp: imageUpdate.checkApp ?? jest.fn(), intervalMin: imageUpdate.intervalMin ?? jest.fn().mockReturnValue(360) } as unknown as import("./image-update.service").ImageUpdateService,
    {
      targetServerIds: logDrainPush.targetServerIds ?? jest.fn().mockResolvedValue([]),
      pushForServers: logDrainPush.pushForServers ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as import("../log-drains/log-drain-push.service").LogDrainPushService,
  );
}

/** The bootId every test service runs under (claimNext / rollback rows are stamped with it). */
const TEST_BOOT_ID = "boot-test";

const app = {
  id: "app1",
  teamId: "t1",
  serverId: "s1",
  name: "web",
  image: "nginx",
  env: {},
  hostPort: null,
  containerPort: 80,
  status: "NEW",
  createdAt: new Date(),
};

/** Drain the microtask queue so a fire-and-forget notification (awaited internally) has run. */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe("ApplicationsService", () => {
  it("forbids creating an app for a team the user can't write to", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(
      svc.create("u1", { name: "web", serverId: "s1", image: "nginx" }),
    ).rejects.toThrow(/nope/);
  });

  function createDeps() {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create: jest.fn().mockResolvedValue({ ...app, source: "IMAGE" }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    return { prisma, access };
  }
  type WithSubmitDeploy = { submitDeploy: (...a: unknown[]) => Promise<unknown> };

  it("fires a best-effort deploy when deploy:true", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    const submitDeploy = jest
      .spyOn(svc as unknown as WithSubmitDeploy, "submitDeploy")
      .mockResolvedValue(undefined);
    await svc.create("u1", { name: "web", serverId: "s1", image: "nginx", deploy: true });
    expect(submitDeploy).toHaveBeenCalledWith(expect.objectContaining({ id: "app1" }), "u1");
  });

  it("a new image/git app starts with the 30 s post-cutover soak, a COMPOSE app with 0", async () => {
    for (const [body, expected] of [
      [{ name: "web", serverId: "s1", image: "nginx" }, 30],
      [{ name: "web", serverId: "s1", source: "GIT", gitUrl: "https://github.com/u/r.git" }, 30],
      [{ name: "web", serverId: "s1", source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx\n" }, 0],
    ] as const) {
      const { prisma, access } = createDeps();
      await make(prisma, access, {} as AgentWsServer).create("u1", body as never);
      expect((prisma.application.create as jest.Mock).mock.calls[0][0].data.postCutoverSoakSec).toBe(expected);
    }
  });

  it("does not deploy when the deploy flag is absent", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    const submitDeploy = jest
      .spyOn(svc as unknown as WithSubmitDeploy, "submitDeploy")
      .mockResolvedValue(undefined);
    await svc.create("u1", { name: "web", serverId: "s1", image: "nginx" });
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it("validates a pasted compose on create even when a templateSlug is supplied (no bypass)", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    // A client-settable templateSlug must NOT exempt a client-supplied composeFile from assertSafeCompose:
    // curated templates install via installTemplate() with a server-built compose, never through create().
    const evil = "services:\n  x:\n    image: nginx\n    privileged: true\n";
    await expect(
      svc.create("u1", { name: "evil", serverId: "s1", source: "COMPOSE", composeFile: evil, templateSlug: "legit-looking" }),
    ).rejects.toThrow(/privileged/);
    expect(prisma.application.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("still creates successfully when the best-effort deploy fails (agent offline)", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    jest
      .spyOn(svc as unknown as WithSubmitDeploy, "submitDeploy")
      .mockRejectedValue(new Error("agent offline"));
    const view = await svc.create("u1", { name: "web", serverId: "s1", image: "nginx", deploy: true });
    expect(view.id).toBe("app1");
  });

  it("deploys via the agent and records SUCCESS on exit 0", async () => {
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null), // no active deploy
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    // agent streams a chunk, then the command resolves
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s, _c, _cap, _t, onChunk?: (c: string) => void) => {
        onChunk?.("building…\n");
        return Promise.resolve({ exitCode: 0, output: "deployed" });
      }),
    } as unknown as AgentWsServer;
    const deployLogs = makeDeployLogs();

    const svc = make(prisma, access, agentWs, deployLogs);
    const dep = await svc.deploy("u1", "app1");

    expect(agentWs.sendCommand).toHaveBeenCalled();
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", exitCode: 0 }) }),
    );
    expect(appUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "RUNNING" } }),
    );
    // live log stream: begin → push(chunk) → finish(SUCCESS)
    expect(deployLogs.begin).toHaveBeenCalledWith("app1");
    expect(deployLogs.push).toHaveBeenCalledWith("app1", "building…\n");
    expect(deployLogs.finish).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ status: "SUCCESS", exitCode: 0, deploymentId: "d1" }),
    );
    expect(dep?.status).toBe("SUCCESS");
    // a redacted config snapshot is persisted for the diff view
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ configSnapshot: expect.any(Object) }) }),
    );
    // deploy-history (feature B): wall-clock duration stamped on the terminal update; origin on create
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ durationMs: expect.any(Number) }) }),
    );
    expect(prisma.deployment.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "manual" }) }),
    );
  });

  it("records the resolved image digest echoed by the deploy (null when no marker)", async () => {
    const run = (output: string) => {
      const depUpdate = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d1" }),
          update: depUpdate,
          findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output }) } as unknown as AgentWsServer;
      return { depUpdate, run: make(prisma, access, agentWs).deploy("u1", "app1") };
    };
    const a = run("pull…\nTUGRA_DIGEST=nginx@sha256:abc123\ndone");
    await a.run;
    expect(a.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ imageDigest: "nginx@sha256:abc123" }) }));
    const b = run("deployed"); // no marker
    await b.run;
    expect(b.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ imageDigest: null }) }));
  });

  it("rolls an IMAGE app back by re-pulling the recorded digest when the local tag is pruned", async () => {
    let sentCmd = "";
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(
            where.status === "RUNNING"
              ? null
              : { id: "target", status: "SUCCESS", imageTag: null, registryImage: null, imageDigest: "nginx@sha256:deadbeef" },
          ),
        ),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sentCmd = cmd; return Promise.resolve({ exitCode: 0, output: "up" }); }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).rollback("u1", "app1", "target");
    // byte-exact reconstruction: pull the digest ref + tag it as the target version locally.
    expect(sentCmd).toContain("docker pull 'nginx@sha256:deadbeef'");
    expect(sentCmd).toContain("docker tag 'nginx@sha256:deadbeef' tugra_app1:target");
  });

  it("rollback whose LOCAL image is gone (exit 7) fails the deployment but leaves the serving app untouched", async () => {
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, status: "RUNNING" }), update: appUpdate },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(
            where.status === "RUNNING"
              ? null // ensureNoActiveDeploy: nothing running
              : { id: "target", status: "SUCCESS", imageTag: "tugra_app1:target", registryImage: null, imageDigest: null },
          ),
        ),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 7, output: "TUGRA_ROLLBACK: image tugra_app1:target not found locally; keeping the running container" }),
    } as unknown as AgentWsServer;

    await make(prisma, access, agentWs).rollback("u1", "app1", "target");

    // the rollback attempt is recorded FAILED...
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    // ...but the live app is NOT flipped to FAILED (the guard left the running container serving).
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect(appUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  it("a routed app rolls (temp container) and exit 3 auto-rolls-back: FAILED/AUTO_ROLLBACK but app stays RUNNING", async () => {
    const rollingApp = { ...app, domain: "app.example.com", deployStrategy: "ROLLING", rollbackOnFailure: true };
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(rollingApp), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED", kind: "AUTO_ROLLBACK" }),
        // active-deploy check (status RUNNING) → none; prev-success check (status SUCCESS) → a prior live version
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "SUCCESS" ? { id: "prev", imageTag: "tugra_app1:prev" } : null),
        ),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: null, publicIpv6: null }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd; // ignore the post-fail cleanup (capability "cleanup")
        return Promise.resolve({ exitCode: 3, output: "TUGRA_ROLLOUT: rolled_back" });
      }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, access, agentWs);
    await svc.deploy("u1", "app1");
    await flushMicrotasks(); // the deploy notification fires-and-forgets after project/url enrichment
    // a routed rolling app uses the rolling builder (temp __rollout container)
    expect(sentCmd).toContain("tugra_app1__rollout");
    // exit 3 → deployment FAILED + kind AUTO_ROLLBACK, but the app is still RUNNING (old kept)
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 3, imageTag: null }) }),
    );
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect((svc as unknown as { notifications: { fireForEvent: jest.Mock } }).notifications.fireForEvent).toHaveBeenCalledWith(
      "t1",
      "deploy_rolled_back",
      expect.objectContaining({ appName: "web", appId: "app1" }),
    );
  });

  it("exit 3 on a first deploy (no previous version to fall back to) is a hard failure, not a rollback", async () => {
    const rollingApp = { ...app, domain: "app.example.com", deployStrategy: "ROLLING", rollbackOnFailure: true };
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(rollingApp), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null), // no active deploy AND no prior success
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 3, output: "" }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    // no previous live version → exit 3 is a real failure, app is FAILED (not falsely RUNNING)
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "DEPLOY" }) }));
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  it("exit 4 (post-cutover soak auto-revert) → FAILED/AUTO_ROLLBACK, app RUNNING, deploy_rolled_back — WITHOUT a prev-success DB lookup", async () => {
    const soakApp = { ...app, domain: "app.example.com", deployStrategy: "ROLLING", rollbackOnFailure: true, postCutoverSoakSec: 30 };
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(soakApp), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED", kind: "AUTO_ROLLBACK" }),
        // NO prior SUCCESS row exists — exit 4 must still classify as a rollback (the script already restored
        // __prev, so the previous version is provably live; no DB re-derivation like exit 3 needs).
        findFirst: jest.fn().mockResolvedValue(null),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: null, publicIpv6: null }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 4, output: "TUGRA_ROLLOUT: reverted" });
      }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, access, agentWs);
    await svc.deploy("u1", "app1");
    await flushMicrotasks();
    // the rolling builder emitted the soak retention (keep the old as __prev)
    expect(sentCmd).toContain("tugra_app1__prev");
    // exit 4 → deployment FAILED + AUTO_ROLLBACK (the new image never stayed live → imageTag null, exitCode 4)
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 4, imageTag: null }) }),
    );
    // but the app is RUNNING on the previous version (__prev was started by the script)
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect((svc as unknown as { notifications: { fireForEvent: jest.Mock } }).notifications.fireForEvent).toHaveBeenCalledWith(
      "t1",
      "deploy_rolled_back",
      expect.objectContaining({ appName: "web", appId: "app1" }),
    );
  });

  it("a rolling deploy with a post-cutover soak extends the agent timeout by the soak budget", async () => {
    const soakApp = { ...app, domain: "app.example.com", deployStrategy: "ROLLING", rollbackOnFailure: true, postCutoverSoakSec: 60, healthInterval: 5 };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(soakApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let deployTimeout = -1;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, _cmd: string, cap: string, t: number) => {
        if (cap === "deploy") deployTimeout = t;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    // base 300s + soak budget (60s window + 12 probes*5s + 15s margin = 135s) → 435s, well above the bare default
    expect(deployTimeout).toBeGreaterThanOrEqual((300 + 60) * 1000);
  });

  it("a rolling deploy with NO soak passes the bare deploy timeout (no added latency)", async () => {
    const noSoakApp = { ...app, domain: "app.example.com", deployStrategy: "ROLLING", rollbackOnFailure: true };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(noSoakApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let deployTimeout = -1;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, _cmd: string, cap: string, t: number) => {
        if (cap === "deploy") deployTimeout = t;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(deployTimeout).toBe(300 * 1000); // unchanged default
  });

  it("a host-port app deploys via recreate (health-gated, no temp container), not rolling", async () => {
    const hp = { ...app, domain: "app.example.com", hostPort: 8080, deployStrategy: "ROLLING", rollbackOnFailure: true };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(hp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(sentCmd).not.toContain("__rollout"); // port map → can't overlap → recreate on canonical
    expect(sentCmd).toContain("docker run -d --name tugra_app1"); // recreated under the canonical name
    expect(sentCmd).toContain("set +e"); // it IS health-gated (unlike a plain hard cutover)
  });

  it("an app with network aliases deploys via recreate, not rolling (a rollout would share the alias)", async () => {
    const na = { ...app, domain: "app.example.com", networkAliases: ["api"], deployStrategy: "ROLLING", rollbackOnFailure: true };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(na), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(sentCmd).not.toContain("__rollout"); // alias would collide during overlap → recreate
    expect(sentCmd).toContain("--network-alias 'api'"); // alias still applied on the recreated container
  });

  it("a recreate app (host-port) auto-rolls-back on exit 3: FAILED/AUTO_ROLLBACK but app stays RUNNING", async () => {
    const hp = { ...app, domain: "app.example.com", hostPort: 8080, deployStrategy: "ROLLING", rollbackOnFailure: true };
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(hp), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED", kind: "AUTO_ROLLBACK" }),
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "SUCCESS" ? { id: "prev", imageTag: "tugra_app1:prev" } : null),
        ),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: null, publicIpv6: null }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 3, output: "TUGRA_ROLLOUT: rolled_back" });
      }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, access, agentWs);
    await svc.deploy("u1", "app1");
    await flushMicrotasks(); // the deploy notification fires-and-forgets after project/url enrichment
    // the recreate script carries the previous image as its rollback target
    expect(sentCmd).toContain("tugra_app1:prev");
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 3, imageTag: null }) }),
    );
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect((svc as unknown as { notifications: { fireForEvent: jest.Mock } }).notifications.fireForEvent).toHaveBeenCalledWith(
      "t1",
      "deploy_rolled_back",
      expect.objectContaining({ appName: "web", appId: "app1" }),
    );
  });

  it("a throw BEFORE the live app is touched (revoked privileged options) leaves a RUNNING app UNTOUCHED", async () => {
    // assertSafeDockerOptions re-validates stored options at the top of executeDeploy, before anything on the
    // live server runs. A revoked privileged override makes it throw there — the old container is still
    // serving, so the app status must NOT be flipped to FAILED (only the deployment is FAILED).
    const running = { ...app, status: "RUNNING", dockerOptions: "--privileged", allowPrivilegedDockerOptions: false };
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(running), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    await flushMicrotasks();
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    // Pre-swap throw (nothing on the live server ran) → app row never written, not flipped to FAILED.
    expect(appUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("a NON-running app that throws pre-swap is still marked FAILED (nothing to preserve)", async () => {
    const neverRan = { ...app, status: "NEW", dockerOptions: "--privileged", allowPrivilegedDockerOptions: false };
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(neverRan), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    await flushMicrotasks();
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  it("rollbackOnFailure=false → plain hard cutover (no health gate, no rollback)", async () => {
    const hp = { ...app, domain: "app.example.com", hostPort: 8080, deployStrategy: "ROLLING", rollbackOnFailure: false };
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(hp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst,
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(sentCmd).not.toContain("__rollout");
    expect(sentCmd).not.toContain("set +e"); // opted out of rollback → no health gate
    // no prev-success lookup happens when the app isn't rolling/recreate eligible
    expect(findFirst.mock.calls.every((c) => (c[0] as { where: { status?: string } }).where.status !== "SUCCESS")).toBe(true);
  });

  it("deployments() diffs each deploy's config against the previous one", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        findMany: jest.fn().mockResolvedValue([
          { id: "d2", status: "SUCCESS", createdAt: new Date(2), configSnapshot: { env: {}, volumes: [], memoryMb: 512, hasGitToken: false, hasRegistryAuth: false } },
          { id: "d1", status: "SUCCESS", createdAt: new Date(1), configSnapshot: { env: {}, volumes: [], memoryMb: 256, hasGitToken: false, hasRegistryAuth: false } },
        ]),
      },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    const list = await svc.deployments("u1", "app1");

    expect(list[0].configChanges).toContainEqual(
      expect.objectContaining({ field: "memoryMb", kind: "changed", before: "256", after: "512" }),
    );
    // oldest deploy has no previous snapshot → no changes; raw snapshot not leaked
    expect(list[1].configChanges).toEqual([]);
    expect(list[0]).not.toHaveProperty("configSnapshot");
  });

  it("deployments() is writer-only (rows carry secret-bearing build logs → VIEWER is denied)", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).deployments("u1", "app1")).rejects.toThrow(/nope/);
  });

  it("deployments() marks a digest-only IMAGE deploy rollbackable (byte-exact repull after prune)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        findMany: jest.fn().mockResolvedValue([
          // local tag + registry push both absent/pruned, but the recorded upstream digest survives.
          { id: "d1", status: "SUCCESS", imageTag: null, registryImage: null, imageDigest: "nginx@sha256:abc", createdAt: new Date(1), configSnapshot: { env: {}, volumes: [] } },
        ]),
      },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const list = await make(prisma, access, {} as AgentWsServer).deployments("u1", "app1");
    expect(list[0].rollbackable).toBe(true);
  });

  const composeApp = {
    ...app,
    source: "COMPOSE",
    composeFile: "services:\n  web:\n    image: nginx:1.21\n",
    domain: null,
  };
  const OLD_COMPOSE = "services:\n  web:\n    image: nginx:1.20\n";

  function composeRollbackDeps(exitCode: number) {
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    let sentCmd = "";
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update: appUpdate },
      deployment: {
        // status-aware: the active-deploy guard queries status:"RUNNING" (→ none); the target lookup queries SUCCESS.
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(
            where.status === "RUNNING"
              ? null
              : { id: "target", status: "SUCCESS", configSnapshot: { composeFile: OLD_COMPOSE, env: {}, volumes: [] } },
          ),
        ),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: exitCode === 0 ? "SUCCESS" : "FAILED" }),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => {
        sentCmd = cmd;
        return Promise.resolve({ exitCode, output: "up" });
      }),
    } as unknown as AgentWsServer;
    return { prisma, access, agentWs, depUpdate, appUpdate, sentCmd: () => sentCmd };
  }

  it("rolls a compose app back to a prior deploy's compose config (restore + persist)", async () => {
    const d = composeRollbackDeps(0);
    await make(d.prisma, d.access, d.agentWs).rollback("u1", "app1", "target");
    // deployed via the compose path (not `docker run`) with the RESTORED compose YAML written
    expect(d.sentCmd()).toContain("docker compose");
    expect(d.sentCmd()).toContain("up -d");
    expect(d.sentCmd()).toContain(Buffer.from(OLD_COMPOSE, "utf8").toString("base64"));
    // the rolled-back compose is persisted as the app's current source
    expect(d.appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { composeFile: OLD_COMPOSE } }));
    // deployment recorded SUCCESS, no single image tag, snapshot recorded (so it's itself a rollback target)
    expect(d.depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", imageTag: null, configSnapshot: expect.any(Object) }) }),
    );
  });

  it("rejects a compose rollback when the target deploy has no compose snapshot", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update: jest.fn() },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "target", status: "SUCCESS", configSnapshot: { env: {}, volumes: [] } }),
        ),
        create: jest.fn(),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, { sendCommand: jest.fn() } as unknown as AgentWsServer);
    await expect(svc.rollback("u1", "app1", "target")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("compose rollback is refused while a deployment is already running (409)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp) },
      deployment: { findFirst: jest.fn().mockResolvedValue({ id: "running", status: "RUNNING" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, { sendCommand: jest.fn() } as unknown as AgentWsServer);
    await expect(svc.rollback("u1", "app1", "target")).rejects.toBeInstanceOf(ConflictException);
  });

  it("compose rollback routes to the RESTORED file's web port, not the current version's (domain-routed)", async () => {
    // current app.composeFile → web on 8080; restored (target) → web on 3000. The Traefik override must
    // advertise the RESTORED port, else a domain-routed app 502s after a port change (ultracode HIGH #1/#3).
    const routedApp = {
      ...app,
      source: "COMPOSE",
      domain: "app.example.com",
      composeFile: "services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:8080\"\n",
    };
    const restored = "services:\n  web:\n    image: nginx\n    ports:\n      - \"3000:3000\"\n";
    let sentCmd = "";
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(routedApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "target", status: "SUCCESS", configSnapshot: { composeFile: restored, env: {}, volumes: [] } }),
        ),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sentCmd = cmd; return Promise.resolve({ exitCode: 0, output: "up" }); }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).rollback("u1", "app1", "target");
    // The compose file + Traefik override are base64-transported in the command — decode them to inspect.
    const decoded = [...sentCmd.matchAll(/printf %s '([^']+)' \| base64 -d/g)]
      .map((m) => Buffer.from(m[1], "base64").toString("utf8"))
      .join("\n");
    expect(decoded).toContain("loadbalancer.server.port=3000"); // routing derived from the RESTORED file
    expect(decoded).not.toContain("loadbalancer.server.port=8080"); // not the stale current-version port
  });

  it("a failed compose rollback marks FAILED and does NOT persist the compose file", async () => {
    const d = composeRollbackDeps(1);
    await make(d.prisma, d.access, d.agentWs).rollback("u1", "app1", "target");
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    expect(d.appUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ composeFile: expect.anything() }) }),
    );
  });

  it("deployments() marks a compose deploy rollbackable only when it has a compose snapshot", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp) },
      deployment: {
        findMany: jest.fn().mockResolvedValue([
          { id: "d2", status: "SUCCESS", imageTag: null, registryImage: null, createdAt: new Date(2), configSnapshot: { composeFile: OLD_COMPOSE, env: {}, volumes: [] } },
          { id: "d1", status: "SUCCESS", imageTag: null, registryImage: null, createdAt: new Date(1), configSnapshot: { env: {}, volumes: [] } },
        ]),
      },
    } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    const list = await svc.deployments("u1", "app1");
    expect(list[0].rollbackable).toBe(true); // has a compose snapshot
    expect(list[1].rollbackable).toBe(false); // no composeFile snapshot
  });

  it("deployments() does not flag a FAILED compose deploy rollbackable (snapshot exists but rollback would 404)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp) },
      deployment: {
        findMany: jest.fn().mockResolvedValue([
          // a FAILED deploy still carries configSnapshot.composeFile (recorded at deploy START) — the status gate is essential
          { id: "d1", status: "FAILED", imageTag: null, registryImage: null, createdAt: new Date(1), configSnapshot: { composeFile: OLD_COMPOSE, env: {}, volumes: [] } },
        ]),
      },
    } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    const list = await svc.deployments("u1", "app1");
    expect(list[0].rollbackable).toBe(false);
  });

  it("queues a second deploy while one is already running (no 409 — returns a QUEUED row, no agent command)", async () => {
    const created = { id: "q1", status: "QUEUED", appId: "app1" };
    const sendCommand = jest.fn();
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        // one deploy already RUNNING → claimNext must NOT claim; the new row stays QUEUED
        count: jest.fn().mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "RUNNING" ? 1 : 0)),
        create: jest.fn().mockResolvedValue(created),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(created),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const dep = await make(prisma, access, { sendCommand } as unknown as AgentWsServer).deploy("u1", "app1");
    expect(dep?.status).toBe("QUEUED");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rejects a submit when the per-app queue is full (409)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        count: jest.fn().mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "QUEUED" ? 10 : 0)),
        create: jest.fn(),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).deploy("u1", "app1")).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.deployment.create as jest.Mock).not.toHaveBeenCalled(); // capped before creating a row
  });

  it("a move's own deploy (key move:<id>) bypasses the full queue; a user deploy at the same cap is still 409", async () => {
    const created = { id: "mv1", status: "QUEUED", appId: "app1" };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        count: jest.fn().mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "QUEUED" ? 10 : 0)),
        create: jest.fn().mockResolvedValue(created),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
        // the idempotency pre-check sees nothing; every later read finds the row we just created
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(created),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.submitMoveDeploy("app1", "u1", "move:ckmoveabcdefghijklmnopqrs")).resolves.toMatchObject({ id: "mv1" });
    expect(prisma.deployment.create as jest.Mock).toHaveBeenCalledWith({ data: expect.objectContaining({ idempotencyKey: "move:ckmoveabcdefghijklmnopqrs", status: "QUEUED" }) });
    (prisma.deployment.findUnique as jest.Mock).mockResolvedValueOnce(null).mockResolvedValue(created);
    await expect(svc.submitMoveDeploy("app1", "u1", "move:ckmoveabcdefghijklmnopqrs:rb")).resolves.toMatchObject({ id: "mv1" });
    await expect(svc.deploy("u1", "app1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("a webhook submit supersedes older still-QUEUED webhook deploys for the same app", async () => {
    const supersede = jest.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: "w1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: supersede,
        findUnique: jest.fn().mockResolvedValue({ id: "w1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deployFromWebhook("app1");
    expect(supersede).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ appId: "app1", status: "QUEUED", trigger: "webhook" }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  describe("redriveQueuedForServer (re-drive QUEUED deploys on agent reconnect)", () => {
    it("drains once per DISTINCT app that has a QUEUED deploy on the reconnecting server (reuses claimNext)", async () => {
      const prisma = {
        deployment: {
          findMany: jest.fn().mockResolvedValue([
            { appId: "a1", application: { serverId: "s1", buildServerId: null } },
            { appId: "a2", application: { serverId: "s1", buildServerId: null } },
          ]),
        },
      } as unknown as PrismaService;
      const isOnline = jest.fn().mockReturnValue(true);
      const svc = make(prisma, {} as TeamAccessService, { isOnline } as unknown as AgentWsServer);
      // Spy on the private drain so we assert the fan-out without exercising the whole execute pipeline;
      // drain is the SAME machinery manual/webhook submits use, so one-RUNNING-per-app is honoured by reuse.
      const drain = jest.spyOn(svc as unknown as { drain: (id: string) => Promise<void> }, "drain").mockResolvedValue(undefined);
      await svc.redriveQueuedForServer("s1");
      expect(drain).toHaveBeenCalledTimes(2);
      expect(drain).toHaveBeenCalledWith("a1");
      expect(drain).toHaveBeenCalledWith("a2");
    });

    it("queries only non-clustered QUEUED rows for apps on this server as run OR build target (OR mirrors cleanup-runner)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = { deployment: { findMany } } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, { isOnline: jest.fn().mockReturnValue(true) } as unknown as AgentWsServer);
      await svc.redriveQueuedForServer("s1");
      const arg = findMany.mock.calls[0][0];
      expect(arg.where.status).toBe("QUEUED");
      // clusterId: null — CLUSTERED (swarm) apps are excluded from the reconnect re-drive (a swarm deploy targets
      // the dynamically-resolved manager, not serverId, so the per-server gate can't gate it); they are cancelled
      // at boot instead. Only single-server apps resume here.
      expect(arg.where.application).toEqual({ clusterId: null, OR: [{ serverId: "s1" }, { buildServerId: "s1" }] });
      expect(arg.distinct).toEqual(["appId"]);
    });

    it("does nothing when no QUEUED rows match", async () => {
      const prisma = { deployment: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, { isOnline: jest.fn().mockReturnValue(true) } as unknown as AgentWsServer);
      const drain = jest.spyOn(svc as unknown as { drain: (id: string) => Promise<void> }, "drain").mockResolvedValue(undefined);
      await svc.redriveQueuedForServer("s1");
      expect(drain).not.toHaveBeenCalled();
    });

    it("STRICT ONLINE GATE: skips (leaves QUEUED) an app whose SEPARATE build server is offline", async () => {
      const prisma = {
        deployment: {
          findMany: jest.fn().mockResolvedValue([
            { appId: "a1", application: { serverId: "s1", buildServerId: "b1" } },
          ]),
        },
      } as unknown as PrismaService;
      // s1 (the reconnecting run server) is online, but its build server b1 is not → do NOT drive it yet.
      const isOnline = jest.fn().mockImplementation((id: string) => id === "s1");
      const svc = make(prisma, {} as TeamAccessService, { isOnline } as unknown as AgentWsServer);
      const drain = jest.spyOn(svc as unknown as { drain: (id: string) => Promise<void> }, "drain").mockResolvedValue(undefined);
      await svc.redriveQueuedForServer("s1");
      expect(drain).not.toHaveBeenCalled();
    });

    it("respects one-RUNNING-per-app: when a deploy is already RUNNING, claimNext returns null and nothing is dispatched", async () => {
      const sendCommand = jest.fn();
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(app) },
        deployment: {
          findMany: jest.fn().mockResolvedValue([
            { appId: "app1", application: { serverId: "s1", buildServerId: null } },
          ]),
          // claimNext's RUNNING-count check sees one already running → it promotes nothing (returns null).
          count: jest.fn().mockResolvedValue(1),
        },
      } as unknown as PrismaService;
      const isOnline = jest.fn().mockReturnValue(true);
      const svc = make(prisma, {} as TeamAccessService, { sendCommand, isOnline } as unknown as AgentWsServer);
      await svc.redriveQueuedForServer("s1");
      await flushMicrotasks(); // drain is fire-and-forget; let claimNext resolve
      expect(sendCommand).not.toHaveBeenCalled(); // no bypass of the lock — executeDeploy never ran
    });
  });

  describe("sweepStaleQueued (stale-QUEUED backstop)", () => {
    it("cancels QUEUED rows older than the cutoff whose app has NO RUNNING deploy, with a re-deploy hint", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 3 });
      const prisma = { deployment: { updateMany } } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
      const before = Date.now();
      const n = await svc.sweepStaleQueued(6 * 3600 * 1000);
      expect(n).toBe(3);
      const arg = updateMany.mock.calls[0][0];
      // filters QUEUED ONLY — never SUCCESS/FAILED/RUNNING
      expect(arg.where.status).toBe("QUEUED");
      // older than cutoff = now - maxAgeMs (so a merely-rebooting server inside the window is untouched)
      expect(arg.where.createdAt.lt).toBeInstanceOf(Date);
      expect((arg.where.createdAt.lt as Date).getTime()).toBeLessThanOrEqual(before - 6 * 3600 * 1000 + 5);
      // leaves a QUEUED row legitimately waiting BEHIND a RUNNING deploy untouched
      expect(arg.where.application).toEqual({ deployments: { none: { status: "RUNNING" } } });
      expect(arg.data).toEqual({ status: "CANCELLED", exitCode: -1, logs: expect.stringMatching(/reconnect/i) });
    });

    it("never targets a RUNNING/SUCCESS/FAILED row (status filter is exactly QUEUED)", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const prisma = { deployment: { updateMany } } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
      await svc.sweepStaleQueued(1000);
      expect(updateMany.mock.calls[0][0].where.status).toBe("QUEUED");
      expect(updateMany.mock.calls[0][0].data.status).toBe("CANCELLED");
    });
  });

  describe("cancelDeployment", () => {
    function svcFor(updateCount: number, row: unknown, opts?: { denied?: boolean }) {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ id: "app1", teamId: "t1" }) },
        deployment: {
          updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
          findFirst: jest.fn().mockResolvedValue(row),
          findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "CANCELLED" }),
        },
      } as unknown as PrismaService;
      const access = {
        requirePermission: opts?.denied ? jest.fn().mockRejectedValue(new ForbiddenException("nope")) : jest.fn().mockResolvedValue(undefined),
      } as unknown as TeamAccessService;
      return make(prisma, access, {} as AgentWsServer);
    }

    it("cancels a QUEUED deploy (CAS hit) and returns the CANCELLED row", async () => {
      const r = await svcFor(1, null).cancelDeployment("u1", "app1", "d1");
      expect((r as { status: string }).status).toBe("CANCELLED");
    });

    it("409s a RUNNING deploy with no in-flight command to kill (swarm / orphaned by a hub restart)", async () => {
      await expect(svcFor(0, { id: "d1", status: "RUNNING" }).cancelDeployment("u1", "app1", "d1")).rejects.toBeInstanceOf(ConflictException);
    });

    it("cancels a RUNNING deploy with a tracked command: signals intent + SIGKILLs the agent command", async () => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ id: "app1", teamId: "t1" }) },
        deployment: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // not QUEUED
          findFirst: jest.fn().mockResolvedValue({ id: "d1", status: "RUNNING" }),
          findUnique: jest.fn(),
        },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const agentWs = { cancelCommand: jest.fn(), sendCommand: jest.fn() } as unknown as AgentWsServer;
      const svc = make(prisma, access, agentWs);
      (svc as unknown as { activeDeployCommands: Map<string, { serverId: string; reqId: string }> }).activeDeployCommands.set("d1", { serverId: "s9", reqId: "req-9" });
      const row = await svc.cancelDeployment("u1", "app1", "d1");
      expect((row as { status: string }).status).toBe("RUNNING"); // flips to CANCELLED async when the command returns
      expect(agentWs.cancelCommand).toHaveBeenCalledWith("s9", "req-9");
      expect((svc as unknown as { cancelRequested: Set<string> }).cancelRequested.has("d1")).toBe(true);
    });

    it("executeDeploy records a cancelled deploy as CANCELLED (not FAILED) and never flips the app to FAILED", async () => {
      const depUpdate = jest.fn().mockResolvedValue({});
      const appUpdate = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(app), update: appUpdate },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
          update: depUpdate,
          findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "CANCELLED" }),
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const ref: { svc?: import("./applications.service").ApplicationsService } = {};
      const agentWs = {
        cancelCommand: jest.fn(),
        // The deploy command is "cancelled" concurrently (via onStart) then returns a SIGKILL exit code.
        sendCommand: jest.fn().mockImplementation(async (_s: string, _c: string, cap: string, _t: number, _onChunk: unknown, onStart?: (r: string) => void) => {
          if (cap === "deploy" && onStart) {
            onStart("req-x");
            (ref.svc as unknown as { cancelRequested: Set<string> }).cancelRequested.add("d1");
          }
          return { exitCode: 137, output: "killed" };
        }),
      } as unknown as AgentWsServer;
      ref.svc = make(prisma, access, agentWs);
      await ref.svc.deploy("u1", "app1");
      await flushMicrotasks();
      expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
      expect(appUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    });

    it("409s when the deploy already finished", async () => {
      await expect(svcFor(0, { id: "d1", status: "SUCCESS" }).cancelDeployment("u1", "app1", "d1")).rejects.toBeInstanceOf(ConflictException);
    });

    it("404s when the deployment is not found or belongs to another app (CAS scoped by appId)", async () => {
      await expect(svcFor(0, null).cancelDeployment("u1", "app1", "dX")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("forbids a caller without apps:deploy", async () => {
      await expect(svcFor(1, null, { denied: true }).cancelDeployment("u1", "app1", "d1")).rejects.toThrow(/nope/);
    });
  });

  it("finishes the log stream as FAILED when the agent errors mid-deploy", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockRejectedValue(new Error("agent disconnected")),
    } as unknown as AgentWsServer;
    const deployLogs = makeDeployLogs();
    await make(prisma, access, agentWs, deployLogs).deploy("u1", "app1");
    expect(deployLogs.finish).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ status: "FAILED", deploymentId: "d1" }),
    );
  });

  it("returns decrypted env vars to a writer", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, envEnc: '{"FOO":"bar"}' }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    expect(await svc.getEnv("u1", "app1")).toEqual({ FOO: "bar" });
  });

  it("forbids a non-writer from reading or setting env", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.getEnv("u1", "app1")).rejects.toThrow(/nope/);
    await expect(svc.setEnv("u1", "app1", { A: "1" })).rejects.toThrow(/nope/);
  });

  it("stores env encrypted on setEnv", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setEnv("u1", "app1", { FOO: "bar" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { envEnc: 'enc({"FOO":"bar"})', envMetaEnc: null } }),
    );
  });

  it("start and restart run lifecycle commands and set RUNNING", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const isOnline = jest.fn().mockReturnValue(true);
    const svc = make(prisma, access, { sendCommand, isOnline } as unknown as AgentWsServer);
    await svc.start("u1", "app1");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker start tugra_app1", "deploy", 120_000);
    await svc.restart("u1", "app1");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker restart tugra_app1", "deploy", 120_000);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
  });

  it("start/restart THROW and never mark RUNNING when the lifecycle command exits non-zero", async () => {
    for (const action of ["start", "restart"] as const) {
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(app), update },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      // sendCommand RESOLVES with a non-zero exit (the command ran but failed — e.g. the container was removed);
      // the service must treat that as a failure, not a success.
      const sendCommand = jest.fn().mockResolvedValue({ exitCode: 1, output: "No such container" });
      const isOnline = jest.fn().mockReturnValue(true);
      const svc = make(prisma, access, { sendCommand, isOnline } as unknown as AgentWsServer);
      await expect(svc[action]("u1", "app1")).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("stop/start/restart throw ServiceUnavailableException (not an opaque 500) when the agent is offline", async () => {
    for (const action of ["stop", "start", "restart"] as const) {
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(app), update },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const sendCommand = jest.fn();
      const isOnline = jest.fn().mockReturnValue(false);
      const svc = make(prisma, access, { sendCommand, isOnline } as unknown as AgentWsServer);
      await expect(svc[action]("u1", "app1")).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(sendCommand).not.toHaveBeenCalled(); // short-circuited on the pre-check
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("listContainers parses the agent's docker ps output", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "tugra_app1\trunning\n" });
    const r = await make(prisma, access, { sendCommand } as unknown as AgentWsServer).listContainers("u1", "app1");
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("docker ps -a"), "deploy", expect.any(Number));
    expect(r.containers).toEqual([{ name: "tugra_app1", state: "running" }]);
  });

  it("appLogs runs docker logs via the agent for a writer", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "log line" });
    const out = await make(prisma, access, { sendCommand } as unknown as AgentWsServer).appLogs("u1", "app1", 50);
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("docker logs --tail 50 tugra_app1"), "deploy", expect.any(Number));
    expect(out.output).toBe("log line");
  });

  it("appLogs forbids a non-writer", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).appLogs("u1", "app1")).rejects.toThrow(/nope/);
  });

  it("analyzeDeployment fetches the deployment and runs AI on its logs", async () => {
    const dep = { id: "d1", appId: "app1", status: "FAILED", exitCode: 1, logs: "boom" };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: { findUnique: jest.fn().mockResolvedValue(dep) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const ai = { analyze: jest.fn().mockResolvedValue("fix it") };
    const out = await make(prisma, access, {} as AgentWsServer, undefined, undefined, ai).analyzeDeployment("u1", "app1", "d1");
    expect(ai.analyze).toHaveBeenCalledWith("boom", expect.objectContaining({ status: "FAILED", exitCode: 1 }));
    expect(out.analysis).toBe("fix it");
  });

  it("analyzeDeployment 404s for a deployment of another app", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: { findUnique: jest.fn().mockResolvedValue({ id: "d1", appId: "other", logs: "x" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).analyzeDeployment("u1", "app1", "d1")).rejects.toThrow(/not found/);
  });

  it("renames an app for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).rename("u1", "app1", "renamed");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "renamed" } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.name.update" }));
  });

  it("sets a description (trimmed) and clears it with blank/null", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setDescription("u1", "app1", "  the billing API  ");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { description: "the billing API" } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.description.update" }));
    await svc.setDescription("u1", "app1", "   ");
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { description: null } }));
    await svc.setDescription("u1", "app1", null);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { description: null } }));
  });

  it("replaces network aliases and audits the change", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), findFirst: jest.fn().mockResolvedValue(null), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setNetworkAliases("u1", "app1", ["api", "cache"]);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { networkAliases: ["api", "cache"] } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.network_aliases.update" }));
  });

  it("rejects a reserved tugra- alias (would hijack a Tugra-managed container's DNS name)", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setNetworkAliases("u1", "app1", ["ok", "tugra-proxy"])).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses network aliases on a clustered (swarm) app (the swarm path can't emit them)", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1" }), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setNetworkAliases("u1", "app1", ["api"])).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("stores custom docker options on setDockerOptions", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setDockerOptions("u1", "app1", "--dns 1.1.1.1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { dockerOptions: "--dns 1.1.1.1" } }));
    await svc.setDockerOptions("u1", "app1", null);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { dockerOptions: null } }));
  });

  it("rejects dockerOptions with an unterminated quote (early 400, not a failed deploy later)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.setDockerOptions("u1", "app1", '--label "oops')).rejects.toThrow(/unterminated quote/);
    expect(update).not.toHaveBeenCalled();
  });

  it("setHostMounts persists validated mounts (read-only default) and audits", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setHostMounts("u1", "app1", [{ hostPath: "/mnt/media", containerPath: "/media" }]);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { hostMounts: [{ hostPath: "/mnt/media", containerPath: "/media", readOnly: true }] } }));
  });

  it("setHostMounts rejects a sensitive host path and writes nothing", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.setHostMounts("u1", "app1", [{ hostPath: "/etc", containerPath: "/x" }])).rejects.toThrow(/protected system path/);
    expect(update).not.toHaveBeenCalled();
  });

  describe("setServiceDomains", () => {
    const composeApp = { ...app, source: "COMPOSE", domain: null, clusterId: null, tunnelExposed: false, certType: "le-http", certPem: null, certDomains: [], extraDomains: [], composeFile: "services:\n  api:\n    image: nginx\n  worker:\n    image: busybox" };
    function svcFor(appOver: Record<string, unknown> = {}) {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...composeApp, ...appOver }), findFirst: jest.fn().mockResolvedValue(null) },
        appServiceDomain: { findFirst: jest.fn().mockResolvedValue(null), deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn().mockResolvedValue([]),
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      return { svc: make(prisma, access, {} as AgentWsServer), prisma };
    }
    const row = (over = {}) => ({ service: "api", hostname: "api.example.com", port: 4000, ...over });

    it("persists rows for a compose app", async () => {
      const { svc, prisma } = svcFor();
      await svc.setServiceDomains("u1", "app1", [row()]);
      expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).toHaveBeenCalled();
    });
    it("rejects a non-compose app", async () => {
      await expect(svcFor({ source: "GIT" }).svc.setServiceDomains("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
    });
    it("rejects a service not in the stored compose file", async () => {
      await expect(svcFor().svc.setServiceDomains("u1", "app1", [row({ service: "ghost" })])).rejects.toBeInstanceOf(BadRequestException);
    });
    it("rejects a host already used by another app (service-domain clash)", async () => {
      const { svc, prisma } = svcFor();
      (prisma.appServiceDomain.findFirst as jest.Mock).mockResolvedValue({ id: "other" });
      await expect(svc.setServiceDomains("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
    });
    it("rejects a host equal to the primary domain", async () => {
      await expect(svcFor({ domain: "api.example.com" }).svc.setServiceDomains("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
    });
    it("rejects a clustered or tunnel-exposed app", async () => {
      await expect(svcFor({ clusterId: "c1" }).svc.setServiceDomains("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor({ tunnelExposed: true }).svc.setServiceDomains("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("setExtraDomains", () => {
    const domApp = { ...app, domain: "x.com", clusterId: null, tunnelExposed: false, certType: "le-http", certPem: null, certDomains: [], extraDomains: [] };
    function svcFor(appOver: Record<string, unknown>, findFirst = jest.fn().mockResolvedValue(null)) {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...domApp, ...appOver }), findFirst, update } } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      return { svc: make(prisma, access, {} as AgentWsServer), update, findFirst };
    }

    it("persists lowercased, deduped hosts and audits", async () => {
      const { svc, update } = svcFor({});
      await svc.setExtraDomains("u1", "app1", ["B.com", "b.com", "api.x.net"]);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { extraDomains: ["b.com", "api.x.net"] } }));
    });

    it("requires a primary domain", async () => {
      await expect(svcFor({ domain: null }).svc.setExtraDomains("u1", "app1", ["b.com"])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects clustered (swarm) apps", async () => {
      await expect(svcFor({ clusterId: "c1" }).svc.setExtraDomains("u1", "app1", ["b.com"])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a tunnel-exposed app", async () => {
      await expect(svcFor({ tunnelExposed: true }).svc.setExtraDomains("u1", "app1", ["b.com"])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a host equal to the primary or its www/bare counterpart", async () => {
      await expect(svcFor({ domain: "x.com" }).svc.setExtraDomains("u1", "app1", ["www.x.com"])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor({ domain: "www.x.com" }).svc.setExtraDomains("u1", "app1", ["x.com"])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a host already claimed by another app", async () => {
      const { svc } = svcFor({}, jest.fn().mockResolvedValue({ id: "other" }));
      await expect(svc.setExtraDomains("u1", "app1", ["b.com"])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an alias the uploaded custom cert does not cover", async () => {
      const { svc } = svcFor({ certType: "custom", certPem: "PEM", certDomains: ["x.com"] });
      await expect(svc.setExtraDomains("u1", "app1", ["b.com"])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("clearing the primary domain also clears the extras", async () => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...domApp, extraDomains: ["b.com"] }), update } } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      await make(prisma, access, {} as AgentWsServer).setDomain("u1", "app1", null);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ domain: null, extraDomains: [] }) }));
    });
  });

  it("setComposeFile rejects a non-compose app before any write", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setComposeFile("u1", "app1", "services:\n  web:\n    image: nginx\n"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setComposeFile rejects an unsafe (privileged) compose before any write", async () => {
    const update = jest.fn();
    const composeApp = { ...app, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx\n", templateSlug: null };
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(composeApp), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setComposeFile("u1", "app1", "services:\n  x:\n    image: nginx\n    privileged: true\n"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setComposeFile persists a safe compose (recomputing the web service)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const composeApp = { ...app, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx\n", templateSlug: null };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update },
      deployment: { findFirst: jest.fn().mockResolvedValue(null) }, // no active deploy
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const yaml = 'services:\n  web:\n    image: nginx\n    ports:\n      - "80"\n';
    await make(prisma, access, {} as AgentWsServer).setComposeFile("u1", "app1", yaml);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ composeFile: yaml }) }));
  });

  // ── setSource / setBuild (edit source & build after create) ──
  const gitApp = {
    ...app,
    source: "GIT",
    image: null,
    gitUrl: "https://github.com/acme/app.git",
    gitBranch: "main",
    gitSourceId: null,
    gitTokenEnc: "enc(tok)",
    gitSshKeyEnc: null,
    gitSshPublicKey: null,
    buildType: "NIXPACKS",
    dockerfilePath: null,
    buildCommand: null,
    outputDir: null,
    isPreview: false,
  };
  const noActiveDeploy = { findFirst: jest.fn().mockResolvedValue(null) };

  it("a linked git source's token overrides a stored personal access token in the deploy clone (precedence)", async () => {
    const run = async (gitSourceId: string | null) => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, gitSourceId }), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const commands: string[] = [];
      const agentWs = {
        cancelCommand: jest.fn(),
        sendCommand: jest.fn().mockImplementation(async (_s: string, c: string) => { commands.push(c); return { exitCode: 0, output: "ok" }; }),
      } as unknown as AgentWsServer;
      await make(prisma, access, agentWs).deploy("u1", "app1");
      await flushMicrotasks();
      return commands.join("\n");
    };
    const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
    // stored PAT only (the spec decrypts "enc(tok)" to itself in this harness)
    const pat = await run(null);
    expect(pat).toContain(b64("enc(tok)"));
    // a linked source wins: its minted token is cloned with, the PAT is never sent
    const linked = await run("gs1");
    expect(linked).toContain(b64("ghs_inst"));
    expect(linked).not.toContain(b64("enc(tok)"));
  });

  it("setSource rejects a COMPOSE app (use the compose-file endpoint)", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { image: "nginx" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setSource edits a git-compose app's branch + compose path, and rejects composePath on a pure GIT app", async () => {
    const update = jest.fn().mockResolvedValue({});
    const gc = { ...gitApp, source: "COMPOSE", composePath: "docker-compose.yml", composeFile: null };
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(gc), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { gitBranch: "release", composePath: "deploy/stack.yml" });
    expect(update.mock.calls[0][0].data).toMatchObject({ gitBranch: "release", composePath: "deploy/stack.yml" });
    // composePath on a pure GIT app is refused
    const gitPrisma = { application: { findUnique: jest.fn().mockResolvedValue(gitApp), update: jest.fn() }, deployment: noActiveDeploy } as unknown as PrismaService;
    await expect(make(gitPrisma, access, {} as AgentWsServer).setSource("u1", "app1", { composePath: "x.yml" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("setSource pins a commit, and clears a stale pin when the repo URL changes without re-pinning", async () => {
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    // pin a commit (no URL change)
    const update1 = jest.fn().mockResolvedValue({});
    const p1 = { application: { findUnique: jest.fn().mockResolvedValue(gitApp), update: update1 }, deployment: noActiveDeploy } as unknown as PrismaService;
    await make(p1, access, {} as AgentWsServer).setSource("u1", "app1", { gitCommit: "abc1234" });
    expect(update1.mock.calls[0][0].data.gitCommit).toBe("abc1234");
    // changing the URL (same host, so no token churn) without re-pinning clears the stale pin + warns
    const pinned = { ...gitApp, gitCommit: "abc1234" };
    const update2 = jest.fn().mockResolvedValue({});
    const p2 = { application: { findUnique: jest.fn().mockResolvedValue(pinned), update: update2 }, deployment: noActiveDeploy } as unknown as PrismaService;
    const res = await make(p2, access, {} as AgentWsServer).setSource("u1", "app1", { gitUrl: "https://github.com/acme/other.git" });
    expect(update2.mock.calls[0][0].data.gitCommit).toBeNull();
    expect(res.warnings).toContain("git_commit_cleared");
  });

  it("setBasicAuth bcrypt-hashes each password (Traefik-compatible) and never stores plaintext", async () => {
    const bcrypt = await import("bcryptjs");
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1" }), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setBasicAuth("u1", "app1", [{ user: "admin", password: "hunter2" }]);
    const stored = update.mock.calls[0][0].data.basicAuthUsers as { user: string; hash: string }[];
    expect(stored[0].user).toBe("admin");
    expect(stored[0].hash).toMatch(/^\$2[aby]\$/); // a bcrypt hash
    expect(JSON.stringify(stored)).not.toContain("hunter2"); // plaintext never stored
    expect(bcrypt.compareSync("hunter2", stored[0].hash)).toBe(true); // and it verifies
    // empty list clears it (JsonNull)
    await make(prisma, access, {} as AgentWsServer).setBasicAuth("u1", "app1", []);
    expect(update.mock.calls[1][0].data.basicAuthUsers).toBeDefined(); // JsonNull sentinel, not a {user,hash}[]
  });

  it("setRedirects stores the rule list verbatim and clears to JsonNull on an empty list", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1" }), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const rules = [{ regex: "^https://x.com/old$", replacement: "https://x.com/new/${1}", permanent: true }];
    await make(prisma, access, {} as AgentWsServer).setRedirects("u1", "app1", rules);
    expect(update.mock.calls[0][0].data.redirects).toEqual(rules); // stored verbatim (escaped only at deploy)
    // empty list clears it (JsonNull sentinel, not an array)
    await make(prisma, access, {} as AgentWsServer).setRedirects("u1", "app1", []);
    expect(Array.isArray(update.mock.calls[1][0].data.redirects)).toBe(false);
  });

  it("setRestartPolicy stores the policy and clears to null; refuses compose/cluster when setting", async () => {
    const update = jest.fn().mockResolvedValue({});
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1" }), update } } as unknown as PrismaService;
    await make(prisma, access, {} as AgentWsServer).setRestartPolicy("u1", "app1", "always");
    expect(update.mock.calls[0][0].data.restartPolicy).toBe("always");
    await make(prisma, access, {} as AgentWsServer).setRestartPolicy("u1", "app1", null); // clear → default
    expect(update.mock.calls[1][0].data.restartPolicy).toBeNull();
    // refused on a COMPOSE app when setting a non-null policy (classic docker-run concept)
    const composePrisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1", source: "COMPOSE" }), update: jest.fn() } } as unknown as PrismaService;
    await expect(make(composePrisma, access, {} as AgentWsServer).setRestartPolicy("u1", "app1", "always")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("setContainerPort stores the port for IMAGE/GIT and refuses COMPOSE", async () => {
    const update = jest.fn().mockResolvedValue({});
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1", source: "IMAGE" }), update } } as unknown as PrismaService;
    await make(prisma, access, {} as AgentWsServer).setContainerPort("u1", "app1", 3000);
    expect(update.mock.calls[0][0].data.containerPort).toBe(3000);
    // COMPOSE derives its web port from the YAML, so the setter must refuse it (edit would be a no-op)
    const composePrisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1", source: "COMPOSE" }), update: jest.fn() } } as unknown as PrismaService;
    await expect(make(composePrisma, access, {} as AgentWsServer).setContainerPort("u1", "app1", 3000)).rejects.toBeInstanceOf(BadRequestException);
    // a preview inherits its port from the parent, so a direct edit is refused
    const previewPrisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, teamId: "t1", source: "GIT", isPreview: true }), update: jest.fn() } } as unknown as PrismaService;
    await expect(make(previewPrisma, access, {} as AgentWsServer).setContainerPort("u1", "app1", 3000)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("upsertPreview drops the parent's preview-excluded env keys from the preview's env", async () => {
    const create = jest.fn().mockResolvedValue({ id: "pv1", teamId: "t1", serverId: "s1", source: "GIT", isPreview: true });
    const prisma = { application: { findFirst: jest.fn().mockResolvedValue(null), create } } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    // crypto mock: encrypt(s)=`enc(${s})`, decrypt=identity → parent.envEnc is readable as JSON.
    jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
    const parent = {
      id: "app1", name: "web", teamId: "t1", serverId: "s1", environmentId: "e1", source: "GIT", gitUrl: "https://github.com/u/r.git",
      previewEnabled: true, domain: "app.example.com",
      envEnc: JSON.stringify({ SECRET: "prod", API_URL: "https://x" }),
      previewExcludeKeys: ["SECRET"],
    } as unknown as Parameters<typeof svc.upsertPreview>[0];
    await svc.upsertPreview(parent, 7, "feature-7");
    const envEnc = create.mock.calls[0][0].data.envEnc as string;
    expect(envEnc).toContain("API_URL");
    expect(envEnc).not.toContain("SECRET"); // the prod secret never reaches the preview
  });

  it("upsertPreview re-syncs an existing preview's container port from the parent", async () => {
    const update = jest.fn().mockResolvedValue({ id: "pv1", teamId: "t1", serverId: "s1", source: "GIT", isPreview: true });
    const prisma = { application: { findFirst: jest.fn().mockResolvedValue({ id: "pv1", prNumber: 7 }), update } } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
    const parent = {
      id: "app1", name: "web", teamId: "t1", serverId: "s1", environmentId: "e1", source: "GIT", gitUrl: "https://github.com/u/r.git",
      previewEnabled: true, domain: "app.example.com", containerPort: 8080, envEnc: JSON.stringify({}),
    } as unknown as Parameters<typeof svc.upsertPreview>[0];
    await svc.upsertPreview(parent, 7, "feature-7");
    expect(update.mock.calls[0][0].data.containerPort).toBe(8080); // preview tracks the parent's (edited) port
  });

  it("upsertPreview evicts the oldest preview(s) when a new PR would exceed previewLimit", async () => {
    const create = jest.fn().mockResolvedValue({ id: "pv-new", teamId: "t1", serverId: "s1", source: "GIT" });
    // 3 existing previews (oldest first); limit 2 → a NEW one must leave room for itself → evict 2 oldest.
    const existingPreviews = [
      { id: "pv1", prNumber: 1 },
      { id: "pv2", prNumber: 2 },
      { id: "pv3", prNumber: 3 },
    ];
    const prisma = {
      application: {
        findFirst: jest.fn().mockResolvedValue(null), // no existing preview for THIS pr → it's new
        findMany: jest.fn().mockResolvedValue(existingPreviews),
        create,
      },
    } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
    const removed: number[] = [];
    jest.spyOn(svc, "removePreviewByPr").mockImplementation(async (_pid: string, pr: number) => { removed.push(pr); });
    const parent = { id: "app1", name: "web", teamId: "t1", serverId: "s1", environmentId: "e1", source: "GIT", gitUrl: "https://github.com/u/r.git", previewEnabled: true, domain: "app.example.com", previewLimit: 2, previewExcludeKeys: [] } as unknown as Parameters<typeof svc.upsertPreview>[0];
    await svc.upsertPreview(parent, 9, "feature-9");
    expect(removed).toEqual([1, 2]); // the two oldest evicted; newest (pr3) + the new pr9 remain = 2 (the cap)
    expect(create).toHaveBeenCalled();
  });

  it("generateGitSshKey works for a git-compose (ssh) app and rejects a non-git-sourced one", async () => {
    const update = jest.fn().mockResolvedValue({});
    const sshGc = { ...gitApp, source: "COMPOSE", composePath: "docker-compose.yml", composeFile: null, gitUrl: "git@github.com:u/r.git" };
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(sshGc), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const res = await make(prisma, access, {} as AgentWsServer).generateGitSshKey("u1", "app1");
    expect(res.publicKey).toMatch(/^ssh-ed25519 /);
    expect(update.mock.calls[0][0].data.gitSshPublicKey).toMatch(/^ssh-ed25519 /);
    // a pasted compose (no git) has no repo to key
    const pasted = { ...app, source: "COMPOSE", composePath: null, gitUrl: null };
    const p2 = { application: { findUnique: jest.fn().mockResolvedValue(pasted), update: jest.fn() } } as unknown as PrismaService;
    await expect(make(p2, access, {} as AgentWsServer).generateGitSshKey("u1", "app1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("setSource rejects a preview app", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, isPreview: true }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { gitBranch: "dev" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setSource (IMAGE) updates the image and rejects git fields", async () => {
    const update = jest.fn().mockResolvedValue({});
    const imageApp = { ...app, source: "IMAGE", image: "nginx", isPreview: false };
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(imageApp), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setSource("u1", "app1", { image: "nginx:1.27" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ image: "nginx:1.27" }) }));
    await expect(svc.setSource("u1", "app1", { gitUrl: "https://github.com/x/y.git" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("setSource (GIT) same-host url/branch edit keeps the stored token (no credential reset)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(gitApp), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const res = await make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { gitUrl: "https://github.com/acme/other.git", gitBranch: "dev" });
    expect(res.warnings).toEqual([]);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({ gitUrl: "https://github.com/acme/other.git", gitBranch: "dev" });
    expect(data.gitTokenEnc).toBeUndefined(); // untouched
  });

  it("setSource (GIT) host change clears the token and unlinks the GitHub App", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, gitSourceId: "gs1" }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const res = await make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { gitUrl: "https://gitlab.com/acme/app.git" });
    const data = update.mock.calls[0][0].data;
    expect(data.gitTokenEnc).toBeNull();
    expect(data.gitSourceId).toBeNull();
    expect(res.warnings).toEqual(expect.arrayContaining(["git_token_cleared", "git_source_unlinked"]));
  });

  it("setSource (GIT) switch to ssh clears the token and mints a deploy key", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(gitApp), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const res = await make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { gitUrl: "git@github.com:acme/app.git" });
    const data = update.mock.calls[0][0].data;
    expect(data.gitTokenEnc).toBeNull();
    expect(data.gitSshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(res.warnings).toEqual(expect.arrayContaining(["git_token_cleared", "ssh_key_generated"]));
  });

  it("setSource (GIT) rejects linking a GitHub App to a non-github host", async () => {
    const update = jest.fn();
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, gitUrl: "https://gitlab.com/acme/app.git" }), update },
      gitSource: { findUnique: jest.fn().mockResolvedValue({ id: "gs1", teamId: "t1" }) },
      deployment: noActiveDeploy,
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setSource("u1", "app1", { gitSourceId: "gs1" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setSource (GIT) links a Gitea source only to a repo on the instance host", async () => {
    const mk = (gitUrl: string) => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, gitUrl }), update },
        gitSource: { findUnique: jest.fn().mockResolvedValue({ id: "gs2", teamId: "t1", provider: "gitea", apiUrl: "https://git.example.com" }) },
        deployment: noActiveDeploy,
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      return { update, svc: make(prisma, access, {} as AgentWsServer) };
    };
    const ok = mk("https://git.example.com/acme/app.git");
    await ok.svc.setSource("u1", "app1", { gitSourceId: "gs2" });
    expect(ok.update.mock.calls[0][0].data.gitSourceId).toBe("gs2");
    const bad = mk("https://github.com/acme/app.git"); // a Gitea token must never be sent to github.com
    await expect(bad.svc.setSource("u1", "app1", { gitSourceId: "gs2" })).rejects.toThrow(/only authenticates git\.example\.com/);
    expect(bad.update).not.toHaveBeenCalled();
  });

  it("setBuild rejects a non-GIT app", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "IMAGE", isPreview: false }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setBuild("u1", "app1", { buildType: "DOCKERFILE" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setBuild DOCKERFILE sets the path and clears STATIC fields", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, buildType: "STATIC", buildCommand: "npm run build", outputDir: "dist" }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setBuild("u1", "app1", { buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile", dockerBuildTarget: null, buildCommand: null, outputDir: null, nixpacksInstallCmd: null, nixpacksBuildCmd: null, nixpacksStartCmd: null, baseDirectory: null } }));
  });

  it("setBuild STATIC sets command/output and clears the dockerfile path", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, buildType: "DOCKERFILE", dockerfilePath: "Dockerfile" }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setBuild("u1", "app1", { buildType: "STATIC", buildCommand: "npm run build", outputDir: "build" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { buildType: "STATIC", dockerfilePath: null, dockerBuildTarget: null, buildCommand: "npm run build", outputDir: "build", nixpacksInstallCmd: null, nixpacksBuildCmd: null, nixpacksStartCmd: null, baseDirectory: null, buildSecretsEnc: null, injectEnvAsBuildArgs: false } })); // leaving Dockerfile drops the build secrets
  });

  it("setBuild NIXPACKS persists the command overrides (and a non-nixpacks type clears them)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, buildType: "NIXPACKS" }), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setBuild("u1", "app1", { buildType: "NIXPACKS", nixpacksInstallCmd: "npm ci", nixpacksBuildCmd: "npm run build", nixpacksStartCmd: "node server.js" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ buildType: "NIXPACKS", nixpacksInstallCmd: "npm ci", nixpacksBuildCmd: "npm run build", nixpacksStartCmd: "node server.js" }) }));
    await svc.setBuild("u1", "app1", { buildType: "DOCKERFILE", dockerfilePath: "Dockerfile" });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ buildType: "DOCKERFILE", nixpacksInstallCmd: null, nixpacksBuildCmd: null, nixpacksStartCmd: null }) }));
  });

  it("setBuild persists the monorepo baseDirectory and clears it when omitted (replace semantics)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(gitApp), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setBuild("u1", "app1", { buildType: "NIXPACKS", baseDirectory: "apps/api" });
    expect(update.mock.calls[0][0].data).toMatchObject({ buildType: "NIXPACKS", baseDirectory: "apps/api" });
    await svc.setBuild("u1", "app1", { buildType: "NIXPACKS" });
    expect(update.mock.calls[1][0].data.baseDirectory).toBeNull(); // omitted -> cleared
  });

  describe("setConfigMountsForImport", () => {
    const composeApp = { ...app, source: "COMPOSE", gitUrl: null, configMounts: null, composeFile: "services:\n  signoz:\n    image: a:1\n  clickhouse:\n    image: b:1\n" };
    const mount = (over = {}) => ({ serviceName: "signoz", target: "/root/config/prometheus.yml", content: "scrape: {}\n", ...over });
    function svcFor(appOver: Record<string, unknown> = {}, deployments = 0) {
      const update = jest.fn().mockResolvedValue({});
      const log = jest.fn().mockResolvedValue(undefined);
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...composeApp, ...appOver }), update },
        deployment: { count: jest.fn().mockResolvedValue(deployments) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const svc = make(prisma, access, {} as AgentWsServer);
      (svc as unknown as { audit: { log: jest.Mock } }).audit = { log };
      return { svc, update, log };
    }

    it("seeds the mounts of a never-deployed stored-compose app and audits size + sha256 only", async () => {
      const { svc, update, log } = svcFor();
      await svc.setConfigMountsForImport("u1", "app1", [mount(), mount({ serviceName: "clickhouse", target: "/etc/c.xml", mode: "0640", content: "<x/>" })]);
      expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { configMounts: [{ serviceName: "signoz", target: "/root/config/prometheus.yml", content: "scrape: {}\n" }, { serviceName: "clickhouse", target: "/etc/c.xml", content: "<x/>", mode: "0640" }] } });
      const meta = log.mock.calls[0][0].meta;
      expect(log.mock.calls[0][0].action).toBe("app.config_mounts.import");
      expect(Object.keys(meta).sort()).toEqual(["bytes", "count", "sha256"]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("scrape");
    });
    it("is idempotent for an equal retry and refuses different existing mounts", async () => {
      const same = [{ serviceName: "signoz", target: "/root/config/prometheus.yml", content: "scrape: {}\n" }];
      const a = svcFor({ configMounts: same });
      await a.svc.setConfigMountsForImport("u1", "app1", [mount()]);
      expect(a.update).not.toHaveBeenCalled();
      const b = svcFor({ configMounts: [{ serviceName: "signoz", target: "/other", content: "x" }] });
      await expect(b.svc.setConfigMountsForImport("u1", "app1", [mount()])).rejects.toBeInstanceOf(BadRequestException);
    });
    it("rejects a deployed app, a non-compose or git-compose app, a bad target/service/mode, over-cap and duplicates", async () => {
      await expect(svcFor({}, 1).svc.setConfigMountsForImport("u1", "app1", [mount()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor({ source: "GIT" }).svc.setConfigMountsForImport("u1", "app1", [mount()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor({ gitUrl: "https://x/y.git" }).svc.setConfigMountsForImport("u1", "app1", [mount()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount({ target: "relative/x" })])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount({ target: "/a/../b" })])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount({ serviceName: "ghost" })])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount({ serviceName: "a b" })])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount({ mode: "rwx" })])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount(), mount()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", [mount({ content: "x".repeat(256 * 1024 + 1) })])).rejects.toBeInstanceOf(BadRequestException);
      const many = Array.from({ length: 17 }, (_, i) => mount({ target: `/f/${i}` }));
      await expect(svcFor().svc.setConfigMountsForImport("u1", "app1", many)).rejects.toBeInstanceOf(BadRequestException);
    });
    it("is not reachable from any controller route", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "applications.controller.ts"), "utf8") as string;
      expect(src).not.toContain("setConfigMountsForImport");
    });
  });

  describe("setComposeNetworks", () => {
    const composeApp = { ...app, source: "COMPOSE", gitUrl: null, clusterId: null, composeFile: "services:\n  meilisearch:\n    image: a:1\n" };
    function svcFor(appOver: Record<string, unknown> = {}) {
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...composeApp, ...appOver }), update },
        deployment: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const svc = make(prisma, access, {} as AgentWsServer);
      const log = jest.fn().mockResolvedValue(undefined);
      (svc as unknown as { audit: { log: jest.Mock } }).audit = { log };
      return { svc, update, log };
    }
    const row = (over = {}) => ({ network: "svc-search", service: "meilisearch", aliases: ["meilisearch"], ...over });

    it("persists the rows and audits", async () => {
      const { svc, update, log } = svcFor();
      await svc.setComposeNetworks("u1", "app1", [row()]);
      expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { composeNetworks: [row()] } });
      expect(log.mock.calls[0][0]).toMatchObject({ action: "app.compose_networks.update", meta: { count: 1, networks: ["svc-search"] } });
    });
    it("an empty list clears the column", async () => {
      const { svc, update } = svcFor({ composeNetworks: [row()] });
      await svc.setComposeNetworks("u1", "app1", []);
      expect(update.mock.calls[0][0].data.composeNetworks).toBeDefined();
      expect(await svc.listComposeNetworks("u1", "app1")).toEqual([row()]);
    });
    it("rejects non-compose, git-compose, clustered and unknown-service rows", async () => {
      await expect(svcFor({ source: "IMAGE" }).svc.setComposeNetworks("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor({ gitUrl: "https://x/y.git" }).svc.setComposeNetworks("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor({ clusterId: "c1" }).svc.setComposeNetworks("u1", "app1", [row()])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svcFor().svc.setComposeNetworks("u1", "app1", [row({ service: "ghost" })])).rejects.toBeInstanceOf(BadRequestException);
    });
    it("toSpec carries the rows for a stored compose app", () => {
      const { svc } = svcFor();
      const spec = (svc as unknown as { toSpec: (a: unknown) => { composeNetworks: unknown } }).toSpec({ ...composeApp, composeNetworks: [row()] });
      expect(spec.composeNetworks).toEqual([row()]);
    });
  });

  it("setConfigMountContent rejects a non-compose app before any write", async () => {
    const update = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setConfigMountContent("u1", "app1", "/etc/app.conf", "x"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setConfigMountContent 404s on an unknown target and never appends a mount (immutability)", async () => {
    const update = jest.fn();
    const composeApp = { ...app, source: "COMPOSE", configMounts: [{ serviceName: "redis", target: "/etc/redis.conf", content: "a", mode: "0600" }] };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update },
      deployment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setConfigMountContent("u1", "app1", "/etc/other.conf", "x"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setConfigMountContent replaces ONLY content, keeps serviceName/target/mode/order, audits no content", async () => {
    const update = jest.fn().mockResolvedValue({});
    const composeApp = {
      ...app,
      source: "COMPOSE",
      configMounts: [
        { serviceName: "redis", target: "/etc/redis.conf", content: "requirepass ${REDIS_PASSWORD}", mode: "0600" },
        { serviceName: "redis", target: "/x", content: "b" },
      ],
    };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update },
      deployment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setConfigMountContent("u1", "app1", "/etc/redis.conf", "appendonly yes\n");
    expect(update).toHaveBeenCalledWith({
      where: { id: "app1" },
      data: {
        configMounts: [
          { serviceName: "redis", target: "/etc/redis.conf", content: "appendonly yes\n", mode: "0600" },
          { serviceName: "redis", target: "/x", content: "b" },
        ],
      },
    });
    const call = (audit.log as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e?.action === "app.config_mount.update");
    expect(call).toMatchObject({ target: "app1", meta: { target: "/etc/redis.conf", bytes: "appendonly yes\n".length } });
    expect(JSON.stringify(call?.meta)).not.toContain("appendonly"); // content is never audited
  });

  it("setConfigMountContent refuses while a deploy is running and does not write", async () => {
    const update = jest.fn();
    const composeApp = { ...app, source: "COMPOSE", configMounts: [{ serviceName: "redis", target: "/etc/redis.conf", content: "a" }] };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update },
      deployment: { findFirst: jest.fn().mockResolvedValue({ id: "running", status: "RUNNING" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setConfigMountContent("u1", "app1", "/etc/redis.conf", "x"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setConfigMountContent rejects a path-guard-failing target before any read-modify-write", async () => {
    const update = jest.fn();
    const composeApp = { ...app, source: "COMPOSE", configMounts: [{ serviceName: "redis", target: "/etc/redis.conf", content: "a" }] };
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(composeApp), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    for (const badTarget of ["../etc/passwd", "relative/x", "/etc/x:/y"]) {
      await expect(
        make(prisma, access, {} as AgentWsServer).setConfigMountContent("u1", "app1", badTarget, "x"),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("listConfigMounts returns a compose app's mounts and rejects a non-compose app", async () => {
    const mounts = [{ serviceName: "redis", target: "/etc/redis.conf", content: "a", mode: "0600" }];
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const okPrisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", configMounts: mounts }) } } as unknown as PrismaService;
    await expect(make(okPrisma, access, {} as AgentWsServer).listConfigMounts("u1", "app1")).resolves.toEqual(mounts);
    const imgPrisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    await expect(make(imgPrisma, access, {} as AgentWsServer).listConfigMounts("u1", "app1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("stores build args encrypted on setBuildArgs", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setBuildArgs("u1", "app1", { API_URL: "x" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { buildArgsEnc: 'enc({"API_URL":"x"})' } }),
    );
  });

  it("build secrets: stored encrypted (null when emptied), Dockerfile-GIT only, audited by KEY only", async () => {
    const update = jest.fn().mockResolvedValue({});
    const mk = (over: Record<string, unknown>) =>
      make(
        { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "GIT", buildType: "DOCKERFILE", ...over }), update } } as unknown as PrismaService,
        { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService,
        {} as AgentWsServer,
      );
    await mk({}).setBuildSecrets("u1", "app1", { NPM_TOKEN: "npm_x" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { buildSecretsEnc: 'enc({"NPM_TOKEN":"npm_x"})' } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.build_secrets.update", meta: { keys: ["NPM_TOKEN"] } }));
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls.at(-1))).not.toContain("npm_x");
    await mk({}).setBuildSecrets("u1", "app1", {});
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { buildSecretsEnc: null } }));
    await expect(mk({ buildType: "NIXPACKS" }).setBuildSecrets("u1", "app1", { A: "b" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ source: "IMAGE" }).setBuildSecrets("u1", "app1", { A: "b" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ buildType: "NIXPACKS" }).setBuildSecrets("u1", "app1", {})).resolves.toBeUndefined(); // clearing is always allowed
  });

  it("getBuildSecrets is writer-only and decrypts the stored map ({} when none / undecryptable)", async () => {
    const mk = (row: Record<string, unknown>, perm = jest.fn().mockResolvedValue(undefined)) =>
      make({ application: { findUnique: jest.fn().mockResolvedValue({ ...app, ...row }) } } as unknown as PrismaService, { requirePermission: perm } as unknown as TeamAccessService, {} as AgentWsServer);
    expect(await mk({ buildSecretsEnc: '{"A":"b"}' }).getBuildSecrets("u1", "app1")).toEqual({ A: "b" });
    expect(await mk({ buildSecretsEnc: null }).getBuildSecrets("u1", "app1")).toEqual({});
    expect(await mk({ buildSecretsEnc: "not-json" }).getBuildSecrets("u1", "app1")).toEqual({});
    await expect(mk({}, jest.fn().mockRejectedValue(new ForbiddenException("nope"))).getBuildSecrets("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a deploy hydrates the stored build secrets into the Dockerfile build (mount flags, never the plaintext as a build arg)", async () => {
    const dockerApp = { ...app, source: "GIT", gitUrl: "https://github.com/acme/app.git", gitBranch: "main", buildType: "DOCKERFILE", image: null, buildSecretsEnc: '{"NPM_TOKEN":"npm_x"}' };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(dockerApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(sentCmd).toContain('--secret id=NPM_TOKEN,src="$sd/bs_NPM_TOKEN"');
    expect(sentCmd).toContain("DOCKER_BUILDKIT=1 docker build");
    expect(sentCmd).not.toContain("--build-arg 'NPM_TOKEN");
    expect(sentCmd).not.toContain("npm_x");
  });

  it("forbids a non-writer from setting resource limits", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setLimits("u1", "app1", { memoryMb: 256 }),
    ).rejects.toThrow(/nope/);
  });

  it("persists resource limits for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setLimits("u1", "app1", { memoryMb: 256, cpus: 0.5, gpus: "all", deployTimeoutSec: 600 });
    // Omitted reserve fields are left untouched (undefined-means-keep), not nulled.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { memoryMb: 256, cpus: 0.5, gpus: "all", deployTimeoutSec: 600 } }),
    );
  });

  it("setLimits accepts gpus on a server whose inventory says no GPU, with no server lookup (advisory UI only)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const serverFind = jest.fn();
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update }, server: { findUnique: serverFind } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setLimits("u1", "app1", { gpus: "all" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { gpus: "all" } }));
    expect(serverFind).not.toHaveBeenCalled();
  });

  it("setLimits leaves omitted limits untouched (partial update can't wipe)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setLimits("u1", "app1", { cpus: 1 });
    expect(update.mock.calls[0][0].data).toEqual({ cpus: 1 });
  });

  it("setHealthCheck leaves omitted type/path/port untouched (partial update can't wipe)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setHealthCheck("u1", "app1", { interval: 10 });
    const data = update.mock.calls[0][0].data;
    expect(data).toEqual({ healthInterval: 10 });
    expect("healthCheckType" in data).toBe(false);
    expect("healthCheckPath" in data).toBe(false);
    expect("healthCheckPort" in data).toBe(false);
  });

  it("persists swarm resource reservations", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setLimits("u1", "app1", { memoryMb: 256, reserveMemoryMb: 128, reserveCpus: 0.25 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reserveMemoryMb: 128, reserveCpus: 0.25 }) }),
    );
  });

  it("persists an HTTP health-check config WITHOUT touching healthCmd (no silent wipe)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setHealthCheck("u1", "app1", { type: "HTTP", path: "/healthz", port: 9000, command: null });
    // a non-CMD save leaves an existing healthCmd intact — the update omits it entirely
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { healthCheckType: "HTTP", healthCheckPath: "/healthz", healthCheckPort: 9000 } }),
    );
    const data = update.mock.calls[0][0].data;
    expect("healthCmd" in data).toBe(false);
  });

  it("a CMD health-check writes healthCmd from the command", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setHealthCheck("u1", "app1", { type: "CMD", command: "pg_isready" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ healthCheckType: "CMD", healthCmd: "pg_isready" }) }),
    );
  });

  it("an explicit Automatic (type null) save writes null and clears a leftover healthCmd (else auto resolves back to CMD)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, healthCheckType: "CMD", healthCmd: "pg_isready" }), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setHealthCheck("u1", "app1", { type: null, command: null });
    const data = update.mock.calls[0][0].data;
    expect(data.healthCheckType).toBeNull();
    expect(data.healthCmd).toBeNull();
  });

  it("setBuildConfig rejects a registry from another team (no cross-team credential use)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn() },
      registry: { findUnique: jest.fn().mockResolvedValue({ id: "reg1", teamId: "OTHER" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setBuildConfig("u1", "app1", { registryId: "reg1", pushToRegistry: true })).rejects.toThrow(
      /registry not found in this team/,
    );
  });

  it("setDeploySettings persists the strategy + rollback toggle for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setDeploySettings("u1", "app1", { deployStrategy: "RECREATE", rollbackOnFailure: false });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deployStrategy: "RECREATE", rollbackOnFailure: false } }),
    );
  });

  it("setDeploySettings persists imagesToKeep and leaves it untouched when omitted", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setDeploySettings("u1", "app1", { imagesToKeep: 3 });
    expect(update.mock.calls[0][0].data).toEqual({ imagesToKeep: 3 });
    // an update that omits imagesToKeep must not touch the column
    await svc.setDeploySettings("u1", "app1", { rollbackOnFailure: true });
    expect("imagesToKeep" in update.mock.calls[1][0].data).toBe(false);
  });

  it("setDeploySettings threads postCutoverSoakSec (undefined-means-keep: a partial update never wipes it)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    // explicit set (0 = off is a legitimate value and IS written)
    await svc.setDeploySettings("u1", "app1", { postCutoverSoakSec: 45 });
    expect(update.mock.calls[0][0].data).toEqual({ postCutoverSoakSec: 45 });
    await svc.setDeploySettings("u1", "app1", { postCutoverSoakSec: 0 });
    expect(update.mock.calls[1][0].data).toEqual({ postCutoverSoakSec: 0 });
    // a partial update that omits the soak must not touch the column
    await svc.setDeploySettings("u1", "app1", { imagesToKeep: 3 });
    expect("postCutoverSoakSec" in update.mock.calls[2][0].data).toBe(false);
  });

  it("setBuildConfig rejects a build server with no registry configured", async () => {
    const noRegApp = { ...app, registryId: null };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(noRegApp), update: jest.fn() },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setBuildConfig("u1", "app1", { buildServerId: "s1" })).rejects.toThrow(
      /build server requires a registry/,
    );
  });

  it("setBuildConfig rejects a cross-team build server", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, registryId: "reg1" }), update: jest.fn() },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s9", teamId: "OTHER" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setBuildConfig("u1", "app1", { buildServerId: "s9" })).rejects.toThrow(
      /build server not found in this team/,
    );
  });

  it("setBuildConfig with a valid build server forces pushToRegistry on (deploy server pulls the image)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, registryId: "reg1" }), update },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setBuildConfig("u1", "app1", { buildServerId: "s1" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ buildServerId: "s1", pushToRegistry: true }) }));
  });

  it("a deploy with a build server builds+pushes on IT, then pulls+runs on the deploy server", async () => {
    const bsApp = { ...app, image: "nginx:alpine", registryId: "reg1", pushToRegistry: true, buildServerId: "bs1" };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(bsApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      registry: { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const calls: { server: string; cmd: string }[] = [];
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((server: string, cmd: string, cap: string) => {
        if (cap === "deploy") calls.push({ server, cmd });
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    // phase 1: build + push on the build server (no run)
    expect(calls[0].server).toBe("bs1");
    expect(calls[0].cmd).toContain("docker push 'ghcr.io/org/tugra_app1:d1'");
    expect(calls[0].cmd).not.toContain("docker run -d");
    // phase 2: pull + run on the deploy server (no build/push)
    expect(calls[1].server).toBe("s1");
    expect(calls[1].cmd).toContain("docker pull 'ghcr.io/org/tugra_app1:d1'");
    expect(calls[1].cmd).toContain("docker run -d --name tugra_app1");
    expect(calls[1].cmd).not.toContain("docker push");
  });

  it("records the digest from the BUILD server output when a build server is used (marker lives in buildLog)", async () => {
    const bsApp = { ...app, image: "nginx:alpine", registryId: "reg1", pushToRegistry: true, buildServerId: "bs1" };
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(bsApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      registry: { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      // the build server (bs1) echoes the marker; the deploy server (registryPull path) does not.
      sendCommand: jest.fn().mockImplementation((server: string) =>
        Promise.resolve({ exitCode: 0, output: server === "bs1" ? "built\nTUGRA_DIGEST=nginx@sha256:bsdigest" : "pulled+ran" }),
      ),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ imageDigest: "nginx@sha256:bsdigest" }) }));
  });

  it("a build-server build failure persists the real build output (not just a generic message)", async () => {
    const bsApp = { ...app, image: "nginx:alpine", registryId: "reg1", pushToRegistry: true, buildServerId: "bs1" };
    const depUpdate = jest.fn().mockResolvedValue({});
    let deployTarget = "";
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(bsApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      registry: { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      // the build server (bs1) fails the build; the deploy server (s1) is never reached
      sendCommand: jest.fn().mockImplementation((server: string) => {
        deployTarget = server;
        return Promise.resolve({ exitCode: 1, output: "Step 5/9 : RUN npm ci\n npm ERR! missing script: build" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(deployTarget).toBe("bs1"); // only the build server was contacted
    // the durable deployment record carries the actual build error, not a generic string
    const failCall = depUpdate.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(failCall![0].data.logs).toContain("npm ERR! missing script: build");
  });

  it("a deploy pushes the built image to the app's registry when pushToRegistry is set", async () => {
    const pushApp = { ...app, image: "nginx:alpine", registryId: "reg1", pushToRegistry: true };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(pushApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      registry: {
        findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    // the built image is tagged + pushed to ghcr.io/org/tugra_app1:d1 (deployment id = version)
    expect(sentCmd).toContain("docker push 'ghcr.io/org/tugra_app1:d1'");
    // registry scoped to the app's own team
    expect((prisma.registry.findFirst as jest.Mock).mock.calls[0][0]).toEqual({ where: { id: "reg1", teamId: "t1" } });
  });

  it("applies the per-app deploy timeout (default 300s)", async () => {
    const mk = (timeoutSec: number | null) => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, deployTimeoutSec: timeoutSec }), update: jest.fn().mockResolvedValue({}) },
        deployment: { create: jest.fn().mockResolvedValue({ id: "d1" }), update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ id: "d1" }), findFirst: jest.fn().mockResolvedValue(null) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined), membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
      const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "deployed" });
      return { svc: make(prisma, access, { sendCommand } as unknown as AgentWsServer), sendCommand };
    };
    const custom = mk(600);
    await custom.svc.deploy("u1", "app1");
    expect(custom.sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "deploy", 600000, expect.any(Function), expect.any(Function));
    const def = mk(null);
    await def.svc.deploy("u1", "app1");
    expect(def.sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "deploy", 300000, expect.any(Function), expect.any(Function));
  });

  it("rejects an unknown template slug", async () => {
    const svc = make({} as PrismaService, {} as TeamAccessService, {} as AgentWsServer);
    await expect(svc.createFromTemplate("u1", "nope", { name: "x", serverId: "s1" })).rejects.toThrow(
      /template not found/,
    );
  });

  it("creates a COMPOSE app from a template with generated secrets in env", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).createFromTemplate("u1", "wordpress", {
      name: "blog",
      serverId: "s1",
    });
    const data = create.mock.calls[0][0].data;
    expect(data.source).toBe("COMPOSE");
    expect(data.composeFile).toContain("services:");
    // env (encrypted in the test crypto stub: enc(<json>)) carries the generated secret
    expect(data.envEnc).toContain("DB_PASSWORD");
    // No environment chosen -> resolved to the team default, never null.
    expect(data.environmentId).toBe("env-default");
  });

  it("a template-installed compose app is created with soak 0 (compose never rolls)", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).createFromTemplate("u1", "wordpress", { name: "blog", serverId: "s1" });
    expect(create.mock.calls[0][0].data.postCutoverSoakSec).toBe(0);
  });

  function templatePrisma() {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...app, ...data, id: "tpl1" }));
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    return { prisma, access, create };
  }
  const svcWithAlloc = (prisma: PrismaService, access: TeamAccessService, portAlloc: { allocate: jest.Mock; probeUsedPorts?: jest.Mock }) =>
    make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, portAlloc);

  it("v2: allocates a fresh host port, rewrites the baked compose, and persists portMappings", async () => {
    const { prisma, access, create } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500]), probeUsedPorts: jest.fn().mockResolvedValue(new Set([21000])) };
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "activepieces", { name: "ap", serverId: "s1" });
    // The probe runs OUTSIDE the tx and its result is passed into allocate (4th arg) — allocate never
    // does a network round-trip inside the transaction.
    expect(portAlloc.probeUsedPorts).toHaveBeenCalledWith("s1");
    expect(portAlloc.allocate).toHaveBeenCalledWith("s1", 1, expect.anything(), expect.any(Set));
    const data = create.mock.calls[0][0].data;
    expect(data.composeFile).toContain("20500:80"); // baked host port rewritten to the allocated one
    expect(data.portMappings).toEqual([{ serviceName: "activepieces", containerPort: 80, hostPort: 20500, mode: "domain" }]);
  });

  it("v2: installing the same template twice yields DISTINCT published ports (no collision)", async () => {
    const first = templatePrisma();
    const second = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValueOnce([20500]).mockResolvedValueOnce([20501]) };
    await svcWithAlloc(first.prisma, first.access, portAlloc).createFromTemplate("u1", "activepieces", { name: "ap-a", serverId: "s1" });
    await svcWithAlloc(second.prisma, second.access, portAlloc).createFromTemplate("u1", "activepieces", { name: "ap-b", serverId: "s1" });
    expect(first.create.mock.calls[0][0].data.composeFile).toContain("20500:80");
    expect(second.create.mock.calls[0][0].data.composeFile).toContain("20501:80");
    expect(first.create.mock.calls[0][0].data.portMappings[0].hostPort).not.toBe(
      second.create.mock.calls[0][0].data.portMappings[0].hostPort,
    );
  });

  it("v2: a user field value overrides the generated secret and lands (encrypted) in env", async () => {
    const { prisma, access, create } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500, 20501]) };
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "wordpress", {
      name: "blog",
      serverId: "s1",
      fields: { DB_PASSWORD: "topsecret-user-value" },
    });
    const data = create.mock.calls[0][0].data;
    // env is encrypted via the crypto stub (enc(<json>)); the user's override is in it.
    expect(data.envEnc).toContain("topsecret-user-value");
  });

  it("v2: installConfig never stores a secret field's value (SPEC §8 redaction)", async () => {
    const { prisma, access, create } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500, 20501]) };
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "wordpress", {
      name: "blog",
      serverId: "s1",
      fields: { DB_PASSWORD: "topsecret-user-value" },
    });
    const data = create.mock.calls[0][0].data;
    // DB_PASSWORD is a secret field → dropped from installConfig entirely (never the plaintext value).
    const ic = JSON.stringify(data.installConfig ?? null);
    expect(ic).not.toContain("topsecret-user-value");
  });

  it("v2: persists a template's config mounts with the ${KEY} placeholder (resolved secret stays in envEnc only)", async () => {
    const { prisma, access, create } = templatePrisma();
    // redis is portless → no exposures → allocate is never called.
    const portAlloc = { allocate: jest.fn() };
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "redis", { name: "cache", serverId: "s1" });
    const data = create.mock.calls[0][0].data;
    expect(portAlloc.allocate).not.toHaveBeenCalled();
    // The mount body is persisted with the ${REDIS_PASSWORD} placeholder, NOT the resolved secret.
    expect(data.configMounts).toEqual([
      { serviceName: "redis", target: "/usr/local/etc/redis/redis.conf", content: "appendonly yes\nrequirepass ${REDIS_PASSWORD}\n", mode: "0644" },
    ]);
    // The resolved secret exists only in the encrypted env, never in configMounts (secret-at-rest).
    expect(data.envEnc).toContain("REDIS_PASSWORD");
    expect(JSON.stringify(data.configMounts)).not.toContain("REDIS_PASSWORD=");
  });

  it("v2: persists no config mounts for a template that has none (regression)", async () => {
    const { prisma, access, create } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500, 20501]) };
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "wordpress", { name: "blog", serverId: "s1" });
    // no mounts → configMounts set to Prisma.JsonNull (not an array of mount objects).
    expect(Array.isArray(create.mock.calls[0][0].data.configMounts)).toBe(false);
  });

  it("v2: still resolves the team-default environment and enforces RBAC", async () => {
    const { prisma, access, create } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500]) };
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "activepieces", { name: "ap", serverId: "s1" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(create.mock.calls[0][0].data.environmentId).toBe("env-default");
  });

  it("getTemplateManifest returns field defs but no composeFile (no serverId) and no secret values", async () => {
    const svc = make({} as PrismaService, {} as TeamAccessService, {} as AgentWsServer);
    const m = await svc.getTemplateManifest("u1", "wordpress");
    expect(m.slug).toBe("wordpress");
    expect(Array.isArray(m.fields)).toBe(true); // typed field definitions
    expect(m.composeFile).toBeUndefined(); // no serverId → no compose
    // fields are DEFINITIONS (key/type/label/generate), never a resolved `value`
    for (const f of m.fields ?? []) expect(f).not.toHaveProperty("value");
    expect(m).not.toHaveProperty("secrets");
    await expect(svc.getTemplateManifest("u1", "nope")).rejects.toThrow(/not found/);
  });

  it("getTemplateManifest includes the composeFile when the caller can write to the server's team", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue({ teamId: "t1" }) } } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const m = await make(prisma, access, {} as AgentWsServer).getTemplateManifest("u1", "wordpress", "s1");
    expect(m.composeFile).toContain("services:");
  });

  it("v2: rejects a compose override that would escape the container (privileged)", async () => {
    const { prisma, access } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500]) };
    await expect(
      svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "activepieces", {
        name: "ap",
        serverId: "s1",
        composeOverride: "services:\n  app:\n    image: nginx\n    privileged: true\n    ports:\n      - \"20001:80\"\n",
      }),
    ).rejects.toThrow(/disallowed directive/);
  });

  it("v2: uses a safe compose override + layers envOverride last, and audits the override", async () => {
    const { prisma, access, create } = templatePrisma();
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500]) };
    (audit.log as jest.Mock).mockClear();
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "activepieces", {
      name: "ap",
      serverId: "s1",
      composeOverride: 'services:\n  custom:\n    image: myimage\n    ports:\n      - "20001:80"\n',
      envOverride: { CUSTOM_KEY: "custom-value" },
    });
    const data = create.mock.calls[0][0].data;
    expect(data.composeFile).toContain("myimage"); // the override was used, not the template compose
    expect(data.composeFile).toContain("20500:80"); // ports still allocated/rewritten
    expect(data.envEnc).toContain("custom-value"); // envOverride layered into the encrypted env
    // the override is audited (that it happened + which env keys, never their values)
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.template.override" }));
    const overrideCall = (audit.log as jest.Mock).mock.calls.find((c) => c[0].action === "app.template.override");
    expect(JSON.stringify(overrideCall?.[0].meta)).not.toContain("custom-value"); // no secret values logged
  });

  it("generates a magic sslip.io domain when the server has a public IP", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "IMAGE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null,
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", { name: "My App", serverId: "s1", image: "nginx" });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toMatch(/^my-app-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);
    expect(data.domainKind).toBe("magic");
    expect(data.exposeMode).toBe("magic");
    expect(data.certType).toBe("http"); // magic is served over plain HTTP
    expect(data.https).toBe(false);
  });

  it("leaves an app domainless when the server has no public IP (magic impossible)", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "IMAGE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: "10.0.0.5", publicIpv6: null, wildcardDomain: null, magicSuffix: null,
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", { name: "web", serverId: "s1", image: "nginx" });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toBeNull();
    expect(data.domainKind).toBe("none");
  });

  it("generates a magic domain for a template (Compose) app whose web service is known", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null,
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).createFromTemplate("u1", "wordpress", { name: "blog", serverId: "s1" });
    const data = create.mock.calls[0][0].data;
    // wordpress publishes a port → its web service is resolvable → magic applies.
    expect(data.domain).toMatch(/^blog-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);
    expect(data.domainKind).toBe("magic");
  });

  it("createFromTemplate swaps the baked localhost self-URLs for the magic domain", async () => {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...app, ...data, id: "tpl1" }));
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    const portAlloc = { allocate: jest.fn().mockResolvedValue([20500]) };
    // activepieces is a generated template WITH exposure + baked `localhost:<port>` self-URLs.
    await svcWithAlloc(prisma, access, portAlloc).createFromTemplate("u1", "activepieces", { name: "ap", serverId: "s1" });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toMatch(/^ap-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);
    expect(data.composeFile).not.toContain("localhost:20500"); // baked self-URL host swapped
    expect(data.composeFile).toContain(data.domain); // → the magic domain
  });

  it("leaves a Compose app domainless when no web service can be resolved", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null,
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    // A raw Compose stack with no published port → no web service → no magic.
    await make(prisma, access, {} as AgentWsServer).create("u1", {
      name: "worker", serverId: "s1", source: "COMPOSE", composeFile: "services:\n  db:\n    image: postgres",
    });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toBeNull();
    expect(data.domainKind).toBe("none");
  });

  it("treats a user-provided domain as custom and keeps it on HTTPS", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "IMAGE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null,
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", {
      name: "web", serverId: "s1", image: "nginx", domain: "app.example.com", https: false,
    });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toBe("app.example.com");
    expect(data.domainKind).toBe("custom");
    expect(data.certType).toBe("le-http");
    // A custom domain is forced onto HTTPS even if the caller passed https:false,
    // so the stored scheme matches certType le-http (no http:// vs served-HTTPS drift).
    expect(data.https).toBe(true);
  });

  it("uses a per-server wildcard domain for the magic domain when set", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "IMAGE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: "apps.example.com", magicSuffix: null,
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", { name: "api", serverId: "s1", image: "nginx" });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toMatch(/^api-[0-9a-f]{6}\.apps\.example\.com$/);
    expect(data.domainKind).toBe("magic");
  });

  it("gives a magic app wildcard HTTPS (certType le-dns) when the server runs certMode le-dns", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "IMAGE" });
    const prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null,
          wildcardDomain: "apps.example.com", magicSuffix: null, certMode: "le-dns",
        }),
      },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", { name: "api", serverId: "s1", image: "nginx" });
    const data = create.mock.calls[0][0].data;
    expect(data.domain).toMatch(/^api-[0-9a-f]{6}\.apps\.example\.com$/);
    expect(data.domainKind).toBe("magic");
    expect(data.certType).toBe("le-dns");
    expect(data.https).toBe(true);
  });

  it("regenerateMagicForServer moves magic apps to the new wildcard, preserving the label", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { ...app, id: "a1", name: "web", domain: "web-a1b2c3.203-0-113-7.sslip.io", domainKind: "magic" },
    ]);
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: "apps.example.com", magicSuffix: null }) },
      application: { findMany, update, findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, {} as AgentWsServer).regenerateMagicForServer("s1");
    expect(findMany).toHaveBeenCalledWith({ where: { serverId: "s1", domainKind: "magic", isPreview: false } });
    expect(update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { domain: "web-a1b2c3.apps.example.com" } });
  });

  it("regenerateMagicForServer rebakes the old domain in composeFile + configMounts to the new one", async () => {
    const oldD = "web-a1b2c3.203-0-113-7.sslip.io";
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: "apps.example.com", magicSuffix: null }) },
      application: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...app, id: "a1", name: "web", domain: oldD, domainKind: "magic",
            composeFile: `services:\n  web:\n    environment:\n      - APP_URL=https://${oldD}\n`,
            configMounts: [{ serviceName: "web", target: "/etc/c", content: `base=https://${oldD}\n` }],
          },
        ]),
        update, findUnique: jest.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, {} as AgentWsServer).regenerateMagicForServer("s1");
    const newD = "web-a1b2c3.apps.example.com";
    const data = update.mock.calls[0][0].data;
    expect(data.domain).toBe(newD);
    expect(data.composeFile).toContain(`APP_URL=https://${newD}`);
    expect(data.composeFile).not.toContain(oldD);
    expect(data.configMounts).toEqual([{ serviceName: "web", target: "/etc/c", content: `base=https://${newD}\n` }]);
  });

  it("regenerateMagicForServer is a no-op when the recomputed domain is unchanged", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null }) },
      application: {
        findMany: jest.fn().mockResolvedValue([{ ...app, id: "a1", name: "web", domain: "web-a1b2c3.203-0-113-7.sslip.io", domainKind: "magic" }]),
        update,
      },
    } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, {} as AgentWsServer).regenerateMagicForServer("s1");
    expect(update).not.toHaveBeenCalled(); // same IP → same domain → no write
  });

  it("regenerateMagicForServer leaves domains untouched when the server has no public IP", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null }) },
      application: {
        findMany: jest.fn().mockResolvedValue([{ ...app, id: "a1", name: "web", domain: "web-a1b2c3.203-0-113-7.sslip.io", domainKind: "magic" }]),
        update,
      },
    } as unknown as PrismaService;
    await make(prisma, {} as TeamAccessService, {} as AgentWsServer).regenerateMagicForServer("s1");
    expect(update).not.toHaveBeenCalled(); // magicDomain → null → skip, don't clobber
  });

  it("expose(magic) switches an existing app to a magic domain over plain HTTP", async () => {
    const update = jest.fn().mockResolvedValue({});
    const exposed = { ...app, domain: null };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(exposed), update },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).expose("u1", "app1", { mode: "magic" });
    const data = update.mock.calls[0][0].data;
    expect(data.domainKind).toBe("magic");
    expect(data.certType).toBe("http");
    expect(data.https).toBe(false);
    expect(data.domain).toMatch(/\.203-0-113-7\.sslip\.io$/);
    expect(view.url).toBe(`http://${data.domain}`);
  });

  it("expose(custom) pins a user domain on HTTPS", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).expose("u1", "app1", { mode: "custom", domain: "app.example.com" });
    const data = update.mock.calls[0][0].data;
    expect(data.domain).toBe("app.example.com");
    expect(data.domainKind).toBe("custom");
    expect(data.certType).toBe("le-http");
    expect(data.https).toBe(true);
  });

  it("expose(none) clears the domain", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, domain: "old.example.com" }), update },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: "203.0.113.7", publicIpv6: null, wildcardDomain: null, magicSuffix: null }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).expose("u1", "app1", { mode: "none" });
    const data = update.mock.calls[0][0].data;
    expect(data.domain).toBeNull();
    expect(data.domainKind).toBe("none");
    expect(data.exposeMode).toBe("none");
  });

  it("places a template app into the chosen environment", async () => {
    const create = jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { teamId: "t1" } }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).createFromTemplate("u1", "wordpress", {
      name: "blog",
      serverId: "s1",
      environmentId: "e1",
    });
    expect(create.mock.calls[0][0].data.environmentId).toBe("e1");
  });

  it("remembers the template slug and resolves its logo on the view", async () => {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...app, ...data }),
    );
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).createFromTemplate("u1", "activepieces", {
      name: "flows",
      serverId: "s1",
    });
    expect(create.mock.calls[0][0].data.templateSlug).toBe("activepieces");
    expect(view.templateSlug).toBe("activepieces");
    expect(view.templateLogo).toBeTruthy();
  });

  it("leaves templateSlug/templateLogo null for a non-template app", async () => {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...app, ...data }),
    );
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).create("u1", {
      name: "plain",
      serverId: "s1",
      image: "nginx:alpine",
    });
    expect(view.templateSlug).toBeNull();
    expect(view.templateLogo).toBeNull();
  });

  it("forbids a non-writer from setting credentials", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setCredentials("u1", "app1", { gitToken: "t" }),
    ).rejects.toThrow(/nope/);
  });

  it("encrypts a git token and a registry auth on setCredentials", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setCredentials("u1", "app1", {
      gitToken: "ghp_abc",
      registry: { url: "reg.io", user: "u", token: "p" },
    });
    const data = update.mock.calls[0][0].data;
    expect(data.gitTokenEnc).toBe("enc(ghp_abc)");
    expect(data.registryAuthEnc).toBe('enc({"url":"reg.io","user":"u","token":"p"})');
  });

  it("clears a credential when set to null", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setCredentials("u1", "app1", { gitToken: null });
    expect(update.mock.calls[0][0].data).toEqual({ gitTokenEnc: null });
  });

  it("exposes credential presence in the view but never the secret token", async () => {
    // the test crypto stub's decrypt is identity, so store plaintext-ish values
    const withCreds = {
      ...app,
      gitTokenEnc: "ghp_abc",
      registryAuthEnc: '{"url":"reg.io","user":"u","token":"p"}',
    };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(withCreds) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
    expect(view.hasGitToken).toBe(true);
    expect(view.registryUrl).toBe("reg.io");
    expect(view.registryUser).toBe("u");
    expect(JSON.stringify(view)).not.toContain("ghp_abc");
    expect(JSON.stringify(view)).not.toContain('"token":"p"');
  });

  it("synthesizes a host:port URL for a domainless app when its server has a public IP", async () => {
    const exposed = { ...app, domain: null, hostPort: 8080 };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(exposed) },
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", publicIpv6: null }) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
    expect(view.url).toBe("http://203.0.113.7:8080");
  });

  it("leaves the URL null for a domainless app whose server has no known IP", async () => {
    const exposed = { ...app, domain: null, hostPort: 8080 };
    const prisma = {
      // server.findUnique defaults to null (no public IP yet) via make()
      application: { findUnique: jest.fn().mockResolvedValue(exposed) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
    expect(view.url).toBeNull();
  });

  it("synthesizes a URL for a domainless COMPOSE app from its portMappings (never null)", async () => {
    const exposed = {
      ...app,
      source: "COMPOSE",
      templateSlug: null,
      domain: null,
      hostPort: null, // COMPOSE apps always store hostPort null — the real port is in portMappings
      composeFile: 'services:\n  web:\n    image: x\n    ports:\n      - "20500:80"\n',
      portMappings: [{ serviceName: "web", containerPort: 80, hostPort: 20500, mode: "hostPort" }],
    };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(exposed) },
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", publicIpv6: null }) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
    expect(view.url).toBe("http://203.0.113.7:20500");
  });

  describe("view().links", () => {
    const composeApp = { ...app, source: "COMPOSE", templateSlug: null, domain: "app.example.com", https: true, extraDomains: ["alias.example.com"], composeFile: "services:\n  web:\n    image: x\n", portMappings: null };
    const sd = (applicationId: string, service: string, hostname: string) => ({ applicationId, service, hostname, port: 80, createdAt: new Date() });

    it("get() lists primary, alias and per-service links for a compose app, for a viewer without apps:config", async () => {
      const findMany = jest.fn().mockResolvedValue([sd("app1", "api", "api.example.com")]);
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(composeApp) },
        appServiceDomain: { findMany },
      } as unknown as PrismaService;
      const access = { membershipPermissions: jest.fn().mockResolvedValue(new Set()) } as unknown as TeamAccessService;
      const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
      expect(view.links.map((l) => [l.kind, l.url])).toEqual([
        ["primary", "https://app.example.com"],
        ["alias", "https://alias.example.com"],
        ["service", "https://api.example.com"],
      ]);
      expect(view.links[0].url).toBe(view.url);
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { applicationId: "app1" } }));
    });

    it("get() never queries service domains for a non-compose app", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, domain: "app.example.com" }) },
        appServiceDomain: { findMany },
      } as unknown as PrismaService;
      const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
      const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
      expect(findMany).not.toHaveBeenCalled();
      expect(view.links.map((l) => l.kind)).toEqual(["primary"]);
    });

    const listAccess = () =>
      ({
        accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
      }) as unknown as TeamAccessService;

    it("list() reads service domains ONCE for N compose apps (batched) and groups them per app", async () => {
      const findMany = jest.fn().mockResolvedValue([sd("c1", "api", "api1.example.com"), sd("c2", "api", "api2.example.com")]);
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue([
          { ...composeApp, id: "c1", extraDomains: [] },
          { ...composeApp, id: "c2", extraDomains: [] },
          { ...app, id: "g1", domain: "git.example.com" },
        ]) },
        appServiceDomain: { findMany },
      } as unknown as PrismaService;
      const out = await make(prisma, listAccess(), {} as AgentWsServer).list("u1");
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { applicationId: { in: ["c1", "c2"] } } }));
      const urls = (id: string) => out.find((a) => a.id === id)!.links.map((l) => l.url);
      expect(urls("c1")).toEqual(["https://app.example.com", "https://api1.example.com"]); // never c2's host
      expect(urls("c2")).toEqual(["https://app.example.com", "https://api2.example.com"]);
      expect(urls("g1")).toEqual(["http://git.example.com"]); // the base fixture has https off
    });

    it("list() skips the service-domain query entirely when no compose app is visible", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue([{ ...app, id: "g1" }]) },
        appServiceDomain: { findMany },
      } as unknown as PrismaService;
      await make(prisma, listAccess(), {} as AgentWsServer).list("u1");
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  it("uses the domain for a domained app regardless of the server IP", async () => {
    const domained = { ...app, domain: "app.example.com", https: true, hostPort: 8080 };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(domained) },
      server: { findUnique: jest.fn().mockResolvedValue({ publicIp: "203.0.113.7", publicIpv6: null }) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
    expect(view.url).toBe("https://app.example.com");
  });

  it("persists domain options for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setDomainOptions("u1", "app1", {
      domainRedirect: "root",
      securityHeaders: true,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { domainRedirect: "root", securityHeaders: true } }),
    );
  });

  it("persists forward-auth and clears it", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setDomainOptions("u1", "app1", { forwardAuth: "https://auth.x/verify" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { forwardAuth: "https://auth.x/verify" } }));
    await svc.setDomainOptions("u1", "app1", { forwardAuth: null });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { forwardAuth: null } }));
  });

  it("sets and clears an app domain for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setDomain("u1", "app1", "app.example.com");
    // A user-set domain becomes "custom" and pins certType to le-http (stays on HTTPS).
    expect(update).toHaveBeenCalledWith({
      where: { id: "app1" },
      data: { domain: "app.example.com", domainKind: "custom", certType: "le-http", https: true },
    });
    await svc.setDomain("u1", "app1", null);
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domain: null, domainKind: "none", extraDomains: [] } });
  });

  it("setDomain rejects the control-panel's own hostname (lockout guard) and writes nothing", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "panel.example.com");
    await expect(svc.setDomain("u1", "app1", "panel.example.com")).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it("setDomain panel-hostname match is case-insensitive and ignores a trailing dot", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "Panel.Example.com");
    await expect(svc.setDomain("u1", "app1", "panel.example.com.")).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it("setDomain still allows a DIFFERENT hostname when a panel domain is configured", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "panel.example.com");
    await svc.setDomain("u1", "app1", "app.example.com");
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domain: "app.example.com", domainKind: "custom", certType: "le-http", https: true } });
  });

  it("expose custom rejects the panel's own hostname", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "panel.example.com");
    await expect(svc.expose("u1", "app1", { mode: "custom", domain: "panel.example.com" })).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it("autoSetupDomain rejects the panel's own hostname BEFORE any DNS write", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const previewRecords = jest.fn();
    const applyRecords = jest.fn();
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, { previewRecords, applyRecords }, undefined, "panel.example.com");
    await expect(svc.autoSetupDomain("u1", "app1", { domain: "panel.example.com" })).rejects.toMatchObject({ status: 400 });
    expect(previewRecords).not.toHaveBeenCalled();
    expect(applyRecords).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("autoSetupDomain dryRun returns the plan and writes nothing (no setDomain)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const previewRecords = jest.fn().mockResolvedValue({ hostname: "example.com", apex: true, sslMode: "full", records: [{ type: "A", name: "example.com" }] });
    const applyRecords = jest.fn();
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, { previewRecords, applyRecords });
    const res = await svc.autoSetupDomain("u1", "app1", { domain: "example.com", dryRun: true });
    expect(res).toMatchObject({ dryRun: true, hostname: "example.com", apex: true });
    expect(previewRecords).toHaveBeenCalled();
    expect(applyRecords).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // no setDomain / setDomainOptions
  });

  it("autoSetupDomain apply writes DNS, sets the app domain, and sets the www→apex redirect for an apex+www", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const applyRecords = jest.fn().mockResolvedValue({
      hostname: "example.com",
      apex: true,
      status: "pending",
      records: [{ type: "A", name: "example.com", recordId: "r1", action: "created" }, { type: "CNAME", name: "www.example.com", recordId: "r2", action: "created" }],
    });
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, { applyRecords });
    await svc.autoSetupDomain("u1", "app1", { domain: "example.com" });
    expect(applyRecords).toHaveBeenCalled();
    // setDomain → custom + le-http + https
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domain: "example.com", domainKind: "custom", certType: "le-http", https: true } });
    // setDomainOptions → www→apex canonical redirect (apex + a www CNAME was created)
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domainRedirect: "root" } });
  });

  it("autoSetupDomain apply on a subdomain sets the domain but NO redirect (no www)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const applyRecords = jest.fn().mockResolvedValue({
      hostname: "app.example.com",
      apex: false,
      status: "pending",
      records: [{ type: "A", name: "app.example.com", recordId: "r1", action: "created" }],
    });
    const svc = make(prisma, access, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, { applyRecords });
    await svc.autoSetupDomain("u1", "app1", { domain: "app.example.com" });
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domain: "app.example.com", domainKind: "custom", certType: "le-http", https: true } });
    // the canonical redirect is explicitly CLEARED (not left stale) when there is no www CNAME
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domainRedirect: null } });
    expect(update).not.toHaveBeenCalledWith({ where: { id: "app1" }, data: { domainRedirect: "root" } });
  });

  it("rejects moving an app to an environment in another team", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn() },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { teamId: "OTHER" } }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setEnvironment("u1", "app1", "e1"),
    ).rejects.toThrow(/not found in this team/);
  });

  it("moves an app to a same-team environment (no un-assign; env is required)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { teamId: "t1" } }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setEnvironment("u1", "app1", "e1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { environmentId: "e1" } }));
  });

  it("setEnvironment refuses an environment whose project the member has no grant for", async () => {
    const update = jest.fn();
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { id: "p9", teamId: "t1" } }) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      requireProjectAccess: jest.fn().mockRejectedValue(new ForbiddenException("no access to this project")),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).setEnvironment("u1", "app1", "e1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setEnvironment checks project access with the destination project id", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { id: "p9", teamId: "t1" } }) },
    } as unknown as PrismaService;
    const requireProjectAccess = jest.fn().mockResolvedValue(undefined);
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), requireProjectAccess } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setEnvironment("u1", "app1", "e1");
    expect(requireProjectAccess).toHaveBeenCalledWith("u1", "t1", "p9");
  });

  it("rejects a null environment at the schema (an app always belongs to an env)", () => {
    expect(SetEnvironmentSchema.safeParse({ environmentId: null }).success).toBe(false);
    expect(SetEnvironmentSchema.safeParse({ environmentId: "" }).success).toBe(false);
    expect(SetEnvironmentSchema.safeParse({ environmentId: "e1" }).success).toBe(true);
  });

  it("forbids a non-writer from setting volumes", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setVolumes("u1", "app1", [{ name: "data", path: "/data" }]),
    ).rejects.toThrow(/nope/);
  });

  it("persists volumes for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setVolumes("u1", "app1", [{ name: "data", path: "/app/data" }]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { volumes: [{ name: "data", path: "/app/data" }] } }),
    );
  });

  it("rejects rollback to a deployment without a retained image", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.rollback("u1", "app1", "depX")).rejects.toThrow(/rollbackable/);
  });

  it("a registry-pull rollback (build=true) does NOT re-run the pre-deploy hook", async () => {
    const hookApp = {
      ...app,
      source: "GIT",
      gitUrl: "https://x/y.git",
      gitBranch: "main",
      buildType: "DOCKERFILE",
      image: null,
      registryId: "reg1",
      preDeployCommand: "npm run migrate",
    };
    let sentCmd = "";
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(hookApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(
            where.status === "RUNNING"
              ? null
              : { id: "target", status: "SUCCESS", imageTag: null, registryImage: "ghcr.io/x/y:target", imageDigest: null, commitSha: null, commitMessage: null },
          ),
        ),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
      },
      registry: { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: null, username: "u", passwordEnc: "enc" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, c: string) => { sentCmd = c; return Promise.resolve({ exitCode: 0, output: "ok" }); }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).rollback("u1", "app1", "target");
    expect(sentCmd).toContain("docker pull"); // the registry image is pulled (build=true path)
    expect(sentCmd).not.toContain("TUGRA_PREDEPLOY"); // but the hook is cleared for a rollback
  });

  it("setDeployHooks rejects a hook on swarm/compose/preview apps, allows clearing, and never audits the command text", async () => {
    const mk = (over: object) => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, ...over }), update } } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      return { svc: make(prisma, access, {} as AgentWsServer), update };
    };
    await expect(mk({ clusterId: "c1" }).svc.setDeployHooks("u1", "app1", "migrate", null)).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ source: "COMPOSE" }).svc.setDeployHooks("u1", "app1", "migrate", null)).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ isPreview: true }).svc.setDeployHooks("u1", "app1", null, "notify")).rejects.toBeInstanceOf(BadRequestException);
    // clearing (both null) is allowed even on a swarm app so a stale value can be removed
    const cleared = mk({ clusterId: "c1" });
    await cleared.svc.setDeployHooks("u1", "app1", null, null);
    expect(cleared.update).toHaveBeenCalledWith(expect.objectContaining({ data: { preDeployCommand: null, postDeployCommand: null } }));
    // a classic app persists (trimmed) + audits only lengths, never the command text
    const ok = mk({ source: "IMAGE" });
    await ok.svc.setDeployHooks("u1", "app1", "  SECRET_HOOK_CMD  ", null);
    expect(ok.update).toHaveBeenCalledWith(expect.objectContaining({ data: { preDeployCommand: "SECRET_HOOK_CMD", postDeployCommand: null } }));
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("SECRET_HOOK_CMD");
  });

  it("setContainerCommand rejects an override on compose/cluster/preview, guards the dockerOptions --entrypoint clash, allows clearing, and audits only counts", async () => {
    const mk = (over: object) => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, ...over }), update },
        deployment: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      return { svc: make(prisma, access, {} as AgentWsServer), update };
    };
    const argv = { containerEntrypoint: null, containerCommand: ["SECRET_ARG_XYZ"] };
    await expect(mk({ clusterId: "c1" }).svc.setContainerCommand("u1", "app1", argv)).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ source: "COMPOSE" }).svc.setContainerCommand("u1", "app1", argv)).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ isPreview: true }).svc.setContainerCommand("u1", "app1", argv)).rejects.toBeInstanceOf(BadRequestException);
    // a raw dockerOptions --entrypoint collides with a structured entrypoint override
    await expect(
      mk({ dockerOptions: "--entrypoint /x" }).svc.setContainerCommand("u1", "app1", { containerEntrypoint: ["sh"], containerCommand: null }),
    ).rejects.toThrow(/--entrypoint/);
    // clearing (both null) is allowed even on a cluster app so a stale value can be removed
    const cleared = mk({ clusterId: "c1" });
    await cleared.svc.setContainerCommand("u1", "app1", { containerEntrypoint: null, containerCommand: null });
    expect(cleared.update).toHaveBeenCalledWith(expect.objectContaining({ data: { containerEntrypoint: Prisma.JsonNull, containerCommand: Prisma.JsonNull } }));
    // a classic image app persists the argv + audits only counts, never the args
    const ok = mk({ source: "IMAGE" });
    await ok.svc.setContainerCommand("u1", "app1", argv);
    expect(ok.update).toHaveBeenCalledWith(expect.objectContaining({ data: { containerEntrypoint: Prisma.JsonNull, containerCommand: ["SECRET_ARG_XYZ"] } }));
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("SECRET_ARG_XYZ");
  });

  it("setDockerOptions refuses a raw --entrypoint while a container entrypoint override is set", async () => {
    const update = jest.fn().mockResolvedValue({});
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const withOverride = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, containerEntrypoint: ["sh", "-c"] }), update } } as unknown as PrismaService;
    await expect(make(withOverride, access, {} as AgentWsServer).setDockerOptions("u1", "app1", "--entrypoint /x")).rejects.toThrow(/entrypoint override/);
    // the same options are fine without the override
    const noOverride = { application: { findUnique: jest.fn().mockResolvedValue({ ...app }), update } } as unknown as PrismaService;
    await make(noOverride, access, {} as AgentWsServer).setDockerOptions("u1", "app1", "--entrypoint /x");
    expect(update).toHaveBeenCalled();
  });

  it("the post-deploy hook never fires on a FAILED deploy", async () => {
    const hookApp = { ...app, postDeployCommand: "curl http://x/notify" };
    const sent: string[] = [];
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(hookApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, c: string) => { sent.push(c); return Promise.resolve({ exitCode: 1, output: "boom" }); }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    expect(sent.some((c) => c.includes("TUGRA_POSTDEPLOY"))).toBe(false);
  });

  it("deploys a COMPOSE app via docker compose, without setting an image tag", async () => {
    const composeApp = { ...app, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx", env: {} };
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(composeApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let cmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, c: string) => { cmd = c; return Promise.resolve({ exitCode: 0, output: "ok" }); }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, access, agentWs);
    await svc.deploy("u1", "app1");
    expect(cmd).toContain("docker compose -p tugra_app1");
    expect(cmd).toContain("up -d --remove-orphans");
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", imageTag: null }) }),
    );
  });

  it("compose rollback 404s when the target deployment doesn't exist", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: "services:\n" }) },
      deployment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.rollback("u1", "app1", "depX")).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── Preview deployments (B6) ──

  const parentApp = {
    ...app,
    id: "parent1",
    source: "GIT",
    gitUrl: "https://github.com/u/r.git",
    gitBranch: "main",
    buildType: "NIXPACKS",
    image: null,
    domain: "x.com",
    domainKind: "custom",
    exposeMode: "custom",
    certType: "le-http",
    previewEnabled: true,
    isPreview: false,
  };

  function deployMocks() {
    return {
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it("upsertPreview is a no-op when the parent has previews disabled", async () => {
    const create = jest.fn();
    const prisma = { application: { create, findFirst: jest.fn() } } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    await svc.upsertPreview({ ...parentApp, previewEnabled: false } as never, 5, "feat");
    expect(create).not.toHaveBeenCalled();
  });

  it("upsertPreview creates a preview clone on the PR branch and deploys it", async () => {
    const create = jest
      .fn()
      .mockImplementation(({ data }) => Promise.resolve({ ...parentApp, ...data, id: "prev1" }));
    const prisma = {
      application: { create, update: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
      ...deployMocks(),
    } as unknown as PrismaService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => {
        sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "ok" });
      }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, {} as TeamAccessService, agentWs);
    await svc.upsertPreview({ ...parentApp, gitSourceId: "gs1", nixpacksBuildCmd: "npm run build" } as never, 5, "feature-x");

    const data = create.mock.calls[0][0].data;
    expect(data.isPreview).toBe(true);
    expect(data.nixpacksBuildCmd).toBe("npm run build"); // a preview builds the same way as its parent
    expect(data.parentAppId).toBe("parent1");
    expect(data.prNumber).toBe(5);
    expect(data.gitBranch).toBe("feature-x");
    expect(data.gitSourceId).toBe("gs1"); // keeps the GitHub-App link so a private-repo preview can clone
    expect(data.domain).toBe("pr5.x.com");
    // A preview mirrors the parent's exposure so an HTTPS custom-domain app's
    // preview keeps certType le-http (stays on HTTPS) instead of the "http" default.
    expect(data.certType).toBe("le-http");
    expect(data.domainKind).toBe("custom");
    expect(sentCmd).toContain("tugra_prev1"); // deployed under its own container
  });

  it("upsertPreview re-syncs the branch on an existing preview instead of creating", async () => {
    const create = jest.fn();
    const appUpdate = jest
      .fn()
      .mockResolvedValue({ ...parentApp, id: "prev1", isPreview: true, gitBranch: "feat-v2" });
    const prisma = {
      application: {
        create,
        update: appUpdate,
        findFirst: jest.fn().mockResolvedValue({ ...parentApp, id: "prev1", isPreview: true }),
      },
      ...deployMocks(),
    } as unknown as PrismaService;
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" }),
    } as unknown as AgentWsServer;
    const svc = make(prisma, {} as TeamAccessService, agentWs);
    await svc.upsertPreview(parentApp as never, 5, "feat-v2");
    expect(create).not.toHaveBeenCalled();
    expect(appUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "prev1" }, data: { gitBranch: "feat-v2", gitCommit: null, containerPort: 80, prHeadSha: null } }),
    );
  });

  it("removePreviewByPr tears down the preview container and deletes the record", async () => {
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      application: {
        findFirst: jest.fn().mockResolvedValue({ ...parentApp, id: "prev1", isPreview: true }),
        delete: del,
      },
    } as unknown as PrismaService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => {
        sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, {} as TeamAccessService, agentWs).removePreviewByPr("parent1", 5);
    expect(sentCmd).toContain("docker rm -f tugra_prev1");
    expect(sentCmd).toContain("docker rmi -f $(docker images --filter=reference='tugra_prev1:*'"); // reclaim the preview's own images
    expect(del).toHaveBeenCalledWith({ where: { id: "prev1" } });
  });

  it("removePreviewByPr keeps the record (no silent orphan) when the agent teardown is unreachable", async () => {
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      application: {
        findFirst: jest.fn().mockResolvedValue({ ...parentApp, id: "prev1", isPreview: true }),
        delete: del,
      },
    } as unknown as PrismaService;
    const agentWs = { sendCommand: jest.fn().mockRejectedValue(new Error("agent offline")) } as unknown as AgentWsServer;
    // The throw propagates (callers .catch it) — crucially the DB row is NOT deleted, so nothing is orphaned.
    await expect(make(prisma, {} as TeamAccessService, agentWs).removePreviewByPr("parent1", 5)).rejects.toThrow(/did not converge/);
    expect(del).not.toHaveBeenCalled();
  });

  it("removePreviewByPr on a COMPOSE preview omits the image-removal line (no single tag)", async () => {
    let sentCmd = "";
    const prisma = {
      application: {
        findFirst: jest.fn().mockResolvedValue({ ...parentApp, id: "prev1", isPreview: true, source: "COMPOSE" }),
        delete: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sentCmd = cmd; return Promise.resolve({ exitCode: 0, output: "" }); }),
    } as unknown as AgentWsServer;
    await make(prisma, {} as TeamAccessService, agentWs).removePreviewByPr("parent1", 5);
    expect(sentCmd).toContain("docker rm -f tugra_prev1");
    expect(sentCmd).not.toContain("docker rmi");
  });

  it("setPreviewEnabled refuses to enable previews without a domain", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...parentApp, domain: null }), update: jest.fn() },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setPreviewEnabled("u1", "parent1", true),
    ).rejects.toThrow(/domain/);
  });

  describe("preview providers (GitLab / Gitea / Bitbucket)", () => {
    function previewSvc(existing: Record<string, unknown> | null) {
      const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...parentApp, ...data, id: "prev1" }));
      const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...parentApp, ...(existing ?? {}), ...data, id: "prev1" }));
      const executeRaw = jest.fn().mockResolvedValue(0);
      const prisma = {
        application: { create, update, findFirst: jest.fn().mockResolvedValue(existing) },
        $executeRaw: executeRaw,
      } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
      const submit = jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue({ id: "d1" });
      return { svc, create, update, executeRaw, submit };
    }

    it("create stores prProvider / prHeadSha; the name says MR !n for gitlab and PR #n otherwise; the host stays pr<n>", async () => {
      const gl = previewSvc(null);
      await gl.svc.upsertPreview(parentApp as never, 7, "feat", { provider: "gitlab", headSha: "abc1234" });
      expect(gl.create.mock.calls[0][0].data).toMatchObject({ prProvider: "gitlab", prHeadSha: "abc1234", name: expect.stringContaining("MR !7"), domain: "pr7.x.com" });
      const gt = previewSvc(null);
      await gt.svc.upsertPreview(parentApp as never, 7, "feat", { provider: "gitea", headSha: null });
      expect(gt.create.mock.calls[0][0].data).toMatchObject({ prProvider: "gitea", prHeadSha: null, name: expect.stringContaining("PR #7"), domain: "pr7.x.com" });
      const legacy = previewSvc(null);
      await legacy.svc.upsertPreview(parentApp as never, 7, "feat");
      expect(legacy.create.mock.calls[0][0].data).toMatchObject({ prProvider: null, prHeadSha: null, domain: "pr7.x.com" });
    });

    it("onlyIfHeadChanged with an equal stored sha neither updates nor deploys", async () => {
      const t = previewSvc({ id: "prev1", prHeadSha: "abc1234", prProvider: "bitbucket" });
      const r = await t.svc.upsertPreview(parentApp as never, 5, "feat", { provider: "bitbucket", headSha: "abc1234", onlyIfHeadChanged: true });
      expect(r).toBeUndefined();
      expect(t.update).not.toHaveBeenCalled();
      expect(t.create).not.toHaveBeenCalled();
      expect(t.submit).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "preview.skipped", meta: expect.objectContaining({ reason: "head-unchanged" }) }));
    });

    it("onlyIfHeadChanged with a different sha redeploys and stores the new sha; with no existing preview it creates", async () => {
      const t = previewSvc({ id: "prev1", prHeadSha: "abc1234", prProvider: "bitbucket" });
      await t.svc.upsertPreview(parentApp as never, 5, "feat", { provider: "bitbucket", headSha: "def5678", onlyIfHeadChanged: true });
      expect(t.update.mock.calls[0][0].data).toMatchObject({ prHeadSha: "def5678", prProvider: "bitbucket" });
      expect(t.submit).toHaveBeenCalledTimes(1);
      const n = previewSvc(null);
      await n.svc.upsertPreview(parentApp as never, 5, "feat", { provider: "bitbucket", headSha: "def5678", onlyIfHeadChanged: true });
      expect(n.create).toHaveBeenCalledTimes(1);
      expect(n.submit).toHaveBeenCalledTimes(1);
    });

    it("an update without a provider never overwrites the stored provider", async () => {
      const t = previewSvc({ id: "prev1", prProvider: "gitlab" });
      await t.svc.upsertPreview(parentApp as never, 5, "feat");
      expect("prProvider" in t.update.mock.calls[0][0].data).toBe(false);
    });

    it("takes a per-(parent, PR) advisory xact lock before re-finding the preview", async () => {
      const t = previewSvc(null);
      await t.svc.upsertPreview(parentApp as never, 5, "feat", { provider: "gitlab" });
      expect(t.executeRaw).toHaveBeenCalledTimes(1);
      const strings = (t.executeRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
      expect(strings).toContain("pg_advisory_xact_lock");
      expect(t.executeRaw.mock.calls[0][1]).toBe("preview:parent1:5");
    });

    it("skips (and audits) a COMPOSE or IMAGE parent instead of building a broken preview", async () => {
      for (const src of [{ source: "COMPOSE" }, { source: "IMAGE" }, { gitUrl: null }]) {
        const t = previewSvc(null);
        await t.svc.upsertPreview({ ...parentApp, ...src } as never, 5, "feat", { provider: "gitlab" });
        expect(t.create).not.toHaveBeenCalled();
        expect(t.submit).not.toHaveBeenCalled();
        expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "preview.skipped", meta: expect.objectContaining({ reason: "unsupported-source" }) }));
      }
    });

    it("setPreviewEnabled(true) refuses a non-GIT app, keeps the domain 400 on GIT, and always allows disabling", async () => {
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const mk = (a: Record<string, unknown>) =>
        make({ application: { findUnique: jest.fn().mockResolvedValue(a), update: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService, access, {} as AgentWsServer);
      await expect(mk({ ...parentApp, source: "COMPOSE" }).setPreviewEnabled("u1", "parent1", true)).rejects.toThrow(/Git-built/);
      await expect(mk({ ...parentApp, source: "IMAGE" }).setPreviewEnabled("u1", "parent1", true)).rejects.toThrow(BadRequestException);
      await expect(mk({ ...parentApp, domain: null }).setPreviewEnabled("u1", "parent1", true)).rejects.toThrow(/domain/);
      await expect(mk({ ...parentApp, source: "COMPOSE" }).setPreviewEnabled("u1", "parent1", false)).resolves.toBeUndefined();
      await expect(mk(parentApp).setPreviewEnabled("u1", "parent1", true)).resolves.toBeUndefined();
    });

    it("a new preview submit cancels older QUEUED preview rows of that app (and nothing else); manual rows are untouched", async () => {
      const supersede = jest.fn().mockResolvedValue({ count: 1 });
      const mkPrisma = () =>
        ({
          application: { findUnique: jest.fn().mockResolvedValue(parentApp), update: jest.fn().mockResolvedValue({}) },
          deployment: {
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue({ id: "d9", createdAt: new Date() }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: supersede,
            findUnique: jest.fn().mockResolvedValue({ id: "d9", status: "SUCCESS" }),
            findFirst: jest.fn().mockResolvedValue(null),
          },
          sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
        }) as unknown as PrismaService;
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" }) } as unknown as AgentWsServer;
      const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
      const svc = make(mkPrisma(), access, agentWs);
      await (svc as unknown as { submitDeploy: (a: unknown, actor: string) => Promise<unknown> }).submitDeploy(parentApp, "webhook:pr");
      const supersedeCalls = supersede.mock.calls.filter((c) => c[0].data?.logs === "Superseded by a newer push");
      expect(supersedeCalls).toHaveLength(1);
      expect(supersedeCalls[0][0].where).toMatchObject({ appId: "parent1", status: "QUEUED", trigger: "preview", id: { not: "d9" } });
      supersede.mockClear();
      await (make(mkPrisma(), access, agentWs) as unknown as { submitDeploy: (a: unknown, actor: string) => Promise<unknown> }).submitDeploy(parentApp, "u1");
      expect(supersede.mock.calls.filter((c) => c[0].data?.logs === "Superseded by a newer push")).toHaveLength(0);
    });
  });

  it("auto-creates an uptime monitor when a domained app is created", async () => {
    const monitors = makeMonitors();
    const created = { ...app, id: "a9", domain: "x.com", https: true, isPreview: false };
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create: jest.fn().mockResolvedValue(created) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer, makeDeployLogs(), monitors).create("u1", {
      name: "web", serverId: "s1", image: "nginx", domain: "x.com",
    });
    expect(monitors.createForApp).toHaveBeenCalledWith(expect.objectContaining({ id: "a9", domain: "x.com" }));
  });

  it("removeImages opt-in drops the app's OWN image tags (scoped); default delete leaves images alone", async () => {
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const mk = () => {
      const sent: string[] = [];
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "IMAGE" }), delete: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService;
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, c: string) => { sent.push(c); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
      return { sent, svc: make(prisma, access, agentWs, makeDeployLogs(), makeMonitors()) };
    };
    const on = mk();
    await on.svc.remove("u1", "app1", { removeImages: true });
    expect(on.sent.join("\n")).toContain("--filter=reference='tugra_app1:*'");
    expect(on.sent.join("\n")).not.toMatch(/docker images\s+-a?q/); // never an unscoped wildcard

    const off = mk();
    await off.svc.remove("u1", "app1"); // default
    expect(off.sent.join("\n")).not.toContain("docker rmi"); // images untouched unless opted in
  });

  it("removes the app's auto monitors on delete", async () => {
    const monitors = makeMonitors();
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), delete: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs, makeDeployLogs(), monitors).remove("u1", "app1");
    expect(monitors.removeForApp).toHaveBeenCalledWith("app1");
  });

  it("remove resolves the log-drain target servers BEFORE the delete (the drains cascade) and re-pushes AFTER it", async () => {
    const order: string[] = [];
    const targetServerIds = jest.fn(async () => {
      order.push("targets");
      return ["s1", "s2"];
    });
    const pushForServers = jest.fn(async () => {
      order.push("push");
    });
    const prisma = {
      application: {
        findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1" }),
        delete: jest.fn(async () => {
          order.push("delete");
          return {};
        }),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs, makeDeployLogs(), makeMonitors(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { targetServerIds, pushForServers }).remove("u1", "app1");
    expect(targetServerIds).toHaveBeenCalledWith(expect.objectContaining({ id: "app1", serverId: "s1", clusterId: "c1" }));
    expect(order).toEqual(["targets", "delete", "push"]);
    expect(pushForServers).toHaveBeenCalledWith(["s1", "s2"]);
  });

  it("normalizes and stores tags on setTags", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setTags("u1", "app1", ["PROD", " staging ", "prod"]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tags: ["prod", "staging"] } }),
    );
  });

  it("list() excludes preview apps from the top-level listing", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { application: { findMany } } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).list("u1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isPreview: false }) }),
    );
  });

  it("list() labels each app with its project/environment (batched, no N+1)", async () => {
    const envFindMany = jest.fn().mockResolvedValue([
      { id: "e1", name: "production", project: { id: "p1", name: "Default" } },
    ]);
    const prisma = {
      application: { findMany: jest.fn().mockResolvedValue([{ ...app, environmentId: "e1" }]) },
      environment: { findMany: envFindMany },
    } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access, {} as AgentWsServer).list("u1");
    expect(envFindMany).toHaveBeenCalledTimes(1); // one query for the whole list
    expect(out[0].projectName).toBe("Default");
    expect(out[0].environmentName).toBe("production");
  });

  it("list() hides apps outside a restricted member's granted projects", async () => {
    const prisma = {
      application: { findMany: jest.fn().mockResolvedValue([
        { ...app, id: "a-ok", environmentId: "e1" },
        { ...app, id: "a-hidden", environmentId: "e2" },
      ]) },
      environment: { findMany: jest.fn().mockResolvedValue([
        { id: "e1", name: "production", project: { id: "p-ok", name: "Ok" } },
        { id: "e2", name: "production", project: { id: "p-secret", name: "Secret" } },
      ]) },
    } as unknown as PrismaService;
    const access = {
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.VIEWER, restrictedAccess: true, accessedProjects: ["p-ok"], accessedResources: [] }]])),
    } as unknown as TeamAccessService;
    const out = await make(prisma, access, {} as AgentWsServer).list("u1");
    expect(out.map((a) => a.id)).toEqual(["a-ok"]); // the p-secret app is filtered out
  });

  it("get() propagates a per-resource scoping denial", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = {
      membershipPermissions: jest.fn().mockResolvedValue(new Set()),
      requireResourceAccess: jest.fn().mockRejectedValue(new ForbiddenException("no access to this resource")),
    } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).get("u1", "app1")).rejects.toThrow(/no access/);
  });

  it("rolls back by re-running the target image tag without rebuilding", async () => {
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "dep1", appId: "app1", status: "SUCCESS", imageTag: "tugra_app1:dep1" }),
        ),
        create: jest.fn().mockResolvedValue({ id: "dep2" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "dep2", status: "SUCCESS" }),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => {
        sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "Up" });
      }),
    } as unknown as AgentWsServer;

    const svc = make(prisma, access, agentWs);
    await svc.rollback("u1", "app1", "dep1");

    // re-runs the OLD image tag, with no rebuild/pull
    expect(sentCmd).toContain("docker run -d --name tugra_app1");
    expect(sentCmd).toContain("tugra_app1:dep1");
    expect(sentCmd).not.toContain("docker pull");
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", imageTag: "tugra_app1:dep1" }) }),
    );
  });

  it("rolls back by PULLING the registry image when the local tag was pruned", async () => {
    const regApp = { ...app, registryId: "reg1", pushToRegistry: true };
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(regApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        // local imageTag was pruned (null) but the registry ref survives
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "dep1", appId: "app1", status: "SUCCESS", imageTag: null, registryImage: "ghcr.io/org/tugra_app1:dep1" }),
        ),
        create: jest.fn().mockResolvedValue({ id: "dep2" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "dep2", status: "SUCCESS" }),
      },
      registry: { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => {
        sentCmd = cmd;
        return Promise.resolve({ exitCode: 0, output: "Up" });
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).rollback("u1", "app1", "dep1");
    // pulls the portable registry image and tags it as the local versioned tag, then runs
    expect(sentCmd).toContain("docker pull 'ghcr.io/org/tugra_app1:dep1'");
    expect(sentCmd).toContain("docker tag 'ghcr.io/org/tugra_app1:dep1' tugra_app1:dep1");
    expect(sentCmd).toContain("docker run -d --name tugra_app1");
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", imageTag: "tugra_app1:dep1", registryImage: "ghcr.io/org/tugra_app1:dep1" }) }),
    );
  });

  it("prefers the retained LOCAL tag over the registry (no pull) when both exist", async () => {
    const regApp = { ...app, registryId: "reg1", pushToRegistry: true };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(regApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "dep1", appId: "app1", status: "SUCCESS", imageTag: "tugra_app1:dep1", registryImage: "ghcr.io/org/tugra_app1:dep1" }),
        ),
        create: jest.fn().mockResolvedValue({ id: "dep2" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "dep2", status: "SUCCESS" }),
      },
      registry: { findFirst: jest.fn() },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    let sentCmd = "";
    const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sentCmd = cmd; return Promise.resolve({ exitCode: 0, output: "Up" }); }) } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).rollback("u1", "app1", "dep1");
    // local image present → re-run it, never pull from the registry (fast + outage-proof)
    expect(sentCmd).not.toContain("docker pull");
    expect((prisma.registry.findFirst as jest.Mock)).not.toHaveBeenCalled();
  });

  it("registry-only target whose registry was deleted → clean 404, no dangling deployment, app untouched", async () => {
    const noRegApp = { ...app, registryId: null }; // registry removed → registryId auto-nulled
    const create = jest.fn();
    const appUpdate = jest.fn();
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(noRegApp), update: appUpdate },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "dep1", appId: "app1", status: "SUCCESS", imageTag: null, registryImage: "ghcr.io/org/tugra_app1:dep1" }),
        ),
        create,
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).rollback("u1", "app1", "dep1")).rejects.toThrow(/no longer available/);
    // no RUNNING rollback row created, and the still-running app was never flipped to FAILED
    expect(create).not.toHaveBeenCalled();
    expect(appUpdate).not.toHaveBeenCalled();
  });

  it("rejects rollback when neither a local tag nor a registry image exists", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "dep1", appId: "app1", status: "SUCCESS", imageTag: null, registryImage: null }),
        ),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).rollback("u1", "app1", "dep1")).rejects.toThrow(/rollbackable/);
  });
});

describe("ApplicationsService.setClusterConfig le-dns re-home", () => {
  const magicApp = { ...app, source: "IMAGE", exposeMode: "magic", domainKind: "magic", domain: "web-a1b2c3.old.example", certType: "http", https: false };

  function deps(appRow: object, managerServer: object, clusterRow: object = { teamId: "t1", swarmStatus: "ACTIVE", swarmManagerId: "mgr1" }) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(appRow), update },
      cluster: { findUnique: jest.fn().mockResolvedValue(clusterRow) },
      server: { findUnique: jest.fn().mockResolvedValue(managerServer) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    return { prisma, access, update };
  }

  it("re-homes a magic app onto the manager's le-dns wildcard, preserving the label", async () => {
    const { prisma, access, update } = deps(magicApp, {
      id: "mgr1", publicIp: "203.0.113.9", publicIpv6: null, wildcardDomain: "swarm.example.com", magicSuffix: null, certMode: "le-dns",
    });
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    const data = update.mock.calls[0][0].data;
    expect(data.clusterId).toBe("c1");
    expect(data.domain).toBe("web-a1b2c3.swarm.example.com"); // label kept, wildcard swapped to manager's
    expect(data.certType).toBe("le-dns");
    expect(data.https).toBe(true);
    expect(data.domainKind).toBe("magic");
  });

  it("re-homes onto a plain-HTTP manager (no wildcard) as certType http", async () => {
    const { prisma, access, update } = deps(magicApp, {
      id: "mgr1", publicIp: "203.0.113.9", publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http",
    });
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    const data = update.mock.calls[0][0].data;
    expect(data.certType).toBe("http");
    expect(data.https).toBe(false);
    expect(data.domain).toMatch(/^web-a1b2c3\.203-0-113-9\.sslip\.io$/); // manager IP magic
  });

  it("re-pushes log drains to the OLD and NEW target servers when the cluster changes", async () => {
    const { prisma, access } = deps(magicApp, {
      id: "mgr1", publicIp: "203.0.113.9", publicIpv6: null, wildcardDomain: "swarm.example.com", magicSuffix: null, certMode: "le-dns",
    });
    const targetServerIds = jest.fn().mockResolvedValueOnce(["s1"]).mockResolvedValueOnce(["s1", "mgr1", "n2"]);
    const pushForServers = jest.fn().mockResolvedValue(undefined);
    await make(prisma, access, {} as AgentWsServer, makeDeployLogs(), makeMonitors(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { targetServerIds, pushForServers }).setClusterConfig("u1", "app1", { clusterId: "c1" });
    expect(targetServerIds).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "app1", serverId: "s1" })); // before: the app as it was (its own server)
    expect(targetServerIds).toHaveBeenNthCalledWith(2, { id: "app1", serverId: "s1", clusterId: "c1" }); // after
    expect(pushForServers).toHaveBeenCalledWith(["s1", "s1", "mgr1", "n2"]);
  });

  it("does not touch log drains when only replicas change", async () => {
    const { prisma, access } = deps(magicApp, { id: "mgr1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http" });
    const pushForServers = jest.fn();
    await make(prisma, access, {} as AgentWsServer, makeDeployLogs(), makeMonitors(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { pushForServers }).setClusterConfig("u1", "app1", { replicas: 2 });
    expect(pushForServers).not.toHaveBeenCalled();
  });

  it("leaves a custom-domain app's cert untouched (server-agnostic le-http)", async () => {
    const customApp = { ...magicApp, exposeMode: "custom", domainKind: "custom", domain: "app.acme.com", certType: "le-http" };
    const { prisma, access, update } = deps(customApp, { id: "mgr1", publicIp: "203.0.113.9", publicIpv6: null, wildcardDomain: "swarm.example.com", magicSuffix: null, certMode: "le-dns" });
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    const data = update.mock.calls[0][0].data;
    expect(data.clusterId).toBe("c1");
    expect(data.domain).toBeUndefined(); // no re-resolve
    expect(data.certType).toBeUndefined();
  });

  it("re-homes back onto the app's own server when leaving the cluster", async () => {
    const clustered = { ...magicApp, clusterId: "c1", certType: "le-dns", https: true, domain: "web-a1b2c3.swarm.example.com" };
    const { prisma, access, update } = deps(clustered, {
      id: "s1", publicIp: "198.51.100.4", publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http",
    });
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: null });
    const data = update.mock.calls[0][0].data;
    expect(data.clusterId).toBeNull();
    expect(data.certType).toBe("http"); // own server has no wildcard → drops to plain HTTP magic
    expect(data.domain).toBe("web-a1b2c3.198-51-100-4.sslip.io");
  });
});

describe("ApplicationsService.hydrateCertSpec cluster-aware", () => {
  it("pulls wildcardDomain from the MANAGER's server for a clustered le-dns app", async () => {
    const findUnique = jest.fn().mockResolvedValue({ wildcardDomain: "swarm.example.com", customCertResolver: null });
    const prisma = {
      cluster: { findUnique: jest.fn().mockResolvedValue({ swarmManagerId: "mgr1" }) },
      server: { findUnique },
    } as unknown as PrismaService;
    const svc = make(prisma, {}, {});
    const spec: { wildcardDomain?: string | null; customCertResolver?: string | null } = {};
    await (svc as unknown as { hydrateCertSpec: (a: object, s: object) => Promise<void> }).hydrateCertSpec(
      { ...app, clusterId: "c1", serverId: "s1", certType: "le-dns" },
      spec,
    );
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mgr1" } })); // manager, not s1
    expect(spec.wildcardDomain).toBe("swarm.example.com");
  });

  it("falls back to the app's own server when it is not clustered", async () => {
    const findUnique = jest.fn().mockResolvedValue({ wildcardDomain: "own.example.com", customCertResolver: null });
    const prisma = { server: { findUnique } } as unknown as PrismaService;
    const svc = make(prisma, {}, {});
    const spec: { wildcardDomain?: string | null } = {};
    await (svc as unknown as { hydrateCertSpec: (a: object, s: object) => Promise<void> }).hydrateCertSpec(
      { ...app, clusterId: null, serverId: "s1", certType: "le-dns" },
      spec,
    );
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1" } }));
    expect(spec.wildcardDomain).toBe("own.example.com");
  });
});

describe("ApplicationsService.setPlacement", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const withSwarm = (statusMock: jest.Mock) => [undefined, undefined, undefined, undefined, undefined, { status: statusMock }] as const;

  it("400s when the app has no clusterId", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: null }), update: jest.fn() } } as unknown as PrismaService;
    await expect(make(prisma, access, {} as AgentWsServer).setPlacement("u1", "app1", { constraints: [], spreadLabelKey: null })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("400s when a hostname rule targets a node not in the live list", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1" }), update } } as unknown as PrismaService;
    const status = jest.fn().mockResolvedValue({ live: [{ id: "n1", hostname: "web-1", labels: {} }] });
    await expect(
      make(prisma, access, {} as AgentWsServer, ...withSwarm(status)).setPlacement("u1", "app1", { constraints: [{ type: "hostname", op: "eq", value: "web-9" }], spreadLabelKey: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("persists a valid placement (label rule needs no live check)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1" }), update } } as unknown as PrismaService;
    const input = { constraints: [{ type: "label" as const, op: "eq" as const, key: "zone", value: "east" }], spreadLabelKey: "zone" };
    await make(prisma, access, {} as AgentWsServer).setPlacement("u1", "app1", input);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "app1" }, data: { placement: input } }));
  });

  it("setClusterConfig clears a stale placement when clusterId changes, keeps it when re-saved as the same", async () => {
    const clusterRow = { teamId: "t1", swarmStatus: "ACTIVE", swarmManagerId: "mgr1" };
    // change (null → c1): cleared
    const upd1 = jest.fn().mockResolvedValue({});
    const p1 = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "IMAGE", clusterId: null }), update: upd1 },
      cluster: { findUnique: jest.fn().mockResolvedValue(clusterRow) },
      server: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    await make(p1, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    expect(upd1.mock.calls[0][0].data.placement).toBeDefined(); // Prisma.JsonNull sentinel

    // same (c1 → c1): untouched
    const upd2 = jest.fn().mockResolvedValue({});
    const p2 = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "IMAGE", clusterId: "c1" }), update: upd2 },
      cluster: { findUnique: jest.fn().mockResolvedValue(clusterRow) },
      server: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    await make(p2, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    expect(upd2.mock.calls[0][0].data.placement).toBeUndefined();
  });
});

describe("ApplicationsService stateful auto-pin", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const stateful = (over = {}) => ({ ...app, source: "IMAGE", volumes: [{ name: "data", path: "/data" }], ...over });
  const clusterRow = { teamId: "t1", swarmStatus: "ACTIVE", swarmManagerId: "mgr1" };
  function ccDeps(appRow: object, cluster: object = clusterRow) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(appRow), update },
      cluster: { findUnique: jest.fn().mockResolvedValue(cluster) },
      server: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    return { prisma, update };
  }

  it("auto-pins a stateful app to the cluster manager instead of refusing it", async () => {
    const { prisma, update } = ccDeps(stateful());
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    expect(update.mock.calls[0][0].data).toMatchObject({ clusterId: "c1", constraintServerId: "mgr1" });
  });

  it("rejects replicas>1 for a stateful clustered app", async () => {
    const { prisma } = ccDeps(stateful());
    await expect(make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1", replicas: 3 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("clears the pin when leaving the cluster", async () => {
    const { prisma, update } = ccDeps(stateful({ clusterId: "c1", constraintServerId: "mgr1" }));
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: null });
    expect(update.mock.calls[0][0].data.constraintServerId).toBeNull();
  });

  it("explicitly nulls the pin for a stateless clustered app (never leaves a stale pin)", async () => {
    const { prisma, update } = ccDeps({ ...app, source: "IMAGE", volumes: [] });
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" });
    expect(update.mock.calls[0][0].data.constraintServerId).toBeNull();
  });

  it("rejects pinning a stateful app whose STORED replicas>1 even when the request omits replicas (P0 guard)", async () => {
    const { prisma } = ccDeps(stateful({ replicas: 3 }));
    await expect(make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("clears a stale pin when a stateless app moves to a DIFFERENT cluster", async () => {
    // was pinned to c1's manager while stateful; volumes since removed → now stateless, moving to c2
    const { prisma, update } = ccDeps({ ...app, source: "IMAGE", volumes: [], clusterId: "c1", constraintServerId: "mgr1" });
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c2" });
    expect(update.mock.calls[0][0].data.constraintServerId).toBeNull();
  });

  it("auto-pin also clears any user placement (a hard pin can't coexist with contradictory rules)", async () => {
    const { prisma, update } = ccDeps(stateful());
    await make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1", replicas: 1 });
    expect(update.mock.calls[0][0].data.placement).toBeDefined(); // Prisma.JsonNull sentinel
  });

  it("still refuses COMPOSE and GPU apps regardless of volumes", async () => {
    const c = ccDeps(stateful({ source: "COMPOSE" }));
    await expect(make(c.prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" })).rejects.toThrow(/compose/i);
    const g = ccDeps(stateful({ gpus: "all" }));
    await expect(make(g.prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" })).rejects.toThrow(/GPU/i);
  });

  it("refuses moving an app with a container command override into a cluster (swarm ignores it)", async () => {
    const o = ccDeps(stateful({ containerCommand: ["node", "server.js"] }));
    await expect(make(o.prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" })).rejects.toThrow(/container command/i);
  });

  it("throws when a stateful app targets a cluster with no swarm manager", async () => {
    const { prisma } = ccDeps(stateful(), { teamId: "t1", swarmStatus: "ACTIVE", swarmManagerId: null });
    await expect(make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" })).rejects.toThrow(/manager/i);
  });

  it("setVolumes auto-pins when adding storage to an already-clustered app (replicas 1)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1", replicas: 1 }), update },
      cluster: { findUnique: jest.fn().mockResolvedValue({ swarmManagerId: "mgr1" }) },
    } as unknown as PrismaService;
    await make(prisma, access, {} as AgentWsServer).setVolumes("u1", "app1", [{ name: "data", path: "/data" }]);
    expect(update.mock.calls[0][0].data.constraintServerId).toBe("mgr1");
  });

  it("setVolumes rejects adding storage when the clustered app has replicas>1", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1", replicas: 3 }), update },
      cluster: { findUnique: jest.fn().mockResolvedValue({ swarmManagerId: "mgr1" }) },
    } as unknown as PrismaService;
    await expect(make(prisma, access, {} as AgentWsServer).setVolumes("u1", "app1", [{ name: "data", path: "/data" }])).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setVolumes on a classic (non-cluster) app just persists, no cluster query", async () => {
    const update = jest.fn().mockResolvedValue({});
    const clusterFind = jest.fn();
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: null }), update },
      cluster: { findUnique: clusterFind },
    } as unknown as PrismaService;
    await make(prisma, access, {} as AgentWsServer).setVolumes("u1", "app1", [{ name: "data", path: "/data" }]);
    expect(clusterFind).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.constraintServerId).toBeUndefined();
  });
});

describe("ApplicationsService.scaleNow (live scale)", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const clustered = (over = {}) => ({ ...app, source: "IMAGE", clusterId: "c1", volumes: [], replicas: 1, ...over });
  function deps(appRow: object) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(appRow), update },
      cluster: { findUnique: jest.fn() },
      server: { findUnique: jest.fn() },
    } as unknown as PrismaService;
    return { prisma, update };
  }
  const scaleMock = (svc: object) => (svc as unknown as { swarmDeploy: { scale: jest.Mock } }).swarmDeploy.scale;

  it("applies the live scale FIRST (checks exit 0), THEN persists the count + audits app.scale", async () => {
    const { prisma, update } = deps(clustered());
    const svc = make(prisma, access, {} as AgentWsServer);
    scaleMock(svc).mockResolvedValue({ exitCode: 0, output: "" });
    await svc.scaleNow("u1", "app1", 3);
    expect(scaleMock(svc)).toHaveBeenCalledWith(expect.anything(), 3); // count passed as the arg
    expect(update.mock.calls[0][0].data).toMatchObject({ replicas: 3 }); // persisted after a successful apply
  });

  it("does NOT persist replicas (nor audit) when the live scale fails to converge (non-zero exit) — no stale desired-state", async () => {
    const { prisma, update } = deps(clustered());
    const svc = make(prisma, access, {} as AgentWsServer);
    scaleMock(svc).mockResolvedValue({ exitCode: 2, output: "timeout" });
    await expect(svc.scaleNow("u1", "app1", 3)).rejects.toThrow(/converge/i);
    expect(update).not.toHaveBeenCalled(); // the DB replica count is left untouched
  });

  it("clamps replicas to a minimum of 1", async () => {
    const { prisma, update } = deps(clustered());
    const svc = make(prisma, access, {} as AgentWsServer);
    scaleMock(svc).mockResolvedValue({ exitCode: 0, output: "" });
    await svc.scaleNow("u1", "app1", 0);
    expect(scaleMock(svc)).toHaveBeenCalledWith(expect.anything(), 1);
    expect(update.mock.calls[0][0].data.replicas).toBe(1);
  });

  it("refuses to scale a non-clustered (classic single-container) app", async () => {
    const { prisma } = deps({ ...app, source: "IMAGE", clusterId: null, volumes: [] });
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.scaleNow("u1", "app1", 2)).rejects.toThrow(/cluster-deployed|swarm/i);
    expect(scaleMock(svc)).not.toHaveBeenCalled();
  });

  it("refuses replicas>1 for a stateful (named-volume) clustered app", async () => {
    const { prisma } = deps(clustered({ volumes: [{ name: "data", path: "/data" }] }));
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.scaleNow("u1", "app1", 3)).rejects.toBeInstanceOf(BadRequestException);
    expect(scaleMock(svc)).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService.clusterStatus", () => {
  type WithSwarm = { swarmDeploy: { status: jest.Mock } };
  const ps = (tasks: object[]) => tasks.map((t) => JSON.stringify(t)).join("\n");

  it("returns desired vs running + the current-generation tasks for a clustered app", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1", replicas: 3 }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    (svc as unknown as WithSwarm).swarmDeploy.status.mockResolvedValue({
      exitCode: 0,
      output: ps([
        { Name: "tugra_app1.1", Node: "eu-1", DesiredState: "Running", CurrentState: "Running 4 minutes ago", Error: "" },
        { Name: "tugra_app1.2", Node: "eu-2", DesiredState: "Running", CurrentState: "Preparing", Error: "" },
        { Name: "tugra_app1.2", Node: "eu-2", DesiredState: "Shutdown", CurrentState: "Failed", Error: "boom" }, // old generation → filtered out
      ]),
    });
    const res = await svc.clusterStatus("u1", "app1");
    expect(res.reachable).toBe(true);
    expect(res.desired).toBe(3);
    expect(res.running).toBe(1); // only the "Running ..." task counts
    expect(res.tasks).toHaveLength(2); // both Running-desired tasks; the Shutdown-desired one dropped
    expect(res.tasks[0]).toMatchObject({ slot: "tugra_app1.1", node: "eu-1", currentState: "Running 4 minutes ago" });
  });

  it("desired defaults to 1 when replicas is null", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1", replicas: null }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    (svc as unknown as WithSwarm).swarmDeploy.status.mockResolvedValue({ exitCode: 0, output: "" });
    const res = await svc.clusterStatus("u1", "app1");
    expect(res.desired).toBe(1);
    expect(res.tasks).toEqual([]);
  });

  it("degrades gracefully (reachable:false) when the manager errors — never throws for the polling panel", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: "c1", replicas: 2 }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    (svc as unknown as WithSwarm).swarmDeploy.status.mockRejectedValue(new Error("manager offline"));
    const res = await svc.clusterStatus("u1", "app1");
    expect(res).toEqual({ desired: 2, running: 0, reachable: false, tasks: [] });
  });

  it("rejects an app that is not deployed to a cluster", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, clusterId: null }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).clusterStatus("u1", "app1")).rejects.toThrow(/not deployed to a cluster/);
  });
});

describe("ApplicationsService.listDomains", () => {
  it("returns domained apps with appId + appStatus for deep-linking", async () => {
    const svc = make({}, {}, {});
    jest.spyOn(svc, "list").mockResolvedValue([
      { id: "app1", teamId: "t1", name: "web", status: "RUNNING", domain: "shop.acme.dev", https: true, url: "https://shop.acme.dev", domainRedirect: null, securityHeaders: false },
      { id: "app2", teamId: "t1", name: "api", status: "STOPPED", domain: null }, // no domain → filtered out
    ] as never);

    const res = await svc.listDomains("u1");

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: "app1", appId: "app1", appStatus: "RUNNING", teamId: "t1", name: "web", domain: "shop.acme.dev" });
    expect(res[0].ssl.state).toBe("ok");
  });
});

describe("ApplicationsService listFiles", () => {
  const app = { id: "app1", teamId: "t1", serverId: "s1", volumes: [{ name: "data", path: "/data" }] };

  it("resolves the app's declared volume to its docker volume and sends a signed fs_req", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const listing = { entries: [{ name: "f", type: "file", size: 1, mode: "rw-r--r--", mtime: 2 }], truncated: false };
    const agentWs = {
      isOnline: jest.fn().mockReturnValue(true),
      sendFsReq: jest.fn().mockResolvedValue(listing),
    } as unknown as AgentWsServer;
    const res = await make(prisma, access, agentWs).listFiles("u1", "app1", "data", "sub/dir");
    expect(agentWs.sendFsReq).toHaveBeenCalledWith("s1", "list", "tugra_appv_app1_data", "sub/dir");
    expect(res).toEqual(listing);
  });

  it("rejects a volume the app does not declare (never an arbitrary docker volume)", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(true), sendFsReq: jest.fn() } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).listFiles("u1", "app1", "etc", "")).rejects.toBeInstanceOf(BadRequestException);
    expect(agentWs.sendFsReq).not.toHaveBeenCalled();
  });

  it("rejects an unsafe path before touching the agent", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(true), sendFsReq: jest.fn() } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).listFiles("u1", "app1", "data", "../escape")).rejects.toBeInstanceOf(BadRequestException);
    expect(agentWs.sendFsReq).not.toHaveBeenCalled();
  });

  it("surfaces an offline agent as 503 (never a raw 500)", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(false), sendFsReq: jest.fn() } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).listFiles("u1", "app1", "data", "")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(agentWs.sendFsReq).not.toHaveBeenCalled();
  });

  it("requires write permission (writer-only, like logs)", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(true), sendFsReq: jest.fn() } as unknown as AgentWsServer;
    await expect(make(prisma, access, agentWs).listFiles("u1", "app1", "data", "")).rejects.toBeInstanceOf(ForbiddenException);
    expect(agentWs.sendFsReq).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService resolveFsTarget / fsContext (file manager targets)", () => {
  const composeFile = [
    "services:",
    "  web:",
    "    image: nginx",
    "    volumes: [data:/data, ext:/e, custom:/c]",
    "volumes:",
    "  data: {}",
    "  ext:",
    "    external: true",
    "  custom:",
    "    name: someone-elses",
  ].join("\n");
  const single = { id: "app1", teamId: "t1", serverId: "s1", source: "IMAGE", status: "RUNNING", volumes: [{ name: "data", path: "/data" }], clusterId: null, constraintServerId: null };
  const compose = { ...single, source: "COMPOSE", composeFile, volumes: [] };

  function build(appRow: Record<string, unknown>, opts: { online?: boolean; activeDeploy?: boolean; perms?: Set<string> | null; requirePermission?: jest.Mock } = {}) {
    const findFirst = jest.fn().mockResolvedValue(opts.activeDeploy ? { id: "d1" } : null);
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(appRow) }, deployment: { findFirst } } as unknown as PrismaService;
    const requirePermission = opts.requirePermission ?? jest.fn().mockResolvedValue(undefined);
    const access = { requirePermission, membershipPermissions: jest.fn().mockResolvedValue(opts.perms === undefined ? OWNER_PERMS() : opts.perms) } as unknown as TeamAccessService;
    const agentWs = { isOnline: jest.fn().mockReturnValue(opts.online ?? true) } as unknown as AgentWsServer;
    return { svc: make(prisma, access, agentWs), requirePermission, findFirst, agentWs };
  }
  const read = { mutating: false };

  it("resolves a declared volume to its docker volume on the app's server (the listFiles resolution)", async () => {
    const { svc, requirePermission } = build(single);
    await expect(svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).resolves.toMatchObject({ serverId: "s1", scope: "volume", subject: "tugra_appv_app1_data" });
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(requirePermission).not.toHaveBeenCalledWith("u1", "t1", "terminal"); // volumes never need the terminal permission
  });

  it("refuses an undeclared volume, an external compose volume and a custom-named compose volume", async () => {
    await expect(build(single).svc.resolveFsTarget("u1", "app1", { volume: "etc" }, read)).rejects.toBeInstanceOf(BadRequestException);
    const c = build(compose).svc;
    await expect(c.resolveFsTarget("u1", "app1", { volume: "data" }, read)).resolves.toMatchObject({ subject: "tugra_app1_data" });
    await expect(c.resolveFsTarget("u1", "app1", { volume: "ext" }, read)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.resolveFsTarget("u1", "app1", { volume: "custom" }, read)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.resolveFsTarget("u1", "app1", { volume: "nope" }, read)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a clustered app targets its pinned node; unpinned is 400; offline is 503; a missing writer permission is 403", async () => {
    const clustered = { ...single, clusterId: "c1", constraintServerId: "s9" };
    await expect(build(clustered).svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).resolves.toMatchObject({ serverId: "s9" });
    await expect(build({ ...clustered, constraintServerId: null }).svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(single, { online: false }).svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const denied = jest.fn().mockRejectedValue(new ForbiddenException("nope"));
    await expect(build(single, { requirePermission: denied }).svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the container scope also needs the team permission `terminal`", async () => {
    const requirePermission = jest.fn(async (_u: string, _t: string, perm: string) => {
      if (perm === "terminal") throw new ForbiddenException("insufficient permission");
    });
    await expect(build(single, { requirePermission }).svc.resolveFsTarget("u1", "app1", { container: "" }, read)).rejects.toBeInstanceOf(ForbiddenException);
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "terminal");
    // and a user who has it resolves to the app's own container
    await expect(build(single).svc.resolveFsTarget("u1", "app1", { container: "ignored-by-single-container-apps" }, read)).resolves.toMatchObject({ scope: "container", subject: "tugra_app1", serverId: "s1" });
  });

  it("container scope: clustered apps are refused (400 unsupported_clustered), a NEW app is 409 not_deployed", async () => {
    const e1 = await build({ ...single, clusterId: "c1", constraintServerId: "s9" }).svc.resolveFsTarget("u1", "app1", { container: "" }, read).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BadRequestException);
    expect((e1 as BadRequestException).getResponse()).toMatchObject({ code: "unsupported_clustered" });
    const e2 = await build({ ...single, status: "NEW" }).svc.resolveFsTarget("u1", "app1", { container: "" }, read).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(ConflictException);
    expect((e2 as ConflictException).getResponse()).toMatchObject({ code: "not_deployed" });
    // volumes of a NEW app are still resolvable (the volume may exist before the first deploy completes)
    await expect(build({ ...single, status: "NEW" }).svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).resolves.toBeDefined();
  });

  it("container scope: a COMPOSE app must name a container of ITS OWN project; transient names never resolve", async () => {
    const svc = build(compose).svc;
    await expect(svc.resolveFsTarget("u1", "app1", { container: "tugra_app1-web-1" }, read)).resolves.toMatchObject({ subject: "tugra_app1-web-1" });
    for (const bad of ["", "tugra_other-web-1", "web", "tugra_app1-web-1; rm -rf /", "tugra_app1-web-1 x", "tugra_app10-web-1", "tugra_app1-web-1__rollout", "tugra_app1-web-1__prev"]) {
      await expect(svc.resolveFsTarget("u1", "app1", { container: bad }, read)).rejects.toBeInstanceOf(BadRequestException);
    }
    // a single-container app: even a client-supplied __rollout name is ignored (the server derives tugra_<id>)
    await expect(build(single).svc.resolveFsTarget("u1", "app1", { container: "tugra_app1__rollout" }, read)).resolves.toMatchObject({ subject: "tugra_app1" });
  });

  it("container scope surfaces an offline agent as 503", async () => {
    await expect(build(single, { online: false }).svc.resolveFsTarget("u1", "app1", { container: "" }, read)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("mutations are refused with 409 deploy_in_progress while a deploy is QUEUED/RUNNING; reads are not", async () => {
    const m = build(single, { activeDeploy: true });
    const err = await m.svc.resolveFsTarget("u1", "app1", { volume: "data" }, { mutating: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: "deploy_in_progress" });
    expect(m.findFirst).toHaveBeenCalledWith({ where: { appId: "app1", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    await expect(m.svc.resolveFsTarget("u1", "app1", { volume: "data" }, read)).resolves.toBeDefined();
    await expect(build(single, { activeDeploy: true }).svc.resolveFsTarget("u1", "app1", { container: "" }, { mutating: true })).rejects.toBeInstanceOf(ConflictException);
    await expect(build(single).svc.resolveFsTarget("u1", "app1", { volume: "data" }, { mutating: true })).resolves.toBeDefined();
  });

  it("an unknown app is 404", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    await expect(make(prisma, {}, {} as AgentWsServer).resolveFsTarget("u1", "x", { volume: "data" }, read)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("fsContext reports the terminal permission non-throwingly, the volume keys and the active-deploy flag", async () => {
    const a = await build(compose, { activeDeploy: true }).svc.fsContext("u1", "app1");
    expect(a).toMatchObject({ canTerminal: true, volumeKeys: ["data"], volumeServerId: "s1", deployInProgress: true });
    const b = await build(single, { perms: new Set(["apps:config"]) }).svc.fsContext("u1", "app1");
    expect(b).toMatchObject({ canTerminal: false, volumeKeys: ["data"], deployInProgress: false });
    const c = await build({ ...single, clusterId: "c1", constraintServerId: null }, { perms: null }).svc.fsContext("u1", "app1");
    expect(c).toMatchObject({ canTerminal: false, volumeServerId: null });
  });
});

describe("setDbNetwork + guards (S4d-4 managed-DB network link)", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;

  function prismaFor(appOverrides: Record<string, unknown>, dbCount = 1, linkCount = 0) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, ...appOverrides }), update },
      database: { count: jest.fn().mockResolvedValue(dbCount) },
      appDatabaseLink: { count: jest.fn().mockResolvedValue(linkCount) },
    } as unknown as PrismaService;
    return { prisma, update };
  }

  it("turns ON for a classic app that has a DB on its server, and persists dbNetwork=true", async () => {
    const { prisma, update } = prismaFor({ source: "IMAGE", clusterId: null, dockerOptions: null });
    await make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "app1" }, data: { dbNetwork: true } }));
  });

  it("refuses ON for a swarm/cluster app", async () => {
    const { prisma, update } = prismaFor({ clusterId: "c1" });
    await expect(make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", true)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses ON for a COMPOSE app", async () => {
    const { prisma, update } = prismaFor({ source: "COMPOSE" });
    await expect(make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", true)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses ON when docker options already set a --network", async () => {
    const { prisma, update } = prismaFor({ source: "IMAGE", dockerOptions: "--network host" });
    await expect(make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", true)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses ON for QUOTED/`=` network forms too (tokenized, not a raw-string regex)", async () => {
    for (const opt of ['"--network" host', "'--net=host'", "--net=bridge"]) {
      const { prisma, update } = prismaFor({ source: "IMAGE", dockerOptions: opt });
      await expect(make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", true)).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("refuses ON when no managed database sits on the app's server", async () => {
    const { prisma, update } = prismaFor({ source: "IMAGE" }, 0);
    await expect(make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", true)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("turns OFF when no databases are linked (no DB-presence check)", async () => {
    const { prisma, update } = prismaFor({ source: "IMAGE", dbNetwork: true }, 0, 0);
    await make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", false);
    expect(prisma.database.count).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { dbNetwork: false } }));
  });

  it("refuses OFF while databases are still linked (would break their injected URIs)", async () => {
    const { prisma, update } = prismaFor({ source: "IMAGE", dbNetwork: true }, 0, 2);
    await expect(make(prisma, access, {} as AgentWsServer).setDbNetwork("u1", "app1", false)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setDockerOptions refuses a --network while the app is DB-network-linked", async () => {
    const { prisma, update } = prismaFor({ dbNetwork: true });
    await expect(make(prisma, access, {} as AgentWsServer).setDockerOptions("u1", "app1", "--network host")).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("setClusterConfig refuses a swarm move while the app is DB-network-linked", async () => {
    const { prisma, update } = prismaFor({ dbNetwork: true, source: "IMAGE" });
    await expect(make(prisma, access, {} as AgentWsServer).setClusterConfig("u1", "app1", { clusterId: "c1" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService - custom icon", () => {
  // A minimal buffer validatePngIcon accepts: the 8-byte PNG signature + a canonical IHDR + the canonical
  // IEND terminator (validatePngIcon checks signature/IHDR/IEND + dims, not CRC/IDAT, so this suffices).
  // `pad` inserts junk between IHDR and IEND to grow the buffer for the oversize test.
  const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  function pngHeader(w: number, h: number, pad = 0): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "ascii");
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([sig, ihdr, Buffer.alloc(pad), IEND]);
  }
  const b64 = (buf: Buffer) => buf.toString("base64");
  const iconAccess = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue(Role.OWNER),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;

  function iconPrisma(icon: unknown = null) {
    const upsert = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({ count: icon ? 1 : 0 });
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app }), update },
      appIcon: { findUnique: jest.fn().mockResolvedValue(icon), upsert, deleteMany },
      $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    } as unknown as PrismaService;
    return { prisma, upsert, update, deleteMany };
  }

  it("stores a valid square PNG and stamps iconUpdatedAt", async () => {
    const { prisma, upsert, update } = iconPrisma();
    await make(prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(pngHeader(128, 128)));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { appId: "app1" }, create: expect.objectContaining({ mime: "image/png" }) }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "app1" }, data: { iconUpdatedAt: expect.any(Date) } }));
  });

  it("rejects a non-PNG payload (e.g. an SVG)", async () => {
    const { prisma, upsert } = iconPrisma();
    await expect(make(prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(Buffer.from("<svg>hello this is not a png</svg>")))).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-square PNG", async () => {
    const { prisma } = iconPrisma();
    await expect(make(prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(pngHeader(128, 64)))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects dimensions outside 32-512px", async () => {
    await expect(make(iconPrisma().prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(pngHeader(16, 16)))).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(iconPrisma().prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(pngHeader(1024, 1024)))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an icon over 64KB", async () => {
    const { prisma } = iconPrisma();
    await expect(make(prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(pngHeader(128, 128, 64 * 1024)))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a PNG missing the IEND terminator (header-only / truncated / garbage tail)", async () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "ascii");
    ihdr.writeUInt32BE(128, 8);
    ihdr.writeUInt32BE(128, 12);
    const noIend = Buffer.concat([sig, ihdr, Buffer.alloc(20)]); // valid header + junk, but no IEND chunk
    const { prisma, upsert } = iconPrisma();
    await expect(make(prisma, iconAccess, {} as AgentWsServer).setIcon("u1", "app1", b64(noIend))).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns stored bytes, and 404 when there is no icon", async () => {
    const stored = { mime: "image/png", data: pngHeader(64, 64), sizeBytes: 33 };
    await expect(make(iconPrisma(stored).prisma, iconAccess, {} as AgentWsServer).getIcon("u1", "app1")).resolves.toEqual({ mime: "image/png", data: expect.any(Buffer) });
    await expect(make(iconPrisma(null).prisma, iconAccess, {} as AgentWsServer).getIcon("u1", "app1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("removes the icon and clears the marker", async () => {
    const { prisma, deleteMany, update } = iconPrisma();
    await make(prisma, iconAccess, {} as AgentWsServer).deleteIcon("u1", "app1");
    expect(deleteMany).toHaveBeenCalledWith({ where: { appId: "app1" } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { iconUpdatedAt: null } }));
  });

  it("forbids upload without write permission", async () => {
    const denied = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    const { prisma, upsert } = iconPrisma();
    await expect(make(prisma, denied, {} as AgentWsServer).setIcon("u1", "app1", b64(pngHeader(128, 128)))).rejects.toBeInstanceOf(ForbiddenException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("forbids reading an icon for a non-member of the team", async () => {
    const denied = { teamRole: jest.fn().mockResolvedValue(null) } as unknown as TeamAccessService;
    const stored = { mime: "image/png", data: pngHeader(64, 64), sizeBytes: 45 };
    await expect(make(iconPrisma(stored).prisma, denied, {} as AgentWsServer).getIcon("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("forbids removing an icon without write permission", async () => {
    const denied = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    const { prisma, deleteMany } = iconPrisma();
    await expect(make(prisma, denied, {} as AgentWsServer).deleteIcon("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService.clone", () => {
  const server = { id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http", proxyBind: "public" };
  const src = {
    ...app,
    id: "src1",
    name: "shop",
    source: "IMAGE",
    image: "nginx",
    domain: "shop.example.com",
    domainKind: "custom",
    exposeMode: "custom",
    certType: "le-http",
    certPem: "PEM",
    certKeyEnc: "KEY",
    isPreview: false,
    envEnc: "ENVENC",
    gitTokenEnc: "GITENC",
    registryAuthEnc: null,
    buildArgsEnc: null,
    buildSecretsEnc: "BSENC",
    volumes: [{ name: "data", path: "/data" }],
    hostMounts: null,
    portMappings: null,
    placement: null,
    tags: ["x"],
    webhookToken: "srctok",
    hostPort: 8080,
    healthCheckMethod: "POST",
    healthCheckScheme: "https",
  };
  const clonePrisma = (over: Record<string, unknown> = {}) => {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(src), create },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      ...over,
    } as unknown as PrismaService;
    return { prisma, create };
  };

  it("copies the volume-backup cron/retention/size and per-volume policies, but the clone stays disabled", async () => {
    const createMany = jest.fn();
    const policies = [{ appId: "src1", volumeName: "data", enabled: true, intervalHours: null, cron: "0 4 * * *", retention: 3, retentionDays: 10, maxSizeGb: 5 }];
    const { prisma, create } = clonePrisma({
      application: {
        findUnique: jest.fn().mockResolvedValue({ ...src, volumeBackupEnabled: true, volumeBackupCron: "0 3 * * *", volumeBackupRetentionDays: 30, volumeBackupMaxSizeGb: 20 }),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() })),
      },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue(policies), createMany },
    });
    void create;
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    const data = (prisma.application.create as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({ volumeBackupCron: "0 3 * * *", volumeBackupRetentionDays: 30, volumeBackupMaxSizeGb: 20 });
    expect(data.volumeBackupEnabled).toBeUndefined(); // DB default false -> inert, no jobs scheduled
    expect(createMany).toHaveBeenCalledWith({
      data: [{ appId: "clone1", volumeName: "data", enabled: true, intervalHours: null, cron: "0 4 * * *", retention: 3, retentionDays: 10, maxSizeGb: 5 }],
    });
    expect(res.app).toBeDefined();
  });

  it("emits unknown container health for a fresh clone (no containers yet)", async () => {
    const { prisma } = clonePrisma();
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(res.app.containerHealth).toMatchObject({ state: "unknown", containers: 0, observedAt: null });
  });

  it("copies config + secrets verbatim, resets domain/cert/webhook/host-port, leaves status NEW", async () => {
    const { prisma, create } = clonePrisma();
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    const data = create.mock.calls[0][0].data;
    expect(data.name).toBe("shop (copy)");
    expect(data.envEnc).toBe("ENVENC"); // encrypted blob copied verbatim
    expect(data.gitTokenEnc).toBe("GITENC");
    expect(data.buildSecretsEnc).toBe("BSENC");
    expect(data.webhookToken).toBeDefined();
    expect(data.webhookToken).not.toBe("srctok"); // fresh webhook
    expect(data.certPem).toBeUndefined(); // custom cert NOT copied (DB default null)
    expect(data.domain).toBeNull(); // custom domain reset
    expect(data.domainKind).toBe("none");
    expect(data.status).toBeUndefined(); // DB default NEW — never deployed
    expect(data.isPreview).toBeUndefined(); // DB default false
    expect(data.hostPort).toBeNull(); // reset (would clash on the same server)
    expect(data.networkAliases).toEqual([]); // reset — a duplicate alias on the shared network collides
    expect(data.containerAlias).toBeNull(); // reset — duplicate on the shared network AND the (serverId, containerAlias) unique index
    expect(data.volumes).toEqual([{ name: "data", path: "/data" }]); // definition copied (fresh volume via new id)
    expect(data.healthCheckMethod).toBe("POST"); // HTTP method/scheme carried (else a POST/HTTPS-only app's clone fails its first gate)
    expect(data.healthCheckScheme).toBe("https");
    expect(res.warnings).toEqual(expect.arrayContaining(["domain_reset", "custom_cert_dropped", "host_port_reset"]));
  });

  it("copies the encrypted per-variable flags blob verbatim (a cloned multiline / build-only variable keeps its flags)", async () => {
    const blob = 'enc({"v":1,"flags":{"PEM":{"multiline":true},"TOK":{"buildTime":true,"runtime":false}}})';
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
    const { prisma } = clonePrisma({ application: { findUnique: jest.fn().mockResolvedValue({ ...src, envMetaEnc: blob }), create } });
    await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(create.mock.calls[0][0].data.envMetaEnc).toBe(blob);
    expect(create.mock.calls[0][0].data.envEnc).toBe("ENVENC");
    // a flag-free source stays flag-free
    const plain = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone2", createdAt: new Date() }));
    const p2 = clonePrisma({ application: { findUnique: jest.fn().mockResolvedValue({ ...src, envMetaEnc: null }), create: plain } });
    await make(p2.prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(plain.mock.calls[0][0].data.envMetaEnc).toBeNull();
  });

  it("rejects cloning a preview app", async () => {
    const { prisma } = clonePrisma({ application: { findUnique: jest.fn().mockResolvedValue({ ...src, isPreview: true }), create: jest.fn() } });
    await expect(make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires apps:config on the source (denied → Forbidden)", async () => {
    const { prisma } = clonePrisma();
    const denied = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) };
    await expect(make(prisma, denied, {} as AgentWsServer).clone("u1", "src1", {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("copies scheduled tasks DISABLED", async () => {
    const createMany = jest.fn();
    const { prisma } = clonePrisma({
      scheduledTask: { findMany: jest.fn().mockResolvedValue([{ id: "t1", appId: "src1", name: "cron", schedule: "0 3 * * *", command: "echo hi", enabled: true, timeoutSec: 1800 }]), createMany },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    });
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ appId: "clone1", enabled: false, command: "echo hi", timeoutSec: 1800 })] }); // per-task timeout carried
    expect(res.warnings).toContain("tasks_disabled");
  });

  it("honours a custom name (capped, no chaining)", async () => {
    const { prisma, create } = clonePrisma();
    await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", { name: "staging" });
    expect(create.mock.calls[0][0].data.name).toBe("staging");
  });

  it("clones to another server in the same team and resets the cluster/placement topology", async () => {
    const clustered = { ...src, clusterId: "c1", replicas: 3, placement: { type: "spread" }, constraintServerId: "s1", dbNetwork: true, hostMounts: [{ hostPath: "/mnt/media", containerPath: "/media", readOnly: false }] };
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(clustered), create },
      server: { findUnique: jest.fn().mockResolvedValue({ ...server, id: "s2", teamId: "t1" }) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    } as unknown as PrismaService;
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", { serverId: "s2" });
    const data = create.mock.calls[0][0].data;
    expect(data.serverId).toBe("s2");
    expect(data.clusterId).toBeNull(); // cluster topology belongs to the source server set
    expect(data.replicas).toBe(1);
    expect(data.constraintServerId).toBeNull();
    expect(data.dbNetwork).toBe(false); // DB-network opt-in resets — its managed-DB links aren't cloned
    expect(res.warnings).toEqual(expect.arrayContaining(["cloned_to_server", "cluster_config_reset", "host_mounts_copied"]));
  });

  it("a cross-server clone resets a cpuset the target can't satisfy (warning), keeps it when it fits or the core count is unknown, and never touches a same-server clone", async () => {
    const run = async (cores: number | null, target: string | undefined, cpuset = "0-5") => {
      const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...src, cpusetCpus: cpuset }), create },
        server: { findUnique: jest.fn().mockResolvedValue(target ? { ...server, id: target, teamId: "t1", cpuCores: cores } : { ...server, cpuCores: cores }) },
        appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
        volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      } as unknown as PrismaService;
      const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", target ? { serverId: target } : {});
      return { cpuset: create.mock.calls[0][0].data.cpusetCpus, warnings: res.warnings };
    };
    expect(await run(4, "s2")).toEqual({ cpuset: null, warnings: expect.arrayContaining(["cpuset_reset"]) });
    const fits = await run(8, "s2");
    expect(fits.cpuset).toBe("0-5");
    expect(fits.warnings).not.toContain("cpuset_reset");
    expect((await run(null, "s2")).cpuset).toBe("0-5"); // unknown core count: Docker decides at deploy
    const same = await run(4, undefined);
    expect(same.cpuset).toBe("0-5");
    expect(same.warnings).not.toContain("cpuset_reset");
  });

  it("a cross-server clone keeps gpus and warns only when the target is KNOWN to have no usable NVIDIA GPU", async () => {
    const mkInv = (gpus: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      v: 1, gpus, runtimes: [], defaultRuntime: null, nvidiaRuntime: false, nvidiaDriverLoaded: false, nvidiaModuleVersion: null, error: null, ...extra,
    });
    const dev = (o: Record<string, unknown>) => ({ index: null, uuid: null, name: "X", vendor: "amd", kind: "gpu", memoryMb: null, driver: null, pci: "0000:03:00.0", source: "pci", ...o });
    const smi = dev({ index: 0, vendor: "nvidia", source: "nvidia-smi", pci: null, memoryMb: 1, driver: "1.0" });
    const run = async (srcOver: Record<string, unknown>, target: string | undefined, gpuInventory: unknown) => {
      const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...src, gpus: "all", ...srcOver }), create },
        server: { findUnique: jest.fn().mockResolvedValue(target ? { ...server, id: target, teamId: "t1", gpuInventory } : { ...server, gpuInventory }) },
        appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
        volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      } as unknown as PrismaService;
      const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", target ? { serverId: target } : {});
      return { gpus: create.mock.calls[0][0].data.gpus, warnings: res.warnings };
    };
    const W = "gpus_unavailable_on_target";
    const none = await run({}, "s2", mkInv([]));
    expect(none.gpus).toBe("all"); // kept, never reset
    expect(none.warnings).toContain(W);
    expect((await run({}, "s2", mkInv([dev({})]))).warnings).toContain(W); // non_nvidia
    expect((await run({}, "s2", mkInv([dev({ vendor: "other", kind: "virtual" })]))).warnings).toContain(W); // virtual-only = none
    expect((await run({}, "s2", null)).warnings).not.toContain(W); // never probed = unknown, never nags
    expect((await run({}, "s2", { corrupt: true })).warnings).not.toContain(W); // malformed row = unknown
    expect((await run({}, "s2", mkInv([smi], { nvidiaRuntime: true }))).warnings).not.toContain(W); // ready
    expect((await run({}, undefined, mkInv([]))).warnings).not.toContain(W); // same-server clone
    expect((await run({ gpus: null }, "s2", mkInv([]))).warnings).not.toContain(W); // no GPU requested
    expect((await run({ clusterId: "c1" }, "s2", mkInv([]))).warnings).not.toContain(W); // cluster source
  });

  it("flags dropped privileged options with the machine key (not prose)", async () => {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...src, allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" }), create },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    } as unknown as PrismaService;
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(res.warnings).toContain("privileged_options_dropped");
  });

  it("keeps the cluster pin on a same-server clone (no target given)", async () => {
    const clustered = { ...src, clusterId: "c1", replicas: 3, constraintServerId: "s1" };
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(clustered), create },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    } as unknown as PrismaService;
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(create.mock.calls[0][0].data.clusterId).toBe("c1");
    expect(res.warnings).not.toContain("cloned_to_server");
  });

  it("rejects a target server in another team (no cross-team clone)", async () => {
    const { prisma } = clonePrisma({ server: { findUnique: jest.fn().mockResolvedValue({ ...server, id: "s2", teamId: "t2" }) } });
    await expect(make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", { serverId: "s2" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("clones into a target environment in the same team (used by environment clone)", async () => {
    const { prisma, create } = clonePrisma({
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e2", project: { teamId: "t1" } }) },
    });
    await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", { name: "web", environmentId: "e2" });
    expect(create.mock.calls[0][0].data.environmentId).toBe("e2");
  });

  it("rejects cloning into an environment in another team", async () => {
    const { prisma } = clonePrisma({
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e2", project: { teamId: "t2" } }) },
    });
    await expect(make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", { environmentId: "e2" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("clone into another environment checks the caller's access to the destination project", async () => {
    const { prisma, create } = clonePrisma({
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e2", project: { id: "p2", teamId: "t1" } }) },
    });
    const requireProjectAccess = jest.fn().mockResolvedValue(undefined);
    await make(prisma, { requireProjectAccess }, {} as AgentWsServer).clone("u1", "src1", { environmentId: "e2" });
    expect(requireProjectAccess).toHaveBeenCalledWith("u1", "t1", "p2");
    expect(create.mock.calls[0][0].data.environmentId).toBe("e2");
  });

  it("clone into a project the member has no grant for is refused (403) and creates nothing", async () => {
    const { prisma, create } = clonePrisma({
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e2", project: { id: "p2", teamId: "t1" } }) },
    });
    const requireProjectAccess = jest.fn().mockRejectedValue(new ForbiddenException("no access to this project"));
    await expect(
      make(prisma, { requireProjectAccess }, {} as AgentWsServer).clone("u1", "src1", { environmentId: "e2" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it("clone into the source's own environment never runs the destination checks", async () => {
    const envFind = jest.fn();
    const { prisma } = clonePrisma({
      environment: { findUnique: envFind },
      application: { findUnique: jest.fn().mockResolvedValue({ ...src, environmentId: "e1" }), create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() })) },
    });
    const requireProjectAccess = jest.fn();
    await make(prisma, { requireProjectAccess }, {} as AgentWsServer).clone("u1", "src1", { environmentId: "e1" });
    expect(envFind).not.toHaveBeenCalled();
    expect(requireProjectAccess).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService — COMPOSE-from-git", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const gitComposeApp = {
    ...app,
    source: "COMPOSE",
    composeFile: null,
    composePath: "docker-compose.yml",
    gitUrl: "https://github.com/u/r.git",
    gitBranch: "main",
    domain: null,
    clusterId: null,
    tunnelExposed: false,
    certType: "le-http",
    certPem: null,
    certKeyEnc: null,
    certDomains: [],
    extraDomains: [],
    templateSlug: null,
  };
  /** The render script's marker block for a given rendered compose (+ a deployed-commit marker). */
  const renderOutput = (compose: string) =>
    `Cloning into src...\nTUGRA_COMMIT=${"a".repeat(40)}\nTUGRA_COMMIT_MSG_B64=\nTUGRA_COMPOSE_RENDERED_B64=${b64(compose)}\nTUGRA_COMPOSE_SHA=${createHash("sha256").update(compose, "utf8").digest("hex")}\n`;

  function deployDeps(renderCompose: string) {
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(gitComposeApp), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const calls: { cmd: string; cap: string }[] = [];
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        calls.push({ cmd, cap });
        // The render call runs `docker compose … config`; everything else is the up.
        if (cmd.includes("config 2>/dev/null")) return Promise.resolve({ exitCode: 0, output: renderOutput(renderCompose) });
        return Promise.resolve({ exitCode: 0, output: `TUGRA_COMMIT=${"a".repeat(40)}\nup ok` });
      }),
    } as unknown as AgentWsServer;
    return { prisma, access, agentWs, depUpdate, appUpdate, calls };
  }

  it("renders on the agent, validates on the hub, then runs the sha-locked up", async () => {
    const compose = "services:\n  web:\n    image: nginx\n";
    const d = deployDeps(compose);
    await make(d.prisma, d.access, d.agentWs).deploy("u1", "app1");
    await flushMicrotasks();
    // Two agent calls: render (clone + `docker compose config`) then up.
    const deployCalls = d.calls.filter((c) => c.cap === "deploy");
    expect(deployCalls).toHaveLength(2);
    expect(deployCalls[0].cmd).toContain("git clone --depth 1 --branch 'main'");
    expect(deployCalls[0].cmd).toContain("config 2>/dev/null");
    // The up re-clones, re-renders and refuses unless the sha matches what the hub validated.
    const sha = createHash("sha256").update(compose, "utf8").digest("hex");
    expect(deployCalls[1].cmd).toContain(`[ "$TUGRA_SHA" = '${sha}' ]`);
    expect(deployCalls[1].cmd).toContain("up -d --build");
    expect(d.depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", commitSha: "a".repeat(40) }) }),
    );
  });

  it("refuses to run when the rendered stack would escape the host (FAILED, no up)", async () => {
    // A rendered compose that binds the docker socket must be rejected by assertSafeCompose → FAILED, and the
    // up script must never be sent (only the render call happened).
    const d = deployDeps("services:\n  web:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n");
    await make(d.prisma, d.access, d.agentWs).deploy("u1", "app1");
    await flushMicrotasks();
    const deployCalls = d.calls.filter((c) => c.cap === "deploy");
    expect(deployCalls).toHaveLength(1); // render only — the up was never issued
    expect(deployCalls[0].cmd).toContain("config 2>/dev/null");
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("a validate rejection on a RUNNING git-compose app marks it FAILED (the render rewrote the clone dir)", async () => {
    // The git-compose render re-clones (rm -rf's the clone dir, which can be the live stack's build/bind
    // source), so a render/validate failure is NOT a safe pre-swap failure — the app is marked FAILED.
    const running = { ...gitComposeApp, status: "RUNNING" };
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(running), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const escaping = "services:\n  web:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) =>
        cmd.includes("config 2>/dev/null") ? Promise.resolve({ exitCode: 0, output: renderOutput(escaping) }) : Promise.resolve({ exitCode: 0, output: "up ok" }),
      ),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    await flushMicrotasks();
    // render ran (swapAttempted) before the validate threw → fail-closed: deployment AND app are FAILED.
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    expect(appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  it("fails cleanly when the repo yields no rendered compose (bad path / invalid file)", async () => {
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(gitComposeApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const calls: string[] = [];
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
        if (cap === "deploy") calls.push(cmd);
        return Promise.resolve({ exitCode: 0, output: "no markers here" }); // render produced nothing parseable
      }),
    } as unknown as AgentWsServer;
    await make(prisma, access, agentWs).deploy("u1", "app1");
    await flushMicrotasks();
    expect(calls).toHaveLength(1); // render only
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("create persists composePath + gitUrl for a git compose and leaves composeFile null", async () => {
    const create = jest.fn().mockResolvedValue({ ...gitComposeApp });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", {
      name: "stack",
      serverId: "s1",
      source: "COMPOSE",
      gitUrl: "https://github.com/u/r.git",
      composePath: "deploy/docker-compose.yml",
    });
    expect(create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ source: "COMPOSE", gitUrl: "https://github.com/u/r.git", composePath: "deploy/docker-compose.yml", composeFile: null }),
    );
  });

  it("create defaults composePath to docker-compose.yml when omitted", async () => {
    const create = jest.fn().mockResolvedValue({ ...gitComposeApp });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).create("u1", {
      name: "stack",
      serverId: "s1",
      source: "COMPOSE",
      gitUrl: "https://github.com/u/r.git",
    });
    expect(create.mock.calls[0][0].data.composePath).toBe("docker-compose.yml");
  });
});

describe("ApplicationsService.pruneImages (keep-N, aliasing-safe)", () => {
  const prune = (svc: ReturnType<typeof make>) =>
    (svc as unknown as { pruneImages: (a: unknown) => Promise<void> }).pruneImages.bind(svc);
  const theApp = { ...app, id: "app1", serverId: "s1" };
  // newest-first rows d0..d(n-1), each with its own local tag.
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `d${i}`, status: "SUCCESS", imageTag: `tugra_app1:d${i}`, registryImage: null, createdAt: new Date(n - i) }));

  it("rmi's the stale (beyond newest-5) tags and nulls their records on success; keeps the newest 5", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue(rows(7)), update } } as unknown as PrismaService;
    const sent: string[] = [];
    const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
    await prune(make(prisma, {} as TeamAccessService, agentWs))(theApp);
    expect(sent.join("\n")).toContain("tugra_app1:d5");
    expect(sent.join("\n")).toContain("tugra_app1:d6");
    expect(update).toHaveBeenCalledWith({ where: { id: "d5" }, data: { imageTag: null } });
    expect(update).toHaveBeenCalledWith({ where: { id: "d6" }, data: { imageTag: null } });
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d0" } }));
  });

  it("does NOT null the record when the rmi fails — keeps the rollback record, retries next prune", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue(rows(6)), update } } as unknown as PrismaService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "boom" }) } as unknown as AgentWsServer;
    await prune(make(prisma, {} as TeamAccessService, agentWs))(theApp);
    expect(update).not.toHaveBeenCalled();
  });

  it("never rmi's a tag a RETAINED row still references (rollback aliasing) but still forgets the stale record", async () => {
    const deployments = [...rows(5), { id: "d5", status: "SUCCESS", imageTag: "tugra_app1:d0", registryImage: null, createdAt: new Date(0) }];
    const update = jest.fn().mockResolvedValue({});
    const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue(deployments), update } } as unknown as PrismaService;
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    await prune(make(prisma, {} as TeamAccessService, { sendCommand: send } as unknown as AgentWsServer))(theApp);
    expect(send).not.toHaveBeenCalled(); // d0's tag is protected by the kept window → no rmi
    expect(update).toHaveBeenCalledWith({ where: { id: "d5" }, data: { imageTag: null } });
  });

  it("also rmi's the registry ref (frees layers) while keeping registryImage in the DB for rollback-pull", async () => {
    const deployments = [...rows(5), { id: "d5", status: "SUCCESS", imageTag: "tugra_app1:d5", registryImage: "ghcr.io/org/tugra_app1:d5", createdAt: new Date(0) }];
    const update = jest.fn().mockResolvedValue({});
    const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue(deployments), update } } as unknown as PrismaService;
    let sent = "";
    const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent = cmd; return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
    await prune(make(prisma, {} as TeamAccessService, agentWs))(theApp);
    expect(sent).toContain("tugra_app1:d5");
    expect(sent).toContain("ghcr.io/org/tugra_app1:d5");
    expect(update).toHaveBeenCalledWith({ where: { id: "d5" }, data: { imageTag: null } }); // only imageTag nulled
  });

  it("honours a per-app imagesToKeep (keeps 2 instead of the default 5)", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue(rows(4)), update } } as unknown as PrismaService;
    const sent: string[] = [];
    const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
    await prune(make(prisma, {} as TeamAccessService, agentWs))({ ...theApp, imagesToKeep: 2 });
    // keep d0,d1 → remove d2,d3
    expect(update).toHaveBeenCalledWith({ where: { id: "d2" }, data: { imageTag: null } });
    expect(update).toHaveBeenCalledWith({ where: { id: "d3" }, data: { imageTag: null } });
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1" } }));
  });

  it("skips entirely while a deploy/rollback is in flight (a RUNNING row), to avoid racing it", async () => {
    const findMany = jest.fn().mockResolvedValue(rows(7));
    const update = jest.fn().mockResolvedValue({});
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const prisma = { deployment: { count: jest.fn().mockResolvedValue(1), findMany, update } } as unknown as PrismaService;
    await prune(make(prisma, {} as TeamAccessService, { sendCommand: send } as unknown as AgentWsServer))(theApp);
    expect(findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService.runtimeState", () => {
  const app = { id: "a1", teamId: "t1", serverId: "s1", clusterId: null, environmentId: "env1" };
  const stateRow = {
    containerName: "tugra_a1",
    status: "running",
    exitCode: 0,
    oomKilled: false,
    restartCount: 5,
    health: null,
    startedAt: new Date("2026-11-01T00:00:00.000Z"),
    finishedAt: null,
  };
  const eventRow = {
    id: "e1",
    containerName: "tugra_a1",
    ts: new Date("2026-11-05T00:00:00.000Z"),
    kind: "crash",
    exitCode: 137,
    oomKilled: false,
    restartCount: 5,
    restartDelta: 2,
    reason: "Killed — SIGKILL / OOM (137)",
    logTail: "panic: boom",
  };
  function prismaWith() {
    return {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      containerState: { findMany: jest.fn().mockResolvedValue([stateRow]) },
      containerEvent: { findMany: jest.fn().mockResolvedValue([eventRow]) },
    } as unknown as PrismaService;
  }

  it("maps states + events to ISO dates and returns the log tail for a privileged caller", async () => {
    const prisma = prismaWith();
    const svc = make(prisma, accessWith({}), {} as AgentWsServer); // OWNER perms incl. apps:config
    const res = await svc.runtimeState("u1", "a1", true);
    expect(res.containers[0]).toMatchObject({ containerName: "tugra_a1", restartCount: 5, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: null });
    expect(res.events[0]).toMatchObject({ kind: "crash", exitCode: 137, ts: "2026-11-05T00:00:00.000Z", logTail: "panic: boom", logRedacted: false });
    // Airtight prefix match (delimiter required so a sibling app id can't leak in); the rolling-deploy
    // candidate is matched exactly, and a non-cluster app carries NO swarm `.` clause.
    const where = (prisma.containerState.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.serverId).toEqual({ in: ["s1"] });
    expect(where.OR).toEqual([
      { containerName: "tugra_a1" },
      { containerName: "tugra_a1__rollout" },
      { containerName: { startsWith: "tugra_a1-" } },
    ]);
  });

  it("throws for a non-member (require → ForbiddenException)", async () => {
    const svc = make(prismaWith(), accessWith({ teamRole: jest.fn().mockResolvedValue(null) }), {} as AgentWsServer);
    await expect(svc.runtimeState("u1", "a1", true)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("redacts the log tail when the caller may not read secrets (includeLog=false)", async () => {
    const svc = make(prismaWith(), accessWith({}), {} as AgentWsServer);
    const res = await svc.runtimeState("u1", "a1", false);
    expect(res.events[0].logTail).toBeNull();
    expect(res.events[0].logRedacted).toBe(true);
  });

  it("redacts the log tail for a secrets-reader who lacks apps:config", async () => {
    const svc = make(prismaWith(), accessWith({ membershipPermissions: jest.fn().mockResolvedValue(new Set(["apps:deploy"])) }), {} as AgentWsServer);
    const res = await svc.runtimeState("u1", "a1", true);
    expect(res.events[0].logTail).toBeNull();
    expect(res.events[0].logRedacted).toBe(true);
  });

  it("queries every member server of a cluster app and adds the swarm `.` task clause", async () => {
    const clusterApp = { ...app, clusterId: "c1" };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(clusterApp) },
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]) },
      containerState: { findMany: jest.fn().mockResolvedValue([stateRow]) },
      containerEvent: { findMany: jest.fn().mockResolvedValue([eventRow]) },
    } as unknown as PrismaService;
    const svc = make(prisma, accessWith({}), {} as AgentWsServer);
    await svc.runtimeState("u1", "a1", true);
    expect(prisma.server.findMany as jest.Mock).toHaveBeenCalledWith({ where: { clusterId: "c1" }, select: { id: true } });
    const where = (prisma.containerState.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.serverId).toEqual({ in: ["s1", "s2"] });
    expect(where.OR).toEqual([
      { containerName: "tugra_a1" },
      { containerName: "tugra_a1__rollout" },
      { containerName: { startsWith: "tugra_a1-" } },
      { containerName: { startsWith: "tugra_a1." } },
    ]);
  });
});

// ── Durable at-most-once deploy ENQUEUE (Deployment.idempotencyKey) ─────────────────────────────────────────
//
// These exercise the DURABLE DB backstop directly — no Redis, no IdempotencyInterceptor in the path — so they
// prove the dedupe survives even when the in-flight interceptor is bypassed/flushed (a Redis flush / hub crash).
// The authority is the (appId, idempotencyKey) unique index; here we simulate it with a faithful in-memory store
// (create throws P2002 on a duplicate non-null key; findUnique resolves the compound accessor), plus bespoke
// mocks for the TOCTOU/race branches. Every app is kept "busy" (RUNNING count = 1) so claimNext returns null and
// submitDeploy returns the QUEUED row without pulling in the inline executeDeploy machinery.
describe("ApplicationsService / deploy idempotency (durable DB backstop)", () => {
  // Build a Prisma.P2002 the exact shape submitDeploy's guard checks (meta.target names the idempotencyKey index).
  const p2002 = (target: string[] = ["appId", "idempotencyKey"]) =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`appId`,`idempotencyKey`)", {
      code: "P2002",
      clientVersion: "test",
      meta: { target },
    });

  // A faithful in-memory deployment store: unique on (appId, non-null idempotencyKey), lookup by id or by the
  // compound accessor. RUNNING count is always 1 so the just-queued row never runs inline.
  function keyedStore() {
    const byId = new Map<string, Record<string, unknown>>();
    const byKey = new Map<string, Record<string, unknown>>();
    let seq = 0;
    const kkey = (appId: unknown, key: unknown) => `${String(appId)}\u0000${String(key)}`;
    return {
      byId,
      byKey,
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.idempotencyKey != null) {
          const k = kkey(data.appId, data.idempotencyKey);
          if (byKey.has(k)) throw p2002(); // the unique index rejects a duplicate non-null key
          const row = { id: `d${++seq}`, createdAt: new Date(), ...data };
          byKey.set(k, row);
          byId.set(row.id, row);
          return row;
        }
        const row = { id: `d${++seq}`, createdAt: new Date(), ...data }; // NULL key → never collides (NULLS DISTINCT)
        byId.set(row.id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: Record<string, { appId: string; idempotencyKey: string } | undefined> & { id?: string } }) => {
        if (where.appId_idempotencyKey) {
          const { appId, idempotencyKey } = where.appId_idempotencyKey;
          return byKey.get(kkey(appId, idempotencyKey)) ?? null;
        }
        if (where.id) return byId.get(where.id) ?? null;
        return null;
      }),
      // RUNNING → 1 (keep the app busy); any other status (QUEUED cap check) → 0 (well under QUEUE_CAP).
      count: jest.fn(async ({ where }: { where?: { status?: string } }) => (where?.status === "RUNNING" ? 1 : 0)),
    };
  }

  // application.findUnique resolves any app id to a {id, teamId} the deploy path accepts.
  const appFindUnique = () =>
    jest.fn(async ({ where }: { where: { id: string } }) => ({ ...app, id: where.id, teamId: "t1", source: "IMAGE" }));

  const buildSvc = (deployment: Record<string, jest.Mock>) =>
    make(
      {
        application: { findUnique: appFindUnique() },
        deployment,
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService,
      {} as Partial<TeamAccessService>,
      {} as AgentWsServer,
    );

  it("(core) same Idempotency-Key => at most ONE Deployment row; the retry returns the SAME row (interceptor bypassed)", async () => {
    const store = keyedStore();
    const svc = buildSvc(store as unknown as Record<string, jest.Mock>);

    const first = (await svc.deploy("u1", "app1", undefined, "idem-A")) as { id: string; idempotencyKey: string };
    const second = (await svc.deploy("u1", "app1", undefined, "idem-A")) as { id: string };

    expect(first.id).toBe(second.id); // idempotent: the retry resolves to the first row
    expect(first.idempotencyKey).toBe("idem-A"); // the raw client key is persisted on the row
    expect(store.create).toHaveBeenCalledTimes(1); // the second submit never inserted — pre-check short-circuited
    expect(store.byId.size).toBe(1); // exactly one Deployment row exists
  });

  it("concurrent duplicate submits resolve to exactly ONE row (loser catches P2002 and returns the winner)", async () => {
    const store = keyedStore();
    const svc = buildSvc(store as unknown as Record<string, jest.Mock>);

    const [a, b] = (await Promise.all([
      svc.deploy("u1", "app1", undefined, "race-K"),
      svc.deploy("u1", "app1", undefined, "race-K"),
    ])) as Array<{ id: string }>;

    expect(a.id).toBe(b.id); // both callers converge on the single winning row
    expect(store.byId.size).toBe(1); // no second row was persisted
  });

  it("P2002 on insert (TOCTOU: a concurrent winner slipped in after the pre-check) returns the EXISTING row, not a 500", async () => {
    const existing = { id: "winner", appId: "app1", status: "QUEUED", idempotencyKey: "toctou" };
    let findCalls = 0;
    const deployment = {
      // pre-check misses (null) the first time; the post-P2002 re-fetch finds the winner.
      findUnique: jest.fn(async ({ where }: { where: { id?: string; appId_idempotencyKey?: unknown } }) => {
        if (where.appId_idempotencyKey) return findCalls++ === 0 ? null : existing;
        return where.id === "winner" ? existing : null;
      }),
      create: jest.fn(async () => {
        throw p2002(); // the concurrent winner already holds the key
      }),
      count: jest.fn(async ({ where }: { where?: { status?: string } }) => (where?.status === "RUNNING" ? 1 : 0)),
    };
    const svc = buildSvc(deployment as unknown as Record<string, jest.Mock>);

    const res = (await svc.deploy("u1", "app1", undefined, "toctou")) as { id: string };
    expect(res.id).toBe("winner"); // idempotent response, no 500
    expect(deployment.create).toHaveBeenCalledTimes(1); // one failed insert, then return-existing (no retry needed)
  });

  it("a P2002 whose target is NOT the idempotencyKey index is re-thrown (never swallowed)", async () => {
    const deployment = {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => {
        throw p2002(["deployment_one_running_per_app"]); // a different unique conflict
      }),
      count: jest.fn(async ({ where }: { where?: { status?: string } }) => (where?.status === "RUNNING" ? 1 : 0)),
    };
    const svc = buildSvc(deployment as unknown as Record<string, jest.Mock>);
    await expect(svc.deploy("u1", "app1", undefined, "other-conflict")).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("race-after-delete: the conflicting keyed row is deleted in the gap => the bounded retry re-inserts exactly one row", async () => {
    let calls = 0;
    let created: Record<string, unknown> | null = null;
    const deployment = {
      // the key is never resolvable (the conflicting row was deleted); by-id resolves the eventual insert.
      findUnique: jest.fn(async ({ where }: { where: { id?: string; appId_idempotencyKey?: unknown } }) => {
        if (where.appId_idempotencyKey) return null;
        return where.id && created && created.id === where.id ? created : null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls++;
        if (calls === 1) throw p2002(); // first insert races a row that is then deleted
        created = { id: "retried", createdAt: new Date(), ...data };
        return created;
      }),
      count: jest.fn(async ({ where }: { where?: { status?: string } }) => (where?.status === "RUNNING" ? 1 : 0)),
    };
    const svc = buildSvc(deployment as unknown as Record<string, jest.Mock>);

    const res = (await svc.deploy("u1", "app1", undefined, "deleted-in-gap")) as { id: string };
    expect(res.id).toBe("retried"); // the retry re-inserted and succeeded
    expect(deployment.create).toHaveBeenCalledTimes(2); // exactly one retry (bounded, not unbounded)
  });

  it("(fail-open) NO Idempotency-Key => null key => two independent deploys are both allowed (today's behavior)", async () => {
    const store = keyedStore();
    const svc = buildSvc(store as unknown as Record<string, jest.Mock>);

    const a = (await svc.deploy("u1", "app1")) as { id: string; idempotencyKey: string | null };
    const b = (await svc.deploy("u1", "app1")) as { id: string; idempotencyKey: string | null };

    expect(a.id).not.toBe(b.id); // two distinct rows
    expect(a.idempotencyKey).toBeNull(); // keyless row stores NULL
    expect(b.idempotencyKey).toBeNull();
    expect(store.byId.size).toBe(2);
    expect(store.byKey.size).toBe(0); // no key ever constrained a keyless deploy
  });

  it("(fail-open) a blank/whitespace Idempotency-Key is treated as absent (no pre-check, no constraint)", async () => {
    const store = keyedStore();
    const svc = buildSvc(store as unknown as Record<string, jest.Mock>);

    const a = (await svc.deploy("u1", "app1", undefined, "   ")) as { id: string; idempotencyKey: string | null };
    const b = (await svc.deploy("u1", "app1", undefined, "")) as { id: string };

    expect(a.id).not.toBe(b.id);
    expect(a.idempotencyKey).toBeNull(); // whitespace normalized to null
    expect(store.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ appId_idempotencyKey: expect.anything() }) }));
  });

  it("different keys on the same app => two distinct rows", async () => {
    const store = keyedStore();
    const svc = buildSvc(store as unknown as Record<string, jest.Mock>);
    const a = (await svc.deploy("u1", "app1", undefined, "K1")) as { id: string };
    const b = (await svc.deploy("u1", "app1", undefined, "K2")) as { id: string };
    expect(a.id).not.toBe(b.id);
    expect(store.byId.size).toBe(2);
  });

  it("cross-app isolation: the SAME literal key on two different apps => two distinct rows (compound (appId,key) scope)", async () => {
    const store = keyedStore();
    const svc = buildSvc(store as unknown as Record<string, jest.Mock>);
    const a = (await svc.deploy("u1", "app1", undefined, "shared-literal")) as { id: string };
    const b = (await svc.deploy("u1", "app2", undefined, "shared-literal")) as { id: string };
    expect(a.id).not.toBe(b.id); // the same string on app1 and app2 does not collide
    expect(store.byId.size).toBe(2);
  });

  it("queue-full retry: a retry carrying an already-enqueued key returns the existing row (not a 'queue full' 409)", async () => {
    const existing = { id: "enqueued", appId: "app1", status: "QUEUED", idempotencyKey: "cap-K" };
    const deployment = {
      findUnique: jest.fn(async ({ where }: { where: { appId_idempotencyKey?: { idempotencyKey: string } } }) =>
        where.appId_idempotencyKey?.idempotencyKey === "cap-K" ? existing : null,
      ),
      create: jest.fn(), // must NOT be called — the pre-check returns before the cap check
      count: jest.fn(async ({ where }: { where?: { status?: string } }) => (where?.status === "QUEUED" ? 10 : 1)), // queue full
    };
    const svc = buildSvc(deployment as unknown as Record<string, jest.Mock>);
    const res = (await svc.deploy("u1", "app1", undefined, "cap-K")) as { id: string };
    expect(res.id).toBe("enqueued"); // returned the existing row despite a full queue
    expect(deployment.create).not.toHaveBeenCalled();
  });

  it("keyless submit at a full queue still 409s (the cap guard is unchanged for no-key traffic)", async () => {
    const deployment = {
      findUnique: jest.fn(async () => null),
      create: jest.fn(),
      count: jest.fn(async ({ where }: { where?: { status?: string } }) => (where?.status === "QUEUED" ? 10 : 0)),
    };
    const svc = buildSvc(deployment as unknown as Record<string, jest.Mock>);
    await expect(svc.deploy("u1", "app1")).rejects.toBeInstanceOf(ConflictException);
    expect(deployment.create).not.toHaveBeenCalled();
  });
});

// ── Migration SQL (durable backstop) is present and correctly shaped ────────────────────────────────────────
describe("Deployment.idempotencyKey migration SQL", () => {
  const sql = readFileSync(
    join(__dirname, "../../prisma/migrations/20261112120000_deployment_idempotency_key/migration.sql"),
    "utf8",
  );
  // Executable DDL only (drop `--` comment lines, which may legitimately discuss NULLS semantics in prose).
  const ddl = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  it("adds the nullable column and the compound unique index with the Prisma default name", () => {
    expect(ddl).toMatch(/ALTER TABLE "Deployment" ADD COLUMN "idempotencyKey" TEXT/);
    expect(ddl).toMatch(/CREATE UNIQUE INDEX "Deployment_appId_idempotencyKey_key" ON "Deployment"\("appId", "idempotencyKey"\)/);
  });

  it("relies on Postgres default NULLS DISTINCT — the DDL must NOT emit NULLS NOT DISTINCT (that would break fail-open)", () => {
    expect(ddl).not.toMatch(/NULLS NOT DISTINCT/i);
  });
});

// ── fleet rollout seams (rollouts/rollout-engine.service.ts drives these) ──
describe("ApplicationsService — rollout seams", () => {
  type Priv = {
    submitDeploy: (...a: unknown[]) => Promise<unknown>;
    executeDeploy: (...a: unknown[]) => Promise<unknown>;
    require: (...a: unknown[]) => Promise<unknown>;
    requireWrite: (...a: unknown[]) => Promise<unknown>;
  };
  const queued = { id: "dep1", appId: "app1", status: "QUEUED", trigger: "rollout", requestedBy: "u1", createdAt: new Date() };

  function deps() {
    const create = jest.fn().mockResolvedValue(queued);
    const findUnique = jest.fn(async (args: { where: Record<string, unknown> }) =>
      "id" in args.where ? { ...queued, status: "RUNNING", startedAt: new Date() } : null, // the claimed row; no prior keyed row
    );
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "IMAGE" }) },
      deployment: { create, findUnique, update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("MEMBER"),
      requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    return { prisma, access, create };
  }

  it("submitDeploy({detach}) returns the claimed RUNNING row at once and runs executeDeploy in the background; trigger is overridable", async () => {
    const { prisma, access, create } = deps();
    const svc = make(prisma, access, {} as AgentWsServer);
    let finish!: () => void;
    const executeDeploy = jest.spyOn(svc as unknown as Priv, "executeDeploy").mockReturnValue(new Promise<void>((r) => (finish = r)));
    const row = (await (svc as unknown as Priv).submitDeploy({ ...app, source: "IMAGE" }, "u1", false, "rollout:r1:app1:1", { detach: true, trigger: "rollout" })) as { status: string };
    expect(row.status).toBe("RUNNING"); // returned without awaiting the build
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({ status: "QUEUED", trigger: "rollout", requestedBy: "u1", idempotencyKey: "rollout:r1:app1:1" });
    finish();
  });

  it("without detach the same submit awaits executeDeploy (unchanged interactive contract)", async () => {
    const { prisma, access } = deps();
    const svc = make(prisma, access, {} as AgentWsServer);
    const executeDeploy = jest.spyOn(svc as unknown as Priv, "executeDeploy").mockResolvedValue({ id: "dep1", status: "SUCCESS" });
    const row = (await (svc as unknown as Priv).submitDeploy({ ...app, source: "IMAGE" }, "u1")) as { status: string };
    expect(row.status).toBe("SUCCESS");
    expect(executeDeploy).toHaveBeenCalledTimes(1);
  });

  it("deployDetached re-checks BOTH the per-resource scoping (require) and apps:deploy (requireWrite) on every call, then submits detached as a rollout", async () => {
    const { prisma, access } = deps();
    const svc = make(prisma, access, {} as AgentWsServer);
    const submit = jest.spyOn(svc as unknown as Priv, "submitDeploy").mockResolvedValue(queued);
    const dep = await svc.deployDetached("u1", "app1", { key: "rollout:r1:app1:2", noCache: true });
    expect(dep).toEqual(queued);
    expect(access.requireResourceAccess).toHaveBeenCalledWith("u1", "t1", expect.objectContaining({ resourceId: "app1" }));
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:deploy");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: "app1" }), "u1", true, "rollout:r1:app1:2", { detach: true, trigger: "rollout" });
    // a demoted initiator fails closed
    (access.requirePermission as jest.Mock).mockRejectedValueOnce(new ForbiddenException("nope"));
    await expect(svc.deployDetached("u1", "app1", { key: "rollout:r1:app1:3" })).rejects.toBeInstanceOf(ForbiddenException);
    // the key dedupes against a foreign row → refused, never adopted (and interactive deploys can't mint the namespace)
    submit.mockResolvedValueOnce({ ...queued, trigger: "manual", requestedBy: "attacker" });
    await expect(svc.deployDetached("u1", "app1", { key: "rollout:r1:app1:4" })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.deploy("u1", "app1", {}, "rollout:r1:app1:1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("cancelQueuedDeploymentSystem is a CAS on QUEUED (false once the deploy started); rolloutBaseline picks the newest rollbackable SUCCESS", async () => {
    const { access } = deps();
    const updateMany = jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    // No deployment.create here, so make() leaves the deployment stub alone (its queue wrapper always answers count 1).
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "IMAGE" }) },
      deployment: {
        updateMany,
        findMany: jest.fn().mockResolvedValue([
          { id: "new", imageTag: null, registryImage: null, imageDigest: null, configSnapshot: null }, // SUCCESS but artifact pruned → not rollbackable
          { id: "old", imageTag: "tugra_app1:old", registryImage: null, imageDigest: null, configSnapshot: null },
        ]),
      },
    } as unknown as PrismaService;
    const svc = make(prisma, access, {} as AgentWsServer);
    expect(await svc.cancelQueuedDeploymentSystem("dep1", "Cancelled: rollout halted")).toBe(true);
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "dep1", status: "QUEUED" }, data: { status: "CANCELLED", exitCode: -1 } });
    expect(await svc.cancelQueuedDeploymentSystem("dep1", "x")).toBe(false);
    expect(await svc.rolloutBaseline("app1")).toBe("old");
  });
});

describe("ApplicationsService — rollbackDetached (fleet rollback seam)", () => {
  const target = { id: "base", appId: "app1", status: "SUCCESS", imageTag: "tugra_app1:base", registryImage: null, imageDigest: null, commitSha: null, commitMessage: null };
  function deps(opts: { prior?: Record<string, unknown> | null; running?: boolean } = {}) {
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: "rb1", createdAt: new Date(), ...args.data }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, status: "RUNNING", source: "IMAGE" }), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findUnique: jest.fn(async (args: { where: Record<string, unknown> }) => ("appId_idempotencyKey" in args.where ? (opts.prior ?? null) : { id: "rb1", status: "SUCCESS" })),
        findFirst: jest.fn(async ({ where }: { where: { status: string } }) => (where.status === "RUNNING" ? (opts.running ? { id: "busy" } : null) : target)),
        create,
        update: jest.fn().mockResolvedValue({}),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("MEMBER"),
      requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    let release!: (v: { exitCode: number; output: string }) => void;
    const sendCommand = jest.fn().mockReturnValue(new Promise<{ exitCode: number; output: string }>((r) => (release = r)));
    const agentWs = { sendCommand } as unknown as AgentWsServer;
    return { prisma, access, agentWs, create, sendCommand, release: () => release({ exitCode: 0, output: "up" }) };
  }

  it("returns the RUNNING rollback row at once (agent command still in flight), keyed + marked as a rollout dispatch, then finishes in the background", async () => {
    const d = deps();
    const svc = make(d.prisma, d.access, d.agentWs);
    const dep = await svc.rollbackDetached("u1", "app1", "base", { key: "rollout:rb:r1:app1:1" });
    expect(dep).toMatchObject({ status: "RUNNING", kind: "ROLLBACK", trigger: "rollout", requestedBy: "u1", idempotencyKey: "rollout:rb:r1:app1:1" });
    expect(d.access.requireResourceAccess).toHaveBeenCalled();
    expect(d.access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:deploy");
    await new Promise((r) => setImmediate(r)); // the detached execute reaches the agent command on its own
    expect(d.sendCommand).toHaveBeenCalledTimes(1); // dispatched, not awaited by the caller
    d.release();
    await new Promise((r) => setImmediate(r));
    expect((d.prisma.deployment.update as jest.Mock).mock.calls.at(-1)![0].data).toMatchObject({ status: "SUCCESS", imageTag: "tugra_app1:base" });
  });

  it("swarm apps are refused; a lost one-RUNNING race is AppBusy, a lost KEY race adopts the winner's row", async () => {
    const p2002 = (target: string[]) => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x", meta: { target } });
    const swarm = deps();
    (swarm.prisma.application.findUnique as jest.Mock).mockResolvedValue({ ...app, status: "RUNNING", source: "IMAGE", clusterId: "c1" });
    await expect(make(swarm.prisma, swarm.access, swarm.agentWs).rollbackDetached("u1", "app1", "base", { key: "k" })).rejects.toThrow(/swarm/);
    const busyRace = deps();
    busyRace.create.mockRejectedValueOnce(p2002(["appId"]));
    await expect(make(busyRace.prisma, busyRace.access, busyRace.agentWs).rollbackDetached("u1", "app1", "base", { key: "k" })).rejects.toBeInstanceOf(AppBusyException);
    const keyRace = deps();
    keyRace.create.mockRejectedValueOnce(p2002(["appId", "idempotencyKey"]));
    (keyRace.prisma.deployment.findUnique as jest.Mock).mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "appId_idempotencyKey" in args.where ? { id: "winner", status: "RUNNING", trigger: "rollout", requestedBy: "u1" } : null,
    );
    // first lookup (pre-check) must see nothing, the post-P2002 lookup the winner
    (keyRace.prisma.deployment.findUnique as jest.Mock).mockResolvedValueOnce(null);
    expect((await make(keyRace.prisma, keyRace.access, keyRace.agentWs).rollbackDetached("u1", "app1", "base", { key: "k" })).id).toBe("winner");
  });

  it("a throw BEFORE the agent command (e.g. proxy/offline) fails the rollback row but never flips a still-serving app to FAILED", async () => {
    const d = deps();
    d.sendCommand.mockRejectedValue(new ServiceUnavailableException("agent offline")); // the throw happens at dispatch → app FAILED is legitimate…
    const svc = make(d.prisma, d.access, d.agentWs);
    await svc.rollbackDetached("u1", "app1", "base", { key: "k1" });
    await new Promise((r) => setImmediate(r));
    expect((d.prisma.deployment.update as jest.Mock).mock.calls.at(-1)![0].data).toMatchObject({ status: "FAILED" });
    // …but a pre-dispatch failure (ensureProxy for a domained app) leaves the app's status alone
    const pre = deps();
    (pre.prisma.application.findUnique as jest.Mock).mockResolvedValue({ ...app, status: "RUNNING", source: "IMAGE", domain: "a.example.com" });
    const svc2 = make(pre.prisma, pre.access, pre.agentWs);
    (svc2 as unknown as { proxy: { ensureProxy: jest.Mock } }).proxy.ensureProxy.mockRejectedValue(new Error("proxy down"));
    await svc2.rollbackDetached("u1", "app1", "base", { key: "k2" });
    await new Promise((r) => setImmediate(r));
    expect(pre.sendCommand).not.toHaveBeenCalled();
    expect((pre.prisma.deployment.update as jest.Mock).mock.calls.at(-1)![0].data).toMatchObject({ status: "FAILED" });
    expect(pre.prisma.application.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  it("is at-most-once per key: a prior row with the key is returned (ours) or refused (foreign); a busy app is a 409 before any row is written", async () => {
    const ours = deps({ prior: { id: "rbPrior", status: "RUNNING", trigger: "rollout", requestedBy: "u1" } });
    expect((await make(ours.prisma, ours.access, ours.agentWs).rollbackDetached("u1", "app1", "base", { key: "k" })).id).toBe("rbPrior");
    expect(ours.create).not.toHaveBeenCalled();
    const foreign = deps({ prior: { id: "x", status: "SUCCESS", trigger: "rollback", requestedBy: "someone" } });
    await expect(make(foreign.prisma, foreign.access, foreign.agentWs).rollbackDetached("u1", "app1", "base", { key: "k" })).rejects.toBeInstanceOf(ConflictException);
    const busy = deps({ running: true });
    await expect(make(busy.prisma, busy.access, busy.agentWs).rollbackDetached("u1", "app1", "base", { key: "k" })).rejects.toBeInstanceOf(AppBusyException);
    expect(busy.create).not.toHaveBeenCalled();
  });
});

describe("ApplicationsService — durable dispatch + hub-crash adoption (ACTION-LIST #2)", () => {
  const { AgentDisconnectedException: Disconnected } = jest.requireActual("../agent-gateway/agent-offline.exception") as typeof import("../agent-gateway/agent-offline.exception");

  /** A queue-model prisma for one deploy of `app`, recording every deployment.updateMany call. */
  function deps(appOver: Record<string, unknown> = {}) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const depUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, ...appOver }), update: appUpdate },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date(), startedAt: new Date() }),
        update: depUpdate,
        updateMany,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "RUNNING" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    return { prisma, access, updateMany, depUpdate, appUpdate };
  }
  const dispatchCalls = (updateMany: jest.Mock) => updateMany.mock.calls.map((c) => c[0]).filter((a) => a.data?.phase === "DISPATCHED");

  it("OLD agent (no cmd_journal_v1): the legacy call shape — no reqId/durable/beforeSend, no lease columns written at dispatch", async () => {
    const d = deps();
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    await make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(false) }).deploy("u1", "app1");
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "deploy", 300000, expect.any(Function), expect.any(Function));
    expect(sendCommand.mock.calls[0]).toHaveLength(6);
    expect(dispatchCalls(d.updateMany)).toEqual([]);
  });

  it("journaling agent: the row is CAS-stamped (phase DISPATCHED, reqId dep-<id>, server, deadline, frozen plan) BEFORE the frame goes out, and the command is sent durable", async () => {
    const d = deps();
    const order: string[] = [];
    d.updateMany.mockImplementation(async (args: { data?: { phase?: string } }) => {
      if (args.data?.phase === "DISPATCHED") order.push("cas");
      return { count: 1 };
    });
    const sendCommand = jest.fn().mockImplementation(async (_s: string, _c: string, _cap: string, _t: number, _chunk: unknown, _start: unknown, opts?: { reqId?: string; durable?: boolean; beforeSend?: (r: string) => Promise<void> }) => {
      if (opts?.beforeSend) await opts.beforeSend(opts.reqId ?? "x");
      order.push("send");
      return { exitCode: 0, output: "deployed" };
    });
    await make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(true) }).deploy("u1", "app1");
    expect(order).toEqual(["cas", "send"]);
    const opts = sendCommand.mock.calls[0][6];
    expect(opts).toMatchObject({ reqId: "dep-d1", durable: true });
    const cas = dispatchCalls(d.updateMany)[0];
    expect(cas.where).toEqual({ id: "d1", status: "RUNNING", ownerId: TEST_BOOT_ID });
    expect(cas.data).toMatchObject({ phase: "DISPATCHED", agentReqId: "dep-d1", agentServerId: "s1", deadlineAt: expect.any(Date) });
    expect(cas.data.deadlineAt.getTime()).toBeGreaterThan(Date.now() + 300_000); // agent timeout + slack
    expect(cas.data.dispatchPlan).toMatchObject({ v: 1, isCompose: false, rolling: false, gitSourced: false, runTag: "tugra_app1:d1", wasRunning: false });
    // the live result is still settled exactly as before
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", exitCode: 0 }) }));
  });

  it("a soak-enabled rolling app's DISPATCHED deadlineAt covers deploy timeout + soak budget + the 120 s slack", async () => {
    const d = deps({ domain: "app.example.com", deployStrategy: "ROLLING", rollbackOnFailure: true, volumes: null, extraPorts: null, postCutoverSoakSec: 30 });
    const sendCommand = jest.fn().mockImplementation(async (_s: string, _c: string, _cap: string, _t: number, _chunk: unknown, _start: unknown, opts?: { reqId?: string; beforeSend?: (r: string) => Promise<void> }) => {
      if (opts?.beforeSend) await opts.beforeSend(opts.reqId ?? "x");
      return { exitCode: 0, output: "deployed" };
    });
    const before = Date.now();
    await make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(true) }).deploy("u1", "app1");
    const cas = dispatchCalls(d.updateMany)[0];
    // 30 s window at the 3 s default interval = 10 probes x (3 s + 5 s probe timeout) + 30 s tail = 110 s
    const soakBudgetMs = (10 * (3 + 5) + 30) * 1000;
    expect(cas.data.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 300_000 + soakBudgetMs + 120_000);
    expect(sendCommand.mock.calls[0][3]).toBeGreaterThanOrEqual(300_000 + soakBudgetMs);
  });

  it("a lost lease (CAS count 0) aborts BEFORE anything reaches the agent", async () => {
    const d = deps();
    d.updateMany.mockImplementation(async (args: { data?: { phase?: string } }) => ({ count: args.data?.phase === "DISPATCHED" ? 0 : 1 }));
    let sent = false;
    const sendCommand = jest.fn().mockImplementation(async (_s: string, _c: string, _cap: string, _t: number, _chunk: unknown, _start: unknown, opts?: { beforeSend?: (r: string) => Promise<void> }) => {
      await opts?.beforeSend?.("dep-d1"); // throws → the gateway never writes the frame
      sent = true;
      return { exitCode: 0, output: "" };
    });
    await make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(true) }).deploy("u1", "app1");
    expect(sent).toBe(false);
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", logs: expect.stringContaining("lease lost") }) }));
  });

  it("agent socket drops mid-command: the lease is RELEASED (ownerId null, phase RECOVERING), NO FAILED row, NO app status write, and the recovery hook fires", async () => {
    const d = deps({ status: "RUNNING" });
    const sendCommand = jest.fn().mockImplementation(async (_s: string, _c: string, _cap: string, _t: number, _chunk: unknown, _start: unknown, opts?: { beforeSend?: (r: string) => Promise<void> }) => {
      await opts?.beforeSend?.("dep-d1");
      throw new Disconnected();
    });
    const svc = make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(true) });
    const hook = jest.fn();
    svc.setLeaseReleasedHook(hook);
    await svc.deploy("u1", "app1");
    expect(d.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "RUNNING", ownerId: TEST_BOOT_ID }, data: { ownerId: null, phase: "RECOVERING" } });
    expect(d.depUpdate.mock.calls.map((c) => c[0].data?.status).filter(Boolean)).toEqual([]);
    expect(d.appUpdate).not.toHaveBeenCalled();
    expect(hook).toHaveBeenCalledWith("s1");
  });

  it("a socket drop on an OLD agent (nothing journaled) keeps today's behaviour: FAILED + app FAILED (live state unknown)", async () => {
    const d = deps({ status: "RUNNING" });
    const sendCommand = jest.fn().mockRejectedValue(new Disconnected());
    await make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(false) }).deploy("u1", "app1");
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    expect(d.appUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "FAILED" } }));
  });

  describe("finalizeAdopted / settleInterrupted", () => {
    const plan = { v: 1, rolling: false, recreate: true, isCompose: false, hadPrev: true, isGitCompose: false, gitSourced: true, runTag: "tugra_app1:d1", registryRef: null, wasRunning: true, postDeploy: false, buildLogHead: null };
    const row = (over: Record<string, unknown> = {}) => ({ id: "d1", appId: "app1", status: "RUNNING", kind: "DEPLOY", requestedBy: "u1", startedAt: new Date(Date.now() - 5000), createdAt: new Date(Date.now() - 6000), dispatchPlan: plan, ownerId: TEST_BOOT_ID, phase: "DISPATCHED", agentReqId: "dep-d1", agentServerId: "s1", ...over }) as never;
    function fx(count = 1) {
      const updateMany = jest.fn().mockResolvedValue({ count });
      const appUpdate = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(app), update: appUpdate },
        deployment: { updateMany, count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
        server: { findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      const deployLogs = makeDeployLogs();
      const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
      const svc = make(prisma, {}, { sendCommand }, deployLogs);
      return { svc, updateMany, appUpdate, deployLogs, sendCommand };
    }
    const guard = { id: "d1", status: "RUNNING", ownerId: TEST_BOOT_ID };

    it("exit 0 → SUCCESS with the plan's tag, digest/commit parsed from the journaled output, app RUNNING, log finished, lease cleared", async () => {
      const f = fx();
      await f.svc.finalizeAdopted(row(), { exitCode: 0, output: "TUGRA_COMMIT=abc1234\nTUGRA_DIGEST=nginx@sha256:aaaa\nok", killed: false });
      expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: guard, data: expect.objectContaining({ status: "SUCCESS", kind: "DEPLOY", exitCode: 0, imageTag: "tugra_app1:d1", imageDigest: "nginx@sha256:aaaa", commitSha: "abc1234", ownerId: null, phase: null, durationMs: expect.any(Number) }) }));
      expect(f.appUpdate).toHaveBeenCalledWith({ where: { id: "app1" }, data: { status: "RUNNING" } });
      expect(f.deployLogs.finish).toHaveBeenCalledWith("app1", expect.objectContaining({ status: "SUCCESS", deploymentId: "d1" }));
    });

    it("exit 3 with a previous image (frozen in the plan) → FAILED + AUTO_ROLLBACK, app stays RUNNING; exit 1 → FAILED and app FAILED", async () => {
      const a = fx();
      await a.svc.finalizeAdopted(row(), { exitCode: 3, output: "gate failed", killed: false });
      expect(a.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "AUTO_ROLLBACK", imageTag: null }) }));
      expect(a.appUpdate).toHaveBeenCalledWith({ where: { id: "app1" }, data: { status: "RUNNING" } });
      const b = fx();
      await b.svc.finalizeAdopted(row(), { exitCode: 1, output: "boom", killed: false });
      expect(b.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "DEPLOY" }) }));
      expect(b.appUpdate).toHaveBeenCalledWith({ where: { id: "app1" }, data: { status: "FAILED" } });
      // the failed image tag is reaped, as on the live path
      expect(b.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("tugra_app1:d1"), "cleanup");
    });

    it("killed (command_cancel) → CANCELLED, never FAILED, app status untouched", async () => {
      const f = fx();
      await f.svc.finalizeAdopted(row(), { exitCode: 137, output: "killed", killed: true });
      expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: guard, data: expect.objectContaining({ status: "CANCELLED", logs: expect.stringContaining("Cancelled by user"), ownerId: null, phase: null }) }));
      expect(f.appUpdate).not.toHaveBeenCalled();
    });

    it("judges by the FROZEN plan, not today's config: a plan without a previous image makes exit 3 a hard failure even though the app now has rollbackOnFailure", async () => {
      const f = fx();
      await f.svc.finalizeAdopted(row({ dispatchPlan: { ...plan, hadPrev: false } }), { exitCode: 3, output: "", killed: false });
      expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", kind: "DEPLOY" }) }));
      expect(f.appUpdate).toHaveBeenCalledWith({ where: { id: "app1" }, data: { status: "FAILED" } });
    });

    it("CAS miss (someone else settled it) writes nothing more; an unreadable plan settles as interrupted; a gone app is a no-op", async () => {
      const f = fx(0);
      await f.svc.finalizeAdopted(row(), { exitCode: 0, output: "", killed: false });
      expect(f.appUpdate).not.toHaveBeenCalled();
      expect(f.deployLogs.finish).not.toHaveBeenCalled();
      const g = fx();
      await g.svc.finalizeAdopted(row({ dispatchPlan: { nope: true } }), { exitCode: 0, output: "", killed: false });
      expect(g.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", exitCode: -1, logs: expect.stringContaining("Deployment interrupted") }) }));
      expect(g.appUpdate).not.toHaveBeenCalled();
      const h = fx();
      (h.svc as unknown as { prisma: { application: { findUnique: jest.Mock } } }).prisma.application.findUnique.mockResolvedValue(null);
      await h.svc.finalizeAdopted(row(), { exitCode: 0, output: "", killed: false });
      expect(h.updateMany).not.toHaveBeenCalled();
    });

    it("settleInterrupted writes the legacy boot-reap shape (FAILED, -1, note + detail), clears the lease, never touches the app, and drains", async () => {
      const f = fx();
      await expect(f.svc.settleInterrupted({ id: "d1", appId: "app1" }, "the agent restarted")).resolves.toBe(true);
      expect(f.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "RUNNING" }, data: { status: "FAILED", exitCode: -1, logs: expect.stringMatching(/^Deployment interrupted:.*\nthe agent restarted$/s), ownerId: null, phase: null } });
      expect(f.appUpdate).not.toHaveBeenCalled();
      expect(f.deployLogs.finish).toHaveBeenCalledWith("app1", { status: "FAILED", exitCode: -1, deploymentId: "d1" });
    });
  });

  it("cancelDeployment falls back to the row's persisted command handle for a durable deploy no in-memory command tracks (owned by a dead hub / being adopted)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ id: "app1", teamId: "t1" }) },
      deployment: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue({ id: "d1", status: "RUNNING", phase: "RECOVERING", agentReqId: "dep-d1", agentServerId: "s7" }),
        findUnique: jest.fn(),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { cancelCommand: jest.fn().mockReturnValue(true), sendCommand: jest.fn() } as unknown as AgentWsServer;
    const svc = make(prisma, access, agentWs);
    const row = await svc.cancelDeployment("u1", "app1", "d1");
    expect((row as { status: string }).status).toBe("RUNNING");
    expect(agentWs.cancelCommand).toHaveBeenCalledWith("s7", "dep-d1");
    // not driven by this process → no in-memory intent is recorded (the agent's journal `killed` flag decides)
    expect((svc as unknown as { cancelRequested: Set<string> }).cancelRequested.has("d1")).toBe(false);
    // the agent is offline → the kill cannot be delivered → 503, never a silent "cancelled" the deploy then outlives
    (agentWs.cancelCommand as jest.Mock).mockReturnValue(false);
    await expect(make(prisma, access, agentWs).cancelDeployment("u1", "app1", "d1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    // a pre-dispatch (CLAIMED) orphan still 409s: nothing is running on any agent for it
    (prisma.deployment.findFirst as jest.Mock).mockResolvedValue({ id: "d1", status: "RUNNING", phase: "CLAIMED", agentReqId: null, agentServerId: null });
    await expect(make(prisma, access, agentWs).cancelDeployment("u1", "app1", "d1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("cancel requested + socket drop: the lease is STILL released (the kill may never have reached the agent) — the journal's killed flag decides on adoption", async () => {
    const d = deps({ status: "RUNNING" });
    const ref: { svc?: ApplicationsService } = {};
    const sendCommand = jest.fn().mockImplementation(async (_s: string, _c: string, _cap: string, _t: number, _chunk: unknown, onStart: (r: string) => void, opts?: { beforeSend?: (r: string) => Promise<void> }) => {
      await opts?.beforeSend?.("dep-d1");
      onStart("dep-d1");
      (ref.svc as unknown as { cancelRequested: Set<string> }).cancelRequested.add("d1"); // a cancel landed while the command ran
      throw new Disconnected();
    });
    ref.svc = make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(true), cancelCommand: jest.fn().mockReturnValue(true) });
    await ref.svc.deploy("u1", "app1");
    expect(d.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "RUNNING", ownerId: TEST_BOOT_ID }, data: { ownerId: null, phase: "RECOVERING" } });
    expect(d.depUpdate.mock.calls.map((c) => c[0].data?.status).filter(Boolean)).toEqual([]); // no CANCELLED/FAILED guess
  });

  it("the frozen plan records a configured post-deploy hook and the build-server phase output head", async () => {
    const d = deps({ postDeployCommand: "npm run migrate", buildServerId: "b1", registryId: "reg1", pushToRegistry: true, source: "GIT", gitUrl: "https://x/y.git" });
    (d.prisma as unknown as { registry: unknown }).registry = { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }) };
    const sendCommand = jest.fn().mockImplementation(async (server: string, _c: string, _cap: string, _t: number, _chunk: unknown, _start: unknown, opts?: { beforeSend?: (r: string) => Promise<void> }) => {
      if (server === "b1") return { exitCode: 0, output: "TUGRA_COMMIT=abc1234\nbuilt" };
      await opts?.beforeSend?.("dep-d1");
      return { exitCode: 0, output: "deployed" };
    });
    await make(d.prisma, d.access, { sendCommand, agentSupports: jest.fn().mockReturnValue(true) }).deploy("u1", "app1");
    const plan = dispatchCalls(d.updateMany)[0].data.dispatchPlan;
    expect(plan).toMatchObject({ postDeploy: true, gitSourced: true, buildLogHead: expect.stringContaining("TUGRA_COMMIT=abc1234") });
  });

  it("finalizeAdopted of a SUCCESS runs the post-deploy hook (never changing the verdict) and prepends the build-server log so the commit is recorded", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, postDeployCommand: "npm run migrate" }), update: jest.fn().mockResolvedValue({}) },
      deployment: { updateMany, update: depUpdate, count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      server: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_POSTDEPLOY: ok" });
    const svc = make(prisma, {}, { sendCommand });
    const plan = { v: 1, rolling: false, recreate: false, isCompose: false, hadPrev: false, isGitCompose: false, gitSourced: true, runTag: "tugra_app1:d1", registryRef: "ghcr.io/org/tugra_app1:d1", wasRunning: true, postDeploy: true, buildLogHead: "TUGRA_COMMIT=abc1234\nbuilt" };
    const dep = { id: "d1", appId: "app1", status: "RUNNING", kind: "DEPLOY", requestedBy: "u1", startedAt: new Date(), createdAt: new Date(), dispatchPlan: plan } as never;
    await svc.finalizeAdopted(dep, { exitCode: 0, output: "deployed", killed: false });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", commitSha: "abc1234", logs: "TUGRA_COMMIT=abc1234\nbuilt\ndeployed", registryImage: "ghcr.io/org/tugra_app1:d1" }) }));
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("TUGRA_POSTDEPLOY"), "deploy", expect.any(Number), expect.any(Function));
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { logs: expect.stringContaining("TUGRA_POSTDEPLOY: ok") } }));
    // a FAILED adoption never runs the hook
    sendCommand.mockClear();
    await svc.finalizeAdopted(dep, { exitCode: 1, output: "boom", killed: false });
    expect(sendCommand.mock.calls.some((c) => String(c[1]).includes("TUGRA_POSTDEPLOY"))).toBe(false);
  });

  it("claimNext and rollback rows carry the lease stamp (ownerId = this process, phase CLAIMED)", async () => {
    const d = deps();
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    await make(d.prisma, d.access, { sendCommand }).deploy("u1", "app1");
    const claim = d.updateMany.mock.calls.map((c) => c[0]).find((a) => a.data?.status === "RUNNING");
    expect(claim.data).toMatchObject({ status: "RUNNING", ownerId: TEST_BOOT_ID, phase: "CLAIMED", heartbeatAt: expect.any(Date), startedAt: expect.any(Date) });
  });
});

describe("ApplicationsService.deploymentDetail", () => {
  const rows = [
    { id: "d3", appId: "app1", status: "RUNNING", kind: "DEPLOY", logs: null, exitCode: null, createdAt: new Date(3), startedAt: new Date(3), durationMs: null, requestedBy: "u1", trigger: "manual", phase: "RECOVERING", agentReqId: "dep-d3", agentServerId: "s1", configSnapshot: null },
    { id: "d2", appId: "app1", status: "SUCCESS", kind: "DEPLOY", logs: "ok\nTUGRA_ROLLOUT: healthy", exitCode: 0, createdAt: new Date(2), startedAt: new Date(2), durationMs: 1000, requestedBy: "webhook", trigger: "webhook", imageTag: "tugra_app1:d2", configSnapshot: { env: {}, volumes: [], memoryMb: 512 } },
    { id: "d1", appId: "app1", status: "SUCCESS", kind: "DEPLOY", logs: "first", exitCode: 0, createdAt: new Date(1), startedAt: new Date(1), durationMs: 500, requestedBy: "u1", trigger: "manual", imageTag: "tugra_app1:d1", configSnapshot: { env: {}, volumes: [], memoryMb: 256 } },
  ];
  function fx() {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: {
        findFirst: jest.fn(async (a: { where: Record<string, unknown>; orderBy?: unknown; select?: unknown }) => {
          const w = a.where as { id?: string; appId?: string; status?: string; createdAt?: { lt: Date }; configSnapshot?: unknown };
          let c = rows.filter((r) => r.appId === (w.appId ?? r.appId));
          if (w.id) c = c.filter((r) => r.id === w.id);
          if (w.status) c = c.filter((r) => r.status === w.status);
          if (w.createdAt?.lt) c = c.filter((r) => r.createdAt < w.createdAt!.lt);
          if (w.configSnapshot) c = c.filter((r) => r.configSnapshot != null);
          return c.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] ?? null;
        }),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: "Ömer", email: "o@x" }) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    return { svc: make(prisma, access, {} as AgentWsServer), prisma };
  }

  it("returns the row with full log, a diff against the nearest OLDER snapshot, isCurrent, finishedAt, actor name and no note", async () => {
    const d = await fx().svc.deploymentDetail("u1", "app1", "d2");
    expect(d).toMatchObject({ id: "d2", logs: "ok\nTUGRA_ROLLOUT: healthy", rollout: "healthy", hasLogs: true, isCurrent: true, cancellable: false, note: null, rollbackable: true });
    expect(d.configChanges).toContainEqual(expect.objectContaining({ field: "memoryMb", before: "256", after: "512" }));
    expect(d.diffBase).toEqual({ id: "d1", createdAt: new Date(1) });
    expect(d.finishedAt?.getTime()).toBe(2 + 1000);
    expect(d.actor).toEqual({ kind: "webhook", name: null });
    expect(d).not.toHaveProperty("configSnapshot");
    expect(d).not.toHaveProperty("agentReqId");
  });

  it("a RECOVERING durable row is cancellable via its persisted handle and carries the recovering note; the user actor resolves to a display name", async () => {
    const d = await fx().svc.deploymentDetail("u1", "app1", "d3");
    expect(d).toMatchObject({ status: "RUNNING", cancellable: true, note: "recovering", isCurrent: false, finishedAt: null, diffBase: null });
    expect(d.actor).toEqual({ kind: "user", name: "Ömer" });
    // the oldest row has no older snapshot → diffBase null, isCurrent false (d2 is current)
    const first = await fx().svc.deploymentDetail("u1", "app1", "d1");
    expect(first).toMatchObject({ diffBase: null, isCurrent: false, configChanges: [] });
    expect(first.actor).toEqual({ kind: "user", name: "Ömer" });
  });

  it("404s a deployment that belongs to another app (no cross-app reads) and is writer-only", async () => {
    const f = fx();
    await expect(f.svc.deploymentDetail("u1", "app1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    const denied = make(f.prisma, { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) }, {} as AgentWsServer);
    await expect(denied.deploymentDetail("u1", "app1", "d2")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("deployments(…, { slim: true }) drops logs but keeps rollout/hasLogs so the list needs no log text", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: { findMany: jest.fn().mockResolvedValue(rows.slice(1)) },
    } as unknown as PrismaService;
    const access = { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService;
    const list = await make(prisma, access, {} as AgentWsServer).deployments("u1", "app1", { slim: true });
    expect(list[0]).toMatchObject({ id: "d2", logs: null, rollout: "healthy", hasLogs: true });
    expect(list[1]).toMatchObject({ id: "d1", logs: null, rollout: null, hasLogs: true });
  });
});

describe("ApplicationsService — git/build settings", () => {
  const gitApp = {
    ...app,
    source: "GIT",
    image: null,
    gitUrl: "https://github.com/acme/app.git",
    gitBranch: "main",
    gitSourceId: null,
    gitTokenEnc: null,
    gitSshKeyEnc: null,
    buildType: "DOCKERFILE",
    dockerfilePath: null,
    gitSubmodules: false,
    gitLfs: false,
    gitShallowClone: true,
    disableBuildCache: false,
    injectEnvAsBuildArgs: false,
    sourceCommitMode: "RUNTIME",
  };
  const noActiveDeploy = { findFirst: jest.fn().mockResolvedValue(null) };
  const allSix = { gitSubmodules: true, gitLfs: true, gitShallowClone: false, disableBuildCache: true, injectEnvAsBuildArgs: true, sourceCommitMode: "BUILD" as const };

  function setBuildDeps(row: Record<string, unknown> = gitApp) {
    const update = jest.fn().mockResolvedValue({});
    const audit = jest.fn().mockResolvedValue(undefined);
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(row), update }, deployment: noActiveDeploy } as unknown as PrismaService;
    const svc = make(prisma, {}, {} as AgentWsServer);
    (svc as unknown as { audit: { log: jest.Mock } }).audit = { log: audit };
    return { svc, update, audit };
  }

  it("setBuild writes the six toggles when given, and the audit meta names them", async () => {
    const { svc, update, audit } = setBuildDeps();
    await svc.setBuild("u1", "app1", { buildType: "DOCKERFILE", ...allSix });
    expect(update.mock.calls[0][0].data).toMatchObject(allSix);
    expect(audit.mock.calls[0][0].meta).toMatchObject({ buildType: "DOCKERFILE", ...allSix });
  });

  it("setBuild keeps the stored toggles when omitted (importer / old client)", async () => {
    const { svc, update, audit } = setBuildDeps();
    await svc.setBuild("u1", "app1", { buildType: "DOCKERFILE" });
    const data = update.mock.calls[0][0].data;
    for (const k of ["gitSubmodules", "gitLfs", "gitShallowClone", "disableBuildCache", "sourceCommitMode", "injectEnvAsBuildArgs"]) expect(data[k]).toBeUndefined();
    expect(Object.keys(audit.mock.calls[0][0].meta).sort()).toEqual(["baseDirectory", "buildType"]);
  });

  it("setBuild clears injectEnvAsBuildArgs when the type leaves DOCKERFILE", async () => {
    const { svc, update } = setBuildDeps({ ...gitApp, injectEnvAsBuildArgs: true });
    await svc.setBuild("u1", "app1", { buildType: "NIXPACKS" });
    expect(update.mock.calls[0][0].data.injectEnvAsBuildArgs).toBe(false);
  });

  it("setBuild refuses Railpack while disableBuildCache is persisted, but allows turning it off in the same save", async () => {
    const { svc, update } = setBuildDeps({ ...gitApp, disableBuildCache: true });
    await expect(svc.setBuild("u1", "app1", { buildType: "RAILPACK" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
    await svc.setBuild("u1", "app1", { buildType: "RAILPACK", disableBuildCache: false });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("clone copies all six git/build settings", async () => {
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, ...allSix, id: "src1", name: "shop", isPreview: false, envEnc: null, volumes: null, tags: [], webhookToken: "t" }), create },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http", proxyBind: "public" }) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    } as unknown as PrismaService;
    await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
    expect(create.mock.calls[0][0].data).toMatchObject(allSix);
  });

  it("upsertPreview builds the same way as its parent", async () => {
    const create = jest.fn().mockResolvedValue({ id: "pv1", teamId: "t1", serverId: "s1", source: "GIT", isPreview: true });
    const prisma = { application: { findFirst: jest.fn().mockResolvedValue(null), create } } as unknown as PrismaService;
    const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
    jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
    const parent = { ...gitApp, gitUrl: "https://github.com/u/r.git", ...allSix, name: "web", environmentId: "e1", previewEnabled: true, domain: "app.example.com", envEnc: "{}", previewExcludeKeys: [] } as unknown as Parameters<typeof svc.upsertPreview>[0];
    await svc.upsertPreview(parent, 7, "feature-7");
    const { gitSubmodules: _s, gitLfs: _l, ...rest } = allSix;
    expect(create.mock.calls[0][0].data).toMatchObject(rest); // shallow / no-cache / build-args / source-commit copy
    // a preview builds a PR author's head: it must never clone submodules or pull LFS with the app's token
    expect(create.mock.calls[0][0].data).toMatchObject({ gitSubmodules: false, gitLfs: false });
  });

  it("toSpec maps the settings for GIT apps only; inject is DOCKERFILE-gated", () => {
    const svc = make({} as PrismaService, {}, {} as AgentWsServer);
    const toSpec = (a: unknown) => (svc as unknown as { toSpec: (a: unknown) => Record<string, unknown> }).toSpec(a);
    expect(toSpec({ ...gitApp, ...allSix })).toMatchObject({ gitSubmodules: true, gitLfs: true, gitShallowClone: false, disableBuildCache: true, injectEnvAsBuildArgs: true, sourceCommitMode: "BUILD" });
    expect(toSpec({ ...gitApp, ...allSix, buildType: "NIXPACKS" }).injectEnvAsBuildArgs).toBe(false);
    const img = toSpec({ ...app, source: "IMAGE", ...allSix });
    expect(img.gitSubmodules).toBeUndefined();
    expect(img.sourceCommitMode).toBeUndefined();
    const compose = toSpec({ ...app, source: "COMPOSE", composeFile: "services: {}", ...allSix });
    expect(compose.gitLfs).toBeUndefined();
  });

  function deployDeps(row: Record<string, unknown>, output = "ok") {
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      registry: { findFirst: jest.fn().mockResolvedValue({ id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const calls: { server: string; cmd: string }[] = [];
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((server: string, cmd: string, cap: string) => {
        if (cap === "deploy") calls.push({ server, cmd });
        return Promise.resolve({ exitCode: 0, output });
      }),
    } as unknown as AgentWsServer;
    return { svc: make(prisma, accessWith({}), agentWs), calls, depUpdate };
  }

  it("a persistent disableBuildCache ORs into the deploy's noCache and is recorded on the deployment", async () => {
    const d = deployDeps({ ...gitApp, buildType: "NIXPACKS", disableBuildCache: true });
    await d.svc.deploy("u1", "app1");
    expect(d.calls[0].cmd).toContain("--no-cache");
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ noCache: true }) }));
  });

  it("without the setting the deployment's noCache is not rewritten", async () => {
    const d = deployDeps({ ...gitApp, buildType: "NIXPACKS" });
    await d.svc.deploy("u1", "app1");
    expect(d.calls[0].cmd).not.toContain("--no-cache");
    const withNoCache = d.depUpdate.mock.calls.filter((c) => c[0].data && "noCache" in c[0].data);
    expect(withNoCache).toHaveLength(0);
  });

  it("an environment too large to ride argv fails the injecting deploy before anything runs", async () => {
    const d = deployDeps({ ...gitApp, injectEnvAsBuildArgs: true });
    jest
      .spyOn(d.svc as unknown as { resolveEnvLayers: () => Promise<unknown> }, "resolveEnvLayers")
      .mockResolvedValue({ merged: { BIG: "x".repeat(60 * 1024) }, appEnv: { BIG: "x".repeat(60 * 1024) }, secretRefKeys: new Set<string>() });
    await d.svc.deploy("u1", "app1");
    expect(d.calls).toHaveLength(0);
    expect(d.depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("a build-server deploy hands the built SHA to the pull+run script as the runtime SOURCE_COMMIT", async () => {
    const sha = "b".repeat(40);
    const d = deployDeps({ ...gitApp, registryId: "reg1", pushToRegistry: true, buildServerId: "bs1" }, `TUGRA_COMMIT=${sha}\nok`);
    await d.svc.deploy("u1", "app1");
    expect(d.calls[0].server).toBe("bs1");
    expect(d.calls[1].server).toBe("s1");
    expect(d.calls[1].cmd).toContain(`-e SOURCE_COMMIT=${sha}`);
  });

  it("a rollback re-runs the prior image with that deployment's commit as SOURCE_COMMIT", async () => {
    const sha = "c".repeat(40);
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(gitApp), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "RUNNING" ? null : { id: "target", status: "SUCCESS", imageTag: "tugra_app1:target", registryImage: null, imageDigest: null, commitSha: sha, commitMessage: null }),
        ),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    let sentCmd = "";
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((_s: string, c: string) => { sentCmd = c; return Promise.resolve({ exitCode: 0, output: "ok" }); }),
    } as unknown as AgentWsServer;
    await make(prisma, accessWith({}), agentWs).rollback("u1", "app1", "target");
    expect(sentCmd).toContain(`-e SOURCE_COMMIT=${sha}`);
  });
});

describe("ApplicationsService — container ops + networking", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const classic = { ...app, teamId: "t1", source: "IMAGE", networks: [], containerAlias: null, networkAliases: [], dockerOptions: null };
  const mk = (row: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const update = jest.fn().mockResolvedValue({});
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...classic, ...row }), update, findFirst, ...extra } } as unknown as PrismaService;
    return { svc: make(prisma, access, {} as AgentWsServer), update, findFirst };
  };
  const priv = (svc: unknown) => svc as { opsBudgetMs: (s: unknown, r: boolean) => number; lifecycleTimeoutMs: (a: unknown) => number; rollingEligible: (a: unknown) => boolean; toSpec: (a: unknown) => Record<string, unknown> };

  describe("setNetworks", () => {
    it("stores networks + alias and audits (undefined keys are kept)", async () => {
      const { svc, update } = mk({});
      await svc.setNetworks("u1", "app1", { networks: ["db-net", "tugra-apps"], containerAlias: "api" });
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { networks: ["db-net", "tugra-apps"], containerAlias: "api" } }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.networks.update", meta: { networks: ["db-net", "tugra-apps"], alias: true } }));
      await svc.setNetworks("u1", "app1", { containerAlias: null });
      expect(update.mock.calls[1][0].data).toEqual({ containerAlias: null });
    });

    it.each([
      ["cluster", { clusterId: "c1" }],
      ["compose", { source: "COMPOSE" }],
      ["preview", { isPreview: true }],
      ["raw --network", { dockerOptions: "--network mynet" }],
    ])("refuses a %s app", async (_n, row) => {
      const { svc, update } = mk(row);
      await expect(svc.setNetworks("u1", "app1", { networks: ["a"] })).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it("with a raw --network: refuses setting values but allows a pure clearing write", async () => {
      const { svc, update } = mk({ dockerOptions: "--network mynet", networks: ["stale"], containerAlias: "old" });
      await expect(svc.setNetworks("u1", "app1", { networks: ["a"] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setNetworks("u1", "app1", { containerAlias: "api" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setNetworks("u1", "app1", { networks: [], containerAlias: "api" })).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
      await svc.setNetworks("u1", "app1", { networks: [], containerAlias: null });
      expect(update.mock.calls[0][0].data).toEqual({ networks: [], containerAlias: null });
      await svc.setNetworks("u1", "app1", { containerAlias: null });
      expect(update.mock.calls[1][0].data).toEqual({ containerAlias: null });
    });

    it("refuses a reserved network name and a reserved alias (defence in depth over the DTO)", async () => {
      const { svc, update } = mk({});
      await expect(svc.setNetworks("u1", "app1", { networks: ["tugra-net"] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setNetworks("u1", "app1", { networks: ["bridge"] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setNetworks("u1", "app1", { containerAlias: "tugra-x" })).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it("refuses a network name another team already uses on this server (tugra-apps is excluded from the check)", async () => {
      const { svc, update, findFirst } = mk({});
      findFirst.mockResolvedValueOnce({ id: "other" });
      await expect(svc.setNetworks("u1", "app1", { networks: ["backend"] })).rejects.toThrow(/another team/);
      expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { serverId: "s1", teamId: { not: "t1" }, networks: { hasSome: ["backend"] } } }));
      expect(update).not.toHaveBeenCalled();
      findFirst.mockClear();
      await svc.setNetworks("u1", "app1", { networks: ["tugra-apps"] }); // shared bridge by design → no cross-team query
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("refuses an alias that collides with this app's or another app's network alias on the server", async () => {
      const own = mk({ networkAliases: ["api"] });
      await expect(own.svc.setNetworks("u1", "app1", { containerAlias: "api" })).rejects.toThrow(/already in use/);
      const other = mk({});
      other.findFirst.mockResolvedValueOnce({ id: "other" });
      await expect(other.svc.setNetworks("u1", "app1", { containerAlias: "api" })).rejects.toThrow(/already in use/);
      expect(other.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ networkAliases: { has: "api" } }) }));
    });

    it("maps a unique-index violation (P2002) to Conflict", async () => {
      const { svc, update } = mk({});
      update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
      await expect(svc.setNetworks("u1", "app1", { containerAlias: "api" })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("reverse guards", () => {
    it("setNetworkAliases refuses an alias equal to this app's or another app's containerAlias", async () => {
      const own = mk({ containerAlias: "stable" });
      await expect(own.svc.setNetworkAliases("u1", "app1", ["stable"])).rejects.toBeInstanceOf(BadRequestException);
      const other = mk({});
      other.findFirst.mockResolvedValueOnce({ id: "other" });
      await expect(other.svc.setNetworkAliases("u1", "app1", ["x"])).rejects.toBeInstanceOf(BadRequestException);
      expect(other.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { serverId: "s1", id: { not: "app1" }, containerAlias: { in: ["x"] } } }));
    });

    it("setDockerOptions refuses --network while extra networks or an alias are set", async () => {
      await expect(mk({ networks: ["a"] }).svc.setDockerOptions("u1", "app1", "--network x")).rejects.toThrow(/extra networks/);
      await expect(mk({ containerAlias: "a" }).svc.setDockerOptions("u1", "app1", "--net=x")).rejects.toThrow(/extra networks/);
      await mk({ networks: ["a"] }).svc.setDockerOptions("u1", "app1", "--dns 1.1.1.1"); // unrelated options still fine
    });
  });

  describe("setDeploySettings (stop grace + drain)", () => {
    it("keeps when undefined, writes when set, and clears with null", async () => {
      const { svc, update } = mk({});
      await svc.setDeploySettings("u1", "app1", { stopGracePeriodSec: 45, drainSec: 5 });
      expect(update.mock.calls[0][0].data).toEqual({ stopGracePeriodSec: 45, drainSec: 5 });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.deploysettings.update", meta: { stopGracePeriodSec: 45, drainSec: 5 } }));
      await svc.setDeploySettings("u1", "app1", { imagesToKeep: 3 });
      expect("stopGracePeriodSec" in update.mock.calls[1][0].data).toBe(false);
      expect("drainSec" in update.mock.calls[1][0].data).toBe(false);
      await svc.setDeploySettings("u1", "app1", { stopGracePeriodSec: null, drainSec: null });
      expect(update.mock.calls[2][0].data).toEqual({ stopGracePeriodSec: null, drainSec: null });
    });

    it("audits postCutoverSoakSec (and only when it was part of the update)", async () => {
      const { svc } = mk({});
      await svc.setDeploySettings("u1", "app1", { postCutoverSoakSec: 45 });
      expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: "app.deploysettings.update", meta: { postCutoverSoakSec: 45 } }));
      await svc.setDeploySettings("u1", "app1", { postCutoverSoakSec: 0, drainSec: 5 });
      expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ meta: { postCutoverSoakSec: 0, drainSec: 5 } }));
      await svc.setDeploySettings("u1", "app1", { imagesToKeep: 3 });
      expect((audit.log as jest.Mock).mock.calls.at(-1)![0].meta).toBeUndefined();
    });

    it("refuses a non-null value on COMPOSE and cluster apps, but allows clearing", async () => {
      await expect(mk({ source: "COMPOSE" }).svc.setDeploySettings("u1", "app1", { stopGracePeriodSec: 30 })).rejects.toThrow(/compose file/);
      await expect(mk({ clusterId: "c1" }).svc.setDeploySettings("u1", "app1", { drainSec: 5 })).rejects.toThrow(/swarm/);
      const ok = mk({ source: "COMPOSE" });
      await ok.svc.setDeploySettings("u1", "app1", { stopGracePeriodSec: null });
      expect(ok.update).toHaveBeenCalled();
    });
  });

  describe("setRestartPolicy (maxRetries)", () => {
    it("stores the cap with on-failure, keeps it when omitted, and clears it when the policy leaves on-failure", async () => {
      const { svc, update } = mk({});
      await svc.setRestartPolicy("u1", "app1", "on-failure", 5);
      expect(update.mock.calls[0][0].data).toEqual({ restartPolicy: "on-failure", restartMaxRetries: 5 });
      await svc.setRestartPolicy("u1", "app1", "on-failure"); // omitted → keep
      expect(update.mock.calls[1][0].data).toEqual({ restartPolicy: "on-failure" });
      await svc.setRestartPolicy("u1", "app1", "always", 5); // not on-failure → cap dropped
      expect(update.mock.calls[2][0].data).toEqual({ restartPolicy: "always", restartMaxRetries: null });
      await svc.setRestartPolicy("u1", "app1", null);
      expect(update.mock.calls[3][0].data).toEqual({ restartPolicy: null, restartMaxRetries: null });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.restartPolicy.update", meta: { restartPolicy: "on-failure", maxRetries: 5 } }));
    });
  });

  describe("rollingEligible / timeouts / toSpec", () => {
    const rolling = { ...classic, domain: "a.com", deployStrategy: "ROLLING", rollbackOnFailure: true, volumes: null, extraPorts: null };
    it("rollingEligible is false with a containerAlias (the rollout copy would share it)", () => {
      const svc = priv(mk({}).svc);
      expect(svc.rollingEligible(rolling)).toBe(true);
      expect(svc.rollingEligible({ ...rolling, containerAlias: "stable" })).toBe(false);
    });

    it("opsBudgetMs: unset is 0; drain counts only for rolling; soak doubles the stop budget", () => {
      const svc = priv(mk({}).svc);
      expect(svc.opsBudgetMs({ id: "a" }, true)).toBe(0);
      expect(svc.opsBudgetMs({ id: "a", drainSec: 0, stopGracePeriodSec: null }, true)).toBe(0);
      expect(svc.opsBudgetMs({ id: "a", drainSec: 20, stopGracePeriodSec: 10 }, true)).toBe((20 + 10 + 15) * 1000);
      expect(svc.opsBudgetMs({ id: "a", drainSec: 20, stopGracePeriodSec: 10 }, false)).toBe((10 + 15) * 1000);
      expect(svc.opsBudgetMs({ id: "a", stopGracePeriodSec: 3600, postCutoverSoakSec: 30 }, true)).toBe((3600 * 2 + 15) * 1000);
    });

    it("lifecycleTimeoutMs: 120s default, grace+30s when longer, base for compose/cluster", () => {
      const svc = priv(mk({}).svc);
      expect(svc.lifecycleTimeoutMs(classic)).toBe(120_000);
      expect(svc.lifecycleTimeoutMs({ ...classic, stopGracePeriodSec: 60 })).toBe(120_000);
      expect(svc.lifecycleTimeoutMs({ ...classic, stopGracePeriodSec: 3600 })).toBe(3630_000);
      expect(svc.lifecycleTimeoutMs({ ...classic, stopGracePeriodSec: 3600, source: "COMPOSE" })).toBe(120_000);
      expect(svc.lifecycleTimeoutMs({ ...classic, stopGracePeriodSec: 3600, clusterId: "c1" })).toBe(120_000);
    });

    it("toSpec carries the settings for a classic app and masks them for COMPOSE and cluster", () => {
      const svc = priv(mk({}).svc);
      const row = { ...classic, stopGracePeriodSec: 30, drainSec: 5, networks: ["a"], containerAlias: "x", restartPolicy: "on-failure", restartMaxRetries: 4 };
      expect(svc.toSpec(row)).toMatchObject({ stopGracePeriodSec: 30, drainSec: 5, networks: ["a"], containerAlias: "x", restartMaxRetries: 4 });
      for (const masked of [{ source: "COMPOSE" }, { clusterId: "c1" }]) {
        expect(svc.toSpec({ ...row, ...masked })).toMatchObject({ stopGracePeriodSec: null, drainSec: null, networks: [], containerAlias: null, restartMaxRetries: null });
      }
      expect(svc.toSpec({ ...row, restartPolicy: "always" })).toMatchObject({ restartMaxRetries: null }); // cap only with on-failure
    });
  });

  describe("view().internalHost + new fields", () => {
    const listOne = async (row: Record<string, unknown>) => {
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue([{ ...classic, environmentId: "e1", ...row }]) },
        environment: { findMany: jest.fn().mockResolvedValue([{ id: "e1", name: "production", project: { id: "p1", name: "Default" } }]) },
      } as unknown as PrismaService;
      const acc = { accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])) } as unknown as TeamAccessService;
      return (await make(prisma, acc, {} as AgentWsServer).list("u1"))[0];
    };
    it("a bare app resolves as tugra_<id>:<port> on tugra-apps", async () => {
      const v = await listOne({ containerAlias: "stable", networkAliases: ["api"], stopGracePeriodSec: 20, drainSec: 3, restartMaxRetries: 2, networks: ["a"] });
      expect(v.internalHost).toEqual({ host: "tugra_app1", port: 80, networks: ["tugra-apps", "a"], aliases: ["api", "stable"] });
      expect(v).toMatchObject({ stopGracePeriodSec: 20, drainSec: 3, restartMaxRetries: 2, containerAlias: "stable", networks: ["a"] });
    });
    it("internalHost is null for compose, cluster and a raw --network", async () => {
      expect((await listOne({ source: "COMPOSE" })).internalHost).toBeNull();
      expect((await listOne({ clusterId: "c1" })).internalHost).toBeNull();
      expect((await listOne({ dockerOptions: "--network mynet" })).internalHost).toBeNull();
      expect((await listOne({ dockerOptions: "--network mynet" })).networkingLocked).toBe(true);
      expect((await listOne({ dockerOptions: null })).networkingLocked).toBe(false);
    });
    it("defaults for an app with no D2 columns (older row shape)", async () => {
      const v = await listOne({ networks: undefined, containerAlias: undefined });
      expect(v.networks).toEqual([]);
    });
  });

  describe("upsertPreview copies", () => {
    it("copies restartMaxRetries + stopGracePeriodSec, NOT containerAlias/networks/drainSec", async () => {
      const create = jest.fn().mockResolvedValue({ id: "pv1", teamId: "t1", serverId: "s1", source: "GIT", isPreview: true });
      const prisma = { application: { findFirst: jest.fn().mockResolvedValue(null), create } } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
      jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
      const parent = {
        id: "app1", name: "web", teamId: "t1", serverId: "s1", environmentId: "e1", source: "GIT", gitUrl: "https://github.com/u/r.git", previewEnabled: true, domain: "app.example.com",
        envEnc: JSON.stringify({}), restartPolicy: "on-failure", restartMaxRetries: 3, stopGracePeriodSec: 25, drainSec: 9, containerAlias: "stable", networks: ["a"],
      } as unknown as Parameters<typeof svc.upsertPreview>[0];
      await svc.upsertPreview(parent, 7, "feature-7");
      const data = create.mock.calls[0][0].data;
      expect(data.restartMaxRetries).toBe(3);
      expect(data.stopGracePeriodSec).toBe(25);
      expect("containerAlias" in data).toBe(false);
      expect("networks" in data).toBe(false);
      expect("drainSec" in data).toBe(false);
      expect(data.postCutoverSoakSec).toBe(0); // a preview never inherits the 30 s default (or the parent's value)
    });
  });

  describe("clone copies", () => {
    it("copies stop/drain/retries/networks and resets containerAlias", async () => {
      const src = { ...classic, id: "src1", name: "shop", image: "nginx", isPreview: false, volumes: null, stopGracePeriodSec: 30, drainSec: 4, restartMaxRetries: 2, networks: ["a"], containerAlias: "stable" };
      const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(src), create },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http", proxyBind: "public" }) },
        appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
        volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      } as unknown as PrismaService;
      await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
      const data = create.mock.calls[0][0].data;
      expect(data).toMatchObject({ stopGracePeriodSec: 30, drainSec: 4, restartMaxRetries: 2, networks: ["a"], containerAlias: null });
    });
    it("copies the source's post-cutover soak value verbatim (an existing 0 stays 0, a custom value is kept)", async () => {
      for (const v of [0, 90]) {
        const src = { ...classic, id: "src1", name: "shop", image: "nginx", isPreview: false, volumes: null, postCutoverSoakSec: v };
        const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
        const prisma = {
          application: { findUnique: jest.fn().mockResolvedValue(src), create },
          server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http", proxyBind: "public" }) },
          appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
          scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
          volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() }, // clone copies policies (A)
        } as unknown as PrismaService;
        await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
        expect(create.mock.calls[0][0].data.postCutoverSoakSec).toBe(v);
      }
    });
  });
});

describe("ApplicationsService container health (status honesty)", () => {
  const happ = { ...app, id: "a1", clusterId: null, environmentId: null, domain: null, healthCmd: null, healthCheckType: null };
  const access = () => ({ membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()), accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])) }) as unknown as TeamAccessService;
  const fresh = () => new Date();

  it("get() maps health from the app's own ContainerState rows (worst-of, rollout excluded by the filter)", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { status: "running", health: "healthy", updatedAt: fresh() },
      { status: "running", health: "unhealthy", updatedAt: fresh() },
    ]);
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(happ) }, containerState: { findMany } } as unknown as PrismaService;
    const view = await make(prisma, access(), {} as AgentWsServer).get("u1", "a1");
    expect(view.containerHealth).toMatchObject({ state: "unhealthy", checkType: "NONE", containers: 2 });
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toEqual({ in: ["s1"] });
    expect(JSON.stringify(where.OR)).not.toContain("__rollout"); // the not-yet-live rollout container never drives health
    expect(findMany.mock.calls[0][0].select).toEqual({ status: true, health: true, updatedAt: true }); // derived enum only
  });

  it("get() resolves the check type from the deploy config (HTTP when a domain is set)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...happ, domain: "a.example.com" }) },
      containerState: { findMany: jest.fn().mockResolvedValue([{ status: "running", health: null, updatedAt: fresh() }]) },
    } as unknown as PrismaService;
    const view = await make(prisma, access(), {} as AgentWsServer).get("u1", "a1");
    expect(view.containerHealth).toMatchObject({ state: "none", checkType: "HTTP" });
  });

  it("list() over N apps issues exactly one containerState query and buckets rows by app and server", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { serverId: "s1", containerName: "tugra_a1", status: "running", health: "healthy", updatedAt: fresh() },
      { serverId: "s1", containerName: "tugra_a2", status: "restarting", health: null, updatedAt: fresh() },
      { serverId: "s1", containerName: "tugra_a2__rollout", status: "running", health: "healthy", updatedAt: fresh() },
      { serverId: "s9", containerName: "tugra_a3", status: "running", health: "unhealthy", updatedAt: fresh() }, // another server: not a3's
      { serverId: "s1", containerName: "tugra_db_x", status: "running", health: "unhealthy", updatedAt: fresh() },
    ]);
    const apps = [happ, { ...happ, id: "a2" }, { ...happ, id: "a3" }, { ...happ, id: "a4" }];
    const prisma = { application: { findMany: jest.fn().mockResolvedValue(apps) }, containerState: { findMany } } as unknown as PrismaService;
    const out = await make(prisma, access(), {} as AgentWsServer).list("u1");
    expect(findMany).toHaveBeenCalledTimes(1);
    const by = Object.fromEntries(out.map((v) => [v.id, v.containerHealth.state]));
    expect(by).toEqual({ a1: "healthy", a2: "unhealthy", a3: "unknown", a4: "unknown" });
  });

  it("a rejected health lookup still returns the views, with unknown health", async () => {
    const prisma = {
      application: { findMany: jest.fn().mockResolvedValue([happ]), findUnique: jest.fn().mockResolvedValue(happ) },
      containerState: { findMany: jest.fn().mockRejectedValue(new Error("db down")) },
    } as unknown as PrismaService;
    const svc = make(prisma, access(), {} as AgentWsServer);
    expect((await svc.list("u1"))[0].containerHealth.state).toBe("unknown");
    expect((await svc.get("u1", "a1")).containerHealth.state).toBe("unknown");
  });

  it("create() emits unknown health (no containers yet)", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
      application: { create: jest.fn().mockResolvedValue({ ...happ, source: "IMAGE" }) },
    } as unknown as PrismaService;
    const view = await make(prisma, access(), {} as AgentWsServer).create("u1", { name: "web", serverId: "s1", image: "nginx" });
    expect(view.containerHealth).toMatchObject({ state: "unknown", containers: 0 });
  });
});

describe("ApplicationsService.setLimits — extra limits", () => {
  const classic = { ...app, source: "IMAGE", clusterId: null, memoryMb: null, memorySwapMb: null };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const setup = (stored: Record<string, unknown> = {}, cpuCores: number | null = 8) => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...classic, ...stored }), update },
      server: { findUnique: jest.fn().mockResolvedValue({ cpuCores }) },
    } as unknown as PrismaService;
    return { update, svc: make(prisma, access, {} as AgentWsServer) };
  };

  it("a classic app accepts all five and persists them (empty cpuset stored as null)", async () => {
    const { svc, update } = setup();
    await svc.setLimits("u1", "app1", { memoryMb: 256, memorySwapMb: 512, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-3" });
    expect(update.mock.calls[0][0].data).toEqual({ memoryMb: 256, memorySwapMb: 512, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-3" });
    await svc.setLimits("u1", "app1", { cpusetCpus: "" });
    expect(update.mock.calls[1][0].data).toEqual({ cpusetCpus: null });
  });

  it("partial updates keep untouched fields (nothing nulled)", async () => {
    const { svc, update } = setup();
    await svc.setLimits("u1", "app1", { pidsLimit: 50 });
    expect(update.mock.calls[0][0].data).toEqual({ pidsLimit: 50 });
  });

  it.each([["COMPOSE", {}], ["IMAGE", { clusterId: "c1" }]])("a %s/cluster app refuses non-null values with 400 but accepts null", async (source, extra) => {
    const { svc, update } = setup({ source, ...extra });
    await expect(svc.setLimits("u1", "app1", { pidsLimit: 10 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setLimits("u1", "app1", { cpusetCpus: "0" })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
    await svc.setLimits("u1", "app1", { memorySwapMb: null, pidsLimit: null, shmSizeMb: null, cpuShares: null, cpusetCpus: null });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses swap without a memory limit: in the payload, against the stored value, and when memory is cleared later", async () => {
    const a = setup();
    await expect(a.svc.setLimits("u1", "app1", { memorySwapMb: 512 })).rejects.toThrow(/needs a memory limit/);
    const b = setup({ memoryMb: 256 });
    await b.svc.setLimits("u1", "app1", { memorySwapMb: 512 }); // stored memory satisfies it
    expect(b.update).toHaveBeenCalledTimes(1);
    const c = setup({ memoryMb: 256, memorySwapMb: 512 });
    await expect(c.svc.setLimits("u1", "app1", { memoryMb: null })).rejects.toThrow(/needs a memory limit/);
    expect(c.update).not.toHaveBeenCalled();
  });

  it("refuses a swap below the memory limit (stored or sent) but allows -1", async () => {
    const a = setup({ memoryMb: 512 });
    await expect(a.svc.setLimits("u1", "app1", { memorySwapMb: 256 })).rejects.toThrow(/below the memory limit/);
    const b = setup({ memorySwapMb: 512, memoryMb: 512 });
    await expect(b.svc.setLimits("u1", "app1", { memoryMb: 1024 })).rejects.toThrow(/below the memory limit/);
    const c = setup({ memoryMb: 512 });
    await c.svc.setLimits("u1", "app1", { memorySwapMb: -1 });
    expect(c.update).toHaveBeenCalledTimes(1);
  });

  it("refuses a cpuset index at or beyond the server's core count; an unknown core count skips the check", async () => {
    const a = setup({}, 4);
    await expect(a.svc.setLimits("u1", "app1", { cpusetCpus: "0-4" })).rejects.toThrow(/cpu 4 isn't available on this server \(4 cores\)/);
    await a.svc.setLimits("u1", "app1", { cpusetCpus: "0-3" });
    expect(a.update).toHaveBeenCalledTimes(1);
    const b = setup({}, null);
    await b.svc.setLimits("u1", "app1", { cpusetCpus: "0-63" });
    expect(b.update).toHaveBeenCalledTimes(1);
  });

  it("toSpec carries the five for a classic app and masks them for compose and cluster", () => {
    const svc = make({} as PrismaService, {}, {} as AgentWsServer);
    const toSpec = (a: unknown) => (svc as unknown as { toSpec: (a: unknown) => Record<string, unknown> }).toSpec(a);
    const five = { memorySwapMb: 512, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1" };
    expect(toSpec({ ...classic, ...five })).toMatchObject(five);
    for (const mask of [{ source: "COMPOSE" }, { clusterId: "c1" }]) {
      const spec = toSpec({ ...classic, ...five, ...mask });
      for (const k of Object.keys(five)) expect(spec[k]).toBeUndefined();
    }
  });

  it("clone and preview copy all five limits", async () => {
    const five = { memorySwapMb: 512, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1" };
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", teamId: "t1", serverId: "s1", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...classic, ...five, id: "src1", name: "shop", isPreview: false, envEnc: null, volumes: null, tags: [], webhookToken: "t" }), findFirst: jest.fn().mockResolvedValue(null), create },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http", proxyBind: "public" }) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    } as unknown as PrismaService;
    const svc = make(prisma, {}, {} as AgentWsServer);
    await svc.clone("u1", "src1", {});
    expect(create.mock.calls[0][0].data).toMatchObject(five);
    jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
    const parent = { ...classic, ...five, source: "GIT", gitUrl: "https://github.com/u/r.git", name: "web", environmentId: "e1", previewEnabled: true, domain: "app.example.com", envEnc: "{}", previewExcludeKeys: [] } as unknown as Parameters<typeof svc.upsertPreview>[0];
    await svc.upsertPreview(parent, 7, "feature-7");
    expect(create.mock.calls[1][0].data).toMatchObject(five);
  });

  it("view exposes the five limits", async () => {
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...classic, memorySwapMb: 512, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1", environmentId: null }) } } as unknown as PrismaService;
    const v = await make(prisma, { membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()) } as unknown as TeamAccessService, {} as AgentWsServer).get("u1", "app1");
    expect(v).toMatchObject({ memorySwapMb: 512, pidsLimit: 100, shmSizeMb: 64, cpuShares: 512, cpusetCpus: "0-1" });
  });
});

describe("ApplicationsService.remove — pruneNetworks / pruneBuildCache", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const mk = (stored: Record<string, unknown> = {}, others: { networks: string[] }[] = [], online = true) => {
    const sent: { host: string; cmd: string }[] = [];
    const findMany = jest.fn().mockResolvedValue(others);
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "GIT", clusterId: null, networks: [], dockerOptions: null, buildServerId: null, ...stored }), delete: jest.fn().mockResolvedValue({}), findMany },
    } as unknown as PrismaService;
    const agentWs = {
      sendCommand: jest.fn().mockImplementation((host: string, cmd: string) => { sent.push({ host, cmd }); return Promise.resolve({ exitCode: 0, output: "" }); }),
      isOnline: jest.fn().mockReturnValue(online),
    } as unknown as AgentWsServer;
    return { sent, findMany, prisma, agentWs, svc: make(prisma, access, agentWs, makeDeployLogs(), makeMonitors()) };
  };

  it("a default delete sends no network or builder command and makes no extra Prisma call", async () => {
    const t = mk({ networks: ["backend"] });
    await t.svc.remove("u1", "app1");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].cmd).not.toMatch(/network|builder/);
    expect(t.findMany).not.toHaveBeenCalled();
  });

  it("removes an unshared network but not one another app on the server still lists", async () => {
    const t = mk({ networks: ["backend", "shared"] }, [{ networks: ["shared", "other"] }]);
    await t.svc.remove("u1", "app1", { pruneNetworks: true });
    expect(t.findMany.mock.calls[0][0].where).toMatchObject({ serverId: "s1", id: { not: "app1" }, networks: { hasSome: ["backend", "shared"] } });
    const cmd = t.sent[0].cmd;
    expect(cmd).toContain("docker network rm 'backend'");
    expect(cmd).not.toContain("'shared'");
    expect(cmd.indexOf("docker rm -f tugra_app1")).toBeLessThan(cmd.indexOf("docker network rm 'backend'"));
  });

  it("nothing is sent when nothing is removable (empty list, reserved only, raw --network)", async () => {
    for (const stored of [{ networks: [] }, { networks: ["tugra-apps"] }, { networks: ["backend"], dockerOptions: "--network mynet" }]) {
      const t = mk(stored);
      await t.svc.remove("u1", "app1", { pruneNetworks: true });
      expect(t.sent[0].cmd).not.toContain("network");
      expect(t.findMany).not.toHaveBeenCalled();
    }
  });

  it("refuses with 400 before any side effect: compose/cluster networks, image/cluster build cache", async () => {
    const cases: [Record<string, unknown>, { pruneNetworks?: boolean; pruneBuildCache?: boolean }][] = [
      [{ source: "COMPOSE" }, { pruneNetworks: true }],
      [{ clusterId: "c1" }, { pruneNetworks: true }],
      [{ source: "IMAGE" }, { pruneBuildCache: true }],
      [{ clusterId: "c1" }, { pruneBuildCache: true }],
    ];
    for (const [stored, o] of cases) {
      const t = mk(stored);
      await expect(t.svc.remove("u1", "app1", o)).rejects.toBeInstanceOf(BadRequestException);
      expect(t.sent).toHaveLength(0);
      expect((t.prisma.application.delete as jest.Mock)).not.toHaveBeenCalled();
    }
  });

  it("prunes the build cache on the build server for a non-compose app, after the removal command", async () => {
    const t = mk({ buildServerId: "build1" });
    await t.svc.remove("u1", "app1", { pruneBuildCache: true });
    expect(t.sent.map((s) => s.host)).toEqual(["s1", "build1"]);
    expect(t.sent[1].cmd).toBe("docker builder prune -f 2>/dev/null || true");
    expect(t.sent[0].cmd).not.toContain("builder");
  });

  it("prunes on the run server when no build server is set, and for a compose app even if one is set", async () => {
    const a = mk();
    await a.svc.remove("u1", "app1", { pruneBuildCache: true });
    expect(a.sent.map((s) => s.host)).toEqual(["s1", "s1"]);
    const b = mk({ source: "COMPOSE", buildServerId: "build1" });
    await b.svc.remove("u1", "app1", { pruneBuildCache: true });
    expect(b.sent.map((s) => s.host)).toEqual(["s1", "s1"]);
  });

  it("an offline build host skips the prune, and a rejected prune never blocks the delete", async () => {
    const off = mk({ buildServerId: "build1" }, [], false);
    await off.svc.remove("u1", "app1", { pruneBuildCache: true });
    expect(off.sent.some((s) => s.cmd.includes("builder"))).toBe(false);
    expect((off.prisma.application.delete as jest.Mock)).toHaveBeenCalled();

    const t = mk({ buildServerId: "build1" });
    (t.agentWs.sendCommand as jest.Mock).mockImplementation((_h: string, cmd: string) => (cmd.includes("builder") ? Promise.reject(new Error("boom")) : Promise.resolve({ exitCode: 0, output: "" })));
    await expect(t.svc.remove("u1", "app1", { pruneBuildCache: true })).resolves.toBeUndefined();
    expect((t.prisma.application.delete as jest.Mock)).toHaveBeenCalled();
  });

  it("dispatches the build-cache prune AFTER the row delete with a 300s timeout, and never awaits it", async () => {
    const t = mk({ buildServerId: "build1" });
    const order: string[] = [];
    (t.prisma.application.delete as jest.Mock).mockImplementation(() => { order.push("delete"); return Promise.resolve({}); });
    (t.agentWs.sendCommand as jest.Mock).mockImplementation((_h: string, cmd: string) => {
      if (cmd.includes("builder")) { order.push("prune"); return new Promise(() => undefined); } // never settles
      return Promise.resolve({ exitCode: 0, output: "" });
    });
    await expect(t.svc.remove("u1", "app1", { pruneBuildCache: true })).resolves.toBeUndefined(); // not held open by the prune
    expect(order).toEqual(["delete", "prune"]);
    const pruneCall = (t.agentWs.sendCommand as jest.Mock).mock.calls.find((c) => String(c[1]).includes("builder"));
    expect(pruneCall?.[3]).toBe(300_000);
  });

  it("audit records intent apart from outcome, only when a cleanup was requested", async () => {
    (audit.log as jest.Mock).mockClear();
    const t = mk({ networks: ["backend"] });
    await t.svc.remove("u1", "app1", { pruneNetworks: true, pruneBuildCache: true });
    expect(audit.log).toHaveBeenCalledWith({
      actor: "u1", action: "app.remove", target: "app1",
      meta: { networksPlanned: ["backend"], networksDispatched: true, pruneBuildCacheRequested: true, buildCacheDispatched: true },
    });
    // offline host + failing remove script: planned/requested, but nothing dispatched
    (audit.log as jest.Mock).mockClear();
    const off = mk({ networks: ["backend"] }, [], false);
    (off.agentWs.sendCommand as jest.Mock).mockResolvedValue({ exitCode: 1, output: "" });
    await off.svc.remove("u1", "app1", { pruneNetworks: true, pruneBuildCache: true });
    expect(audit.log).toHaveBeenCalledWith({
      actor: "u1", action: "app.remove", target: "app1",
      meta: { networksPlanned: ["backend"], networksDispatched: false, pruneBuildCacheRequested: true, buildCacheDispatched: false },
    });
    // nothing removable -> not "dispatched" even though the script ran
    (audit.log as jest.Mock).mockClear();
    await mk({ networks: [] }).svc.remove("u1", "app1", { pruneNetworks: true });
    expect(audit.log).toHaveBeenCalledWith({
      actor: "u1", action: "app.remove", target: "app1",
      meta: { networksPlanned: [], networksDispatched: false, pruneBuildCacheRequested: false, buildCacheDispatched: false },
    });
    (audit.log as jest.Mock).mockClear();
    await mk().svc.remove("u1", "app1");
    expect(audit.log).toHaveBeenCalledWith({ actor: "u1", action: "app.remove", target: "app1" });
  });

  describe("container logs on a never-deployed app", () => {
    const prismaFor = (a: typeof app) =>
      ({ application: { findUnique: jest.fn().mockResolvedValue(a) } }) as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;

    it("streamContainerLogs / assertContainerLogStreamAccess / downloadLogs refuse a NEW app with 409 (no daemon noise)", async () => {
      const sendCommand = jest.fn();
      const isOnline = jest.fn().mockReturnValue(true);
      const svc = make(prismaFor({ ...app, status: "NEW" }), access, { sendCommand, isOnline } as unknown as AgentWsServer);
      const logStream = (svc as unknown as { logStream: { stream: jest.Mock } }).logStream;
      await expect(svc.streamContainerLogs("u1", "app1", {})).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.assertContainerLogStreamAccess("u1", "app1")).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.downloadLogs("u1", "app1", {})).rejects.toBeInstanceOf(ConflictException);
      expect(logStream.stream).not.toHaveBeenCalled();
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it("streams the app's own container once it has been deployed", async () => {
      const isOnline = jest.fn().mockReturnValue(true);
      const svc = make(prismaFor({ ...app, status: "RUNNING" }), access, { isOnline } as unknown as AgentWsServer);
      const logStream = (svc as unknown as { logStream: { stream: jest.Mock } }).logStream;
      logStream.stream.mockReturnValue("observable");
      await expect(svc.assertContainerLogStreamAccess("u1", "app1")).resolves.toBeUndefined();
      await expect(svc.streamContainerLogs("u1", "app1", { container: "ignored-for-classic" })).resolves.toBe("observable");
      expect(logStream.stream).toHaveBeenCalledWith("s1", "tugra_app1", expect.objectContaining({ follow: true }));
    });
  });
});

describe("ApplicationsService — image update available (IMAGE apps)", () => {
  const D = (c: string) => "sha256:" + c.repeat(64);
  const t0 = new Date("2026-11-01T10:00:00Z");
  const imgApp = {
    ...app,
    id: "app1",
    source: "IMAGE",
    image: "nginx",
    status: "RUNNING",
    isPreview: false,
    environmentId: "env1",
    imageUpdateCheck: true,
    imageUpstreamDigest: D("b"),
    imageUpstreamCheckedAt: new Date("2026-11-02T10:00:00Z"),
    imageUpstreamChangedAt: new Date("2026-11-02T10:00:00Z"),
    imageCheckError: null,
    registryAuthEnc: null,
  };
  const liveRow = (appId: string, digest = `nginx@${D("a")}`) => ({ appId, imageDigest: digest, createdAt: t0, startedAt: t0, durationMs: 5000 });
  const prismaFor = (rows: unknown[], extra: Record<string, unknown> = {}) => {
    const queryRaw = jest.fn().mockResolvedValue(rows);
    return {
      queryRaw,
      prisma: {
        application: { findUnique: jest.fn().mockResolvedValue(imgApp), findMany: jest.fn().mockResolvedValue([imgApp, { ...imgApp, id: "app2" }, { ...app, id: "git1", source: "GIT", image: null, status: "RUNNING" }]), update: jest.fn().mockResolvedValue({}) },
        environment: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: queryRaw,
        ...extra,
      } as unknown as PrismaService,
    };
  };
  const access = (over: Record<string, unknown> = {}) =>
    ({
      accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: "OWNER", teamRoleId: null, restrictedAccess: false, accessedResources: [], accessedProjects: [] }]])),
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["apps:config", "apps:deploy"])]])),
      membershipPermissions: jest.fn().mockResolvedValue(new Set(["apps:config", "apps:deploy"])),
      ...over,
    }) as unknown as TeamAccessService;

  it("get() includes imageUpdate (update_available) with digests for a writer", async () => {
    const { prisma } = prismaFor([liveRow("app1")]);
    const v = await make(prisma, access(), {} as AgentWsServer).get("u1", "app1");
    expect(v.imageUpdate).toMatchObject({ state: "update_available", updateAvailable: true, upstreamDigest: D("b"), deployedDigest: D("a") });
  });

  it("get() redacts the digests for a read-only member (state and timestamps stay visible)", async () => {
    const { prisma } = prismaFor([liveRow("app1")]);
    const v = await make(prisma, access({ membershipPermissions: jest.fn().mockResolvedValue(new Set()) }), {} as AgentWsServer).get("u1", "app1");
    expect(v.imageUpdate).toMatchObject({ state: "update_available", upstreamDigest: null, deployedDigest: null });
    expect(v.imageUpdate?.checkedAt).not.toBeNull();
  });

  it("get() is null for GIT and COMPOSE apps and never queries the live digest for them", async () => {
    for (const source of ["GIT", "COMPOSE"]) {
      const { prisma, queryRaw } = prismaFor([]);
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({ ...imgApp, source, image: null, composeFile: source === "COMPOSE" ? "services: {}" : null });
      const v = await make(prisma, access(), {} as AgentWsServer).get("u1", "app1");
      expect(v.imageUpdate).toBeNull();
      expect(queryRaw).not.toHaveBeenCalled();
    }
  });

  it("list() issues exactly ONE live-digest query for N image apps and skips GIT apps", async () => {
    const { prisma, queryRaw } = prismaFor([liveRow("app1"), liveRow("app2", `nginx@${D("b")}`)]);
    const views = await make(prisma, access(), {} as AgentWsServer).list("u1");
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get("app1")?.imageUpdate?.state).toBe("update_available");
    expect(byId.get("app2")?.imageUpdate?.state).toBe("up_to_date");
    expect(byId.get("git1")?.imageUpdate).toBeNull();
  });

  it("list() survives a failing live-digest query (state degrades to no_baseline, list still renders)", async () => {
    const { prisma, queryRaw } = prismaFor([]);
    queryRaw.mockRejectedValue(new Error("db blip"));
    const views = await make(prisma, access(), {} as AgentWsServer).list("u1");
    expect(views.find((v) => v.id === "app1")?.imageUpdate?.state).toBe("no_baseline");
  });

  describe("setImageUpdateCheck", () => {
    it("a writer toggles the flag and it is audited", async () => {
      const { prisma } = prismaFor([]);
      await make(prisma, access(), {} as AgentWsServer).setImageUpdateCheck("u1", "app1", false);
      expect(prisma.application.update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { imageUpdateCheck: false } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.image_update_check.update", meta: { enabled: false } }));
    });
    it("a viewer is denied (403) and nothing is written", async () => {
      const { prisma } = prismaFor([]);
      const a = access({ requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) });
      await expect(make(prisma, a, {} as AgentWsServer).setImageUpdateCheck("u1", "app1", false)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.application.update).not.toHaveBeenCalled();
    });
    it("a GIT app is rejected (400)", async () => {
      const { prisma } = prismaFor([]);
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({ ...imgApp, source: "GIT" });
      await expect(make(prisma, access(), {} as AgentWsServer).setImageUpdateCheck("u1", "app1", false)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.application.update).not.toHaveBeenCalled();
    });
  });

  describe("checkImageUpdate", () => {
    it("requires apps:deploy (viewer 403 and a config-only member 403), never reaching the probe", async () => {
      const checkApp = jest.fn();
      const { prisma } = prismaFor([]);
      const viewer = access({ requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) });
      await expect(make(prisma, viewer, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { checkApp }).checkImageUpdate("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
      const configOnly = access({ requirePermission: jest.fn().mockImplementation((_u: string, _t: string, perm: string) => (perm === "apps:deploy" ? Promise.reject(new ForbiddenException("nope")) : Promise.resolve())) });
      await expect(make(prisma, configOnly, {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { checkApp }).checkImageUpdate("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
      expect(checkApp).not.toHaveBeenCalled();
    });
    it("a deployer delegates to the runner (digest visibility follows apps:config) and audits the state", async () => {
      const checkApp = jest.fn().mockResolvedValue({ imageUpdate: { state: "up_to_date" } });
      const requirePermission = jest.fn().mockResolvedValue(undefined);
      const { prisma } = prismaFor([]);
      const svc = make(prisma, access({ requirePermission, membershipPermissions: jest.fn().mockResolvedValue(new Set(["apps:deploy"])) }), {} as AgentWsServer, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { checkApp });
      const res = await svc.checkImageUpdate("u1", "app1");
      expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:deploy");
      expect(checkApp).toHaveBeenCalledWith(expect.objectContaining({ id: "app1" }), false);
      expect(res).toEqual({ imageUpdate: { state: "up_to_date" } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.image_update_check.run", meta: { state: "up_to_date" } }));
    });
  });

  it("setSource resets the probe state only when the image actually changes", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(imgApp), update }, deployment: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const svc = make(prisma, access(), {} as AgentWsServer);
    await svc.setSource("u1", "app1", { image: "nginx:1.27" });
    expect(update).toHaveBeenLastCalledWith({
      where: { id: "app1" },
      data: expect.objectContaining({ image: "nginx:1.27", imageUpstreamDigest: null, imageUpstreamCheckedAt: null, imageUpstreamChangedAt: null, imageCheckError: null, imageUpdateNotifiedDigest: null, imageCheckFailures: 0 }),
    });
    await svc.setSource("u1", "app1", { image: "nginx" }); // unchanged ref: state is kept
    const data = update.mock.calls[1][0].data as Record<string, unknown>;
    expect(data).toEqual({ image: "nginx" });
  });

  it("setCredentials (registry) clears a stale error, forces a re-probe and keeps the good digest", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(imgApp), update } } as unknown as PrismaService;
    const svc = make(prisma, access(), {} as AgentWsServer);
    await svc.setCredentials("u1", "app1", { registry: { user: "u", token: "t" } });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ imageCheckError: null, imageUpstreamCheckedAt: null, imageCheckFailures: 0 });
    expect(data).not.toHaveProperty("imageUpstreamDigest");
    await svc.setCredentials("u1", "app1", { gitToken: "x" }); // not a registry change
    expect(update.mock.calls[1][0].data).not.toHaveProperty("imageCheckError");
  });

  it("clone copies the opt-out flag but not the probe state", async () => {
    const server = { id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http", proxyBind: "public" };
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", status: "NEW", createdAt: new Date() }));
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...imgApp, imageUpdateCheck: false, exposeMode: "none", domainKind: "none", hostPort: null, volumes: [], tags: [] }), create },
      server: { findUnique: jest.fn().mockResolvedValue(server) },
      appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    } as unknown as PrismaService;
    const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "app1", {});
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.imageUpdateCheck).toBe(false);
    for (const k of ["imageUpstreamDigest", "imageUpstreamCheckedAt", "imageUpstreamChangedAt", "imageCheckError", "imageCheckFailures", "imageUpdateNotifiedDigest"]) expect(data).not.toHaveProperty(k);
    expect(res.app.imageUpdate).toBeNull(); // never deployed (status NEW)
  });
});

describe("ApplicationsService — per-variable env flags", () => {
  // The module-level crypto mock is encrypt=enc(x) / decrypt=identity, so a fixture "ciphertext" is just the plaintext.
  const meta = (flags: Record<string, unknown>) => JSON.stringify({ v: 1, flags });
  const baseApp = { ...app, source: "IMAGE", image: "nginx", status: "RUNNING", envEnc: '{"A":"1"}', envMetaEnc: null as string | null, buildSecretsEnc: null };
  const flaggedApp = { ...baseApp, envEnc: JSON.stringify({ PEM: "l1\nl2\n", A: "1" }), envMetaEnc: meta({ PEM: { multiline: true } }) };

  function setEnvDeps(row: Record<string, unknown>) {
    const update = jest.fn().mockResolvedValue({});
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(row), update } } as unknown as PrismaService;
    const svc = make(prisma, accessWith({}), {} as AgentWsServer);
    (svc as unknown as { audit: { log: jest.Mock } }).audit = { log: auditLog };
    return { svc, update, auditLog };
  }

  describe("setEnv", () => {
    it("writes envEnc and envMetaEnc in ONE update; flags present = authoritative replace", async () => {
      const d = setEnvDeps(baseApp);
      await d.svc.setEnv("u1", "app1", { PEM: "a\nb", A: "1" }, { PEM: { multiline: true }, A: { literal: true } });
      expect(d.update).toHaveBeenCalledTimes(1);
      const data = d.update.mock.calls[0][0].data;
      expect(data.envEnc).toBe('enc({"PEM":"a\\nb","A":"1"})');
      expect(data.envMetaEnc).toBe('enc({"v":1,"flags":{"A":{"literal":true},"PEM":{"multiline":true}}})');
    });

    it("flags omitted keeps the stored flags, pruned to the surviving keys", async () => {
      const d = setEnvDeps({ ...flaggedApp, envMetaEnc: meta({ PEM: { multiline: true }, GONE: { literal: true } }) });
      await d.svc.setEnv("u1", "app1", { PEM: "x\ny", A: "2" });
      expect(d.update.mock.calls[0][0].data.envMetaEnc).toBe('enc({"v":1,"flags":{"PEM":{"multiline":true}}})');
      await d.svc.setEnv("u1", "app1", { A: "2" }); // PEM deleted -> its flags go with it
      expect(d.update.mock.calls[1][0].data.envMetaEnc).toBeNull();
    });

    it("flags {} clears every flag", async () => {
      const d = setEnvDeps(flaggedApp);
      await d.svc.setEnv("u1", "app1", { A: "2" }, {});
      expect(d.update.mock.calls[0][0].data.envMetaEnc).toBeNull();
    });

    it("a validation failure writes nothing; the legacy newline message is unchanged (service-level, MCP/importer path)", async () => {
      const d = setEnvDeps(baseApp);
      await expect(d.svc.setEnv("u1", "app1", { A: "a\nb" })).rejects.toThrow(new BadRequestException("environment value must not contain a newline"));
      await expect(d.svc.setEnv("u1", "app1", { LD_PRELOAD: "a\nb" }, { LD_PRELOAD: { multiline: true } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(d.svc.setEnv("u1", "app1", { K: "v" }, { K: { buildTime: true } })).rejects.toThrow(/Git-built apps only/); // IMAGE app
      expect(d.update).not.toHaveBeenCalled();
    });

    it("a flagged multiline key survives an MCP-style read-modify-write (flags omitted)", async () => {
      const d = setEnvDeps(flaggedApp);
      const env = await d.svc.getEnv("u1", "app1");
      expect(env.PEM).toBe("l1\nl2\n"); // GET /env still returns the newline value
      await d.svc.setEnv("u1", "app1", { ...env, EXTRA: "z" });
      expect(d.update.mock.calls[0][0].data.envMetaEnc).toBe('enc({"v":1,"flags":{"PEM":{"multiline":true}}})');
    });

    it("corrupt stored meta: 409 when flags are omitted, fine with explicit flags", async () => {
      const d = setEnvDeps({ ...baseApp, envMetaEnc: "garbage" });
      await expect(d.svc.setEnv("u1", "app1", { A: "1" })).rejects.toBeInstanceOf(ConflictException);
      expect(d.update).not.toHaveBeenCalled();
      await d.svc.setEnv("u1", "app1", { A: "1" }, {});
      expect(d.update).toHaveBeenCalledTimes(1);
    });

    it("audit is untouched with no flags anywhere, and COUNTS ONLY otherwise", async () => {
      const plain = setEnvDeps(baseApp);
      await plain.svc.setEnv("u1", "app1", { A: "1" });
      expect(plain.auditLog).toHaveBeenCalledWith({ actor: "u1", action: "app.env.update", target: "app1" });
      const flagged = setEnvDeps(flaggedApp);
      await flagged.svc.setEnv("u1", "app1", { PEM: "a\nb", A: "1" }, { PEM: { multiline: true } });
      const entry = flagged.auditLog.mock.calls[0][0];
      expect(entry.meta).toEqual({ keys: 2, flagged: 1 });
      expect(JSON.stringify(entry)).not.toContain("PEM");
    });
  });

  describe("getEnvFlags", () => {
    it("returns full booleans per entry, applicable and limits", async () => {
      const d = setEnvDeps({ ...baseApp, source: "GIT", envMetaEnc: meta({ B: { buildTime: true, runtime: false }, PEM: { multiline: true } }) });
      const r = await d.svc.getEnvFlags("u1", "app1");
      expect(r.flags).toEqual({ B: { buildTime: true, runtime: false, literal: false, multiline: false }, PEM: { buildTime: false, runtime: true, literal: false, multiline: true } });
      expect(r.applicable).toEqual({ buildTime: true, literal: false });
      expect(r.limits).toMatchObject({ multilineValueBytes: 16384, multilineKeys: 32, multilineTotalBytes: 49152, buildTotalBytes: 49152 });
    });
    it("is empty without flags and 409 on a corrupt blob", async () => {
      expect((await setEnvDeps(baseApp).svc.getEnvFlags("u1", "app1")).flags).toEqual({});
      await expect(setEnvDeps({ ...baseApp, envMetaEnc: "{" }).svc.getEnvFlags("u1", "app1")).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("create with envFlags", () => {
    function createDeps() {
      const create = jest.fn().mockImplementation(async (a: { data: Record<string, unknown> }) => ({ ...app, ...a.data, id: "n1", createdAt: new Date() }));
      const prisma = { application: { create, findFirst: jest.fn().mockResolvedValue(null) }, server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) } } as unknown as PrismaService;
      return { create, svc: make(prisma, accessWith({}), {} as AgentWsServer) };
    }
    it("persists envMetaEnc next to envEnc", async () => {
      const d = createDeps();
      await d.svc.create("u1", { name: "x", serverId: "s1", image: "nginx", env: { PEM: "a\nb" }, envFlags: { PEM: { multiline: true } } } as never);
      expect(d.create.mock.calls[0][0].data.envMetaEnc).toBe('enc({"v":1,"flags":{"PEM":{"multiline":true}}})');
    });
    it("a flag-free create writes a null envMetaEnc; build flags on an IMAGE app are rejected", async () => {
      const d = createDeps();
      await d.svc.create("u1", { name: "x", serverId: "s1", image: "nginx", env: { A: "1" } } as never);
      expect(d.create.mock.calls[0][0].data.envMetaEnc).toBeNull();
      await expect(d.svc.create("u1", { name: "x", serverId: "s1", image: "nginx", env: { A: "1" }, envFlags: { A: { buildTime: true } } } as never)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("clone / preview copy the flags", () => {
    it("preview without exclusions reuses the parent blob verbatim; with exclusions the flags follow the surviving keys", async () => {
      const mk = () => {
        const create = jest.fn().mockResolvedValue({ id: "pv1", teamId: "t1", serverId: "s1", source: "IMAGE", isPreview: true });
        const prisma = { application: { findFirst: jest.fn().mockResolvedValue(null), create } } as unknown as PrismaService;
        const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
        jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
        return { create, svc };
      };
      // previews exist for Git-built parents only (an IMAGE parent is skipped and audited).
      const parent = { ...baseApp, source: "GIT", image: null, gitUrl: "https://github.com/acme/web", name: "web", environmentId: "e1", previewEnabled: true, domain: "app.example.com", envEnc: '{"PEM":"a\\nb","SECRET":"x"}', envMetaEnc: meta({ PEM: { multiline: true }, SECRET: { literal: true } }) };
      const a = mk();
      await a.svc.upsertPreview({ ...parent, previewExcludeKeys: [] } as never, 7, "f");
      expect(a.create.mock.calls[0][0].data.envMetaEnc).toBe(parent.envMetaEnc);
      const b = mk();
      await b.svc.upsertPreview({ ...parent, previewExcludeKeys: ["SECRET"] } as never, 7, "f");
      expect(b.create.mock.calls[0][0].data.envMetaEnc).toBe('enc({"v":1,"flags":{"PEM":{"multiline":true}}})');
    });
  });

  describe("compose lifecycle and swarm rollback", () => {
    const composeApp = { ...baseApp, source: "COMPOSE", image: null, composeFile: "services:\n  web:\n    image: nginx\n", status: "RUNNING", envEnc: JSON.stringify({ PLAIN: "p", PW: "pa$$word", PEM: "RAWSECRET\nL2" }), envMetaEnc: meta({ PW: { literal: true }, PEM: { multiline: true } }) };
    const lifecycleDeps = (row: Record<string, unknown>) => {
      const sent: string[] = [];
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      } as unknown as PrismaService;
      const agentWs = {
        isOnline: jest.fn().mockReturnValue(true),
        sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }),
      } as unknown as AgentWsServer;
      const svc = make(prisma, accessWith({}), agentWs, makeDeployLogs(), makeMonitors());
      (svc as unknown as { audit: { log: jest.Mock } }).audit = { log: jest.fn().mockResolvedValue(undefined) };
      return { svc, sent };
    };
    const prefix = 'env PEM="$TUGRA_ML_0" PW="$TUGRA_ML_1" ';

    it("stop / start / restart / logs / remove of a compose app with literal or multiline variables carry the prefix and prelude", async () => {
      const d = lifecycleDeps(composeApp);
      await d.svc.stop("u1", "app1");
      await d.svc.start("u1", "app1");
      await d.svc.restart("u1", "app1");
      await d.svc.appLogs("u1", "app1", 10);
      await d.svc.remove("u1", "app1");
      expect(d.sent).toHaveLength(5);
      for (const cmd of d.sent) {
        const composeLines = cmd.split("\n").filter((l) => l.includes("docker compose"));
        expect(composeLines.length).toBeGreaterThan(0);
        for (const l of composeLines) expect(l.startsWith(prefix)).toBe(true);
        expect(cmd).toContain("TUGRA_ML_0=$(printf %s ");
        expect(cmd).not.toContain("RAWSECRET");
      }
    });

    it("an app without flags, and an app whose flagged env cannot be resolved, run the bare commands (stop / remove never depend on the env)", async () => {
      const plain = lifecycleDeps({ ...composeApp, envEnc: '{"A":"1"}', envMetaEnc: null });
      await plain.svc.stop("u1", "app1");
      expect(plain.sent[0]).toBe("docker compose -p tugra_app1 -f /etc/tugra/compose/app1/docker-compose.yml stop");
      const broken = lifecycleDeps({ ...composeApp, envMetaEnc: "garbage" });
      await broken.svc.stop("u1", "app1");
      await broken.svc.remove("u1", "app1");
      expect(broken.sent[0]).toBe("docker compose -p tugra_app1 -f /etc/tugra/compose/app1/docker-compose.yml stop");
      expect(broken.sent[1]).toContain("down");
    });

    it("swarm rollback applies the flags: a build-only variable is not attached, a multiline one is marked", async () => {
      const row = { ...baseApp, source: "GIT", image: null, gitUrl: "https://github.com/acme/app.git", gitBranch: "main", buildType: "DOCKERFILE", clusterId: "c1", envEnc: JSON.stringify({ A: "1", BUILDONLY: "b", PEM: "l1\nl2\n" }), envMetaEnc: meta({ BUILDONLY: { buildTime: true, runtime: false }, PEM: { multiline: true } }) };
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "RUNNING" ? null : { id: "target", status: "SUCCESS", imageTag: null, registryImage: "ghcr.io/o/a:1", imageDigest: null, commitSha: null, commitMessage: null })),
          create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
        },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const svc = make(prisma, accessWith({}), {} as AgentWsServer);
      (svc as unknown as { audit: { log: jest.Mock } }).audit = { log: jest.fn().mockResolvedValue(undefined) };
      const rollbackTo = jest.fn().mockResolvedValue({ exitCode: 0, output: "ok", digest: null });
      (svc as unknown as { swarmDeploy: { rollbackTo: jest.Mock } }).swarmDeploy = { rollbackTo };
      await svc.rollback("u1", "app1", "target");
      expect(rollbackTo).toHaveBeenCalledTimes(1);
      const spec = rollbackTo.mock.calls[0][1] as { env: Record<string, string>; envMeta: Record<string, unknown> };
      expect(spec.env).toEqual({ A: "1", PEM: "l1\nl2\n" }); // BUILDONLY removed
      expect(spec.envMeta).toEqual({ BUILDONLY: { buildTime: true, runtime: false }, PEM: { multiline: true } });
    });
  });

  describe("deploy-time resolution (attachResolvedEnv)", () => {
    function deployDeps(row: Record<string, unknown>, shared: { key: string; valueEnc: string }[] = [], secrets: Record<string, string> = {}) {
      const depUpdate = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d1", createdAt: new Date() }),
          update: depUpdate,
          findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        sharedVariable: { findMany: jest.fn().mockResolvedValue(shared) },
      } as unknown as PrismaService;
      const calls: string[] = [];
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => { if (cap === "deploy") calls.push(cmd); return Promise.resolve({ exitCode: 0, output: "ok" }); }) } as unknown as AgentWsServer;
      const svc = make(prisma, accessWith({}), agentWs, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { resolveSecretEnv: jest.fn().mockResolvedValue(secrets) });
      return { svc, calls, depUpdate };
    }
    const git = { ...baseApp, source: "GIT", image: null, gitUrl: "https://github.com/acme/app.git", gitBranch: "main", buildType: "DOCKERFILE", gitTokenEnc: null, gitSshKeyEnc: null };
    const failed = (d: ReturnType<typeof deployDeps>) => d.depUpdate.mock.calls.some((c) => c[0].data?.status === "FAILED");

    it("an unflagged app: spec.env is the merged env, spec.buildArgs equals appBuildArgs, no envMeta", async () => {
      const d = deployDeps({ ...git, envEnc: '{"A":"1"}', buildArgsEnc: '{"B":"2"}' });
      const spec = { env: {} } as Record<string, unknown>;
      await (d.svc as unknown as { attachResolvedEnv: (...a: unknown[]) => Promise<void> }).attachResolvedEnv({ ...git, envEnc: '{"A":"1"}', buildArgsEnc: '{"B":"2"}' }, spec, { withBuild: true });
      expect(spec).toEqual({ env: { A: "1" }, buildArgs: { B: "2" } });
    });

    it("a build-only variable reaches the build but not the container; explicit build args win", async () => {
      const row = { ...git, envEnc: '{"TOKEN_X":"s","KEEP":"k"}', envMetaEnc: meta({ TOKEN_X: { buildTime: true, runtime: false } }), buildArgsEnc: '{"TOKEN_X":"explicit"}' };
      const d = deployDeps(row);
      const spec = { env: {} } as Record<string, unknown>;
      await (d.svc as unknown as { attachResolvedEnv: (...a: unknown[]) => Promise<void> }).attachResolvedEnv(row, spec, { withBuild: true });
      expect(spec.env).toEqual({ KEEP: "k" });
      expect(spec.buildArgs).toEqual({ TOKEN_X: "explicit" });
      expect(spec.buildFlagKeys).toEqual(["TOKEN_X"]);
      expect(spec.envMeta).toEqual({ TOKEN_X: { buildTime: true, runtime: false } });
      // and a full deploy actually passes it to docker build
      const full = deployDeps({ ...row, buildArgsEnc: null });
      await full.svc.deploy("u1", "app1");
      expect(full.calls[0]).toContain("--build-arg 'TOKEN_X=s'");
      expect(full.calls[0]).not.toContain("TOKEN_X=s\n");
    });

    it("withBuild:false (rollback) does not set buildArgs", async () => {
      const row = { ...git, envEnc: '{"K":"v"}', envMetaEnc: meta({ K: { buildTime: true } }) };
      const d = deployDeps(row);
      const spec = { env: {} } as Record<string, unknown>;
      await (d.svc as unknown as { attachResolvedEnv: (...a: unknown[]) => Promise<void> }).attachResolvedEnv(row, spec, { withBuild: false });
      expect(spec.buildArgs).toBeUndefined();
      expect(spec.env).toEqual({ K: "v" });
    });

    it("a shared variable never becomes a build arg through flags", async () => {
      const row = { ...git, envEnc: "{}", envMetaEnc: null };
      const d = deployDeps(row, [{ key: "SHARED", valueEnc: "sv" }]);
      const spec = { env: {} } as Record<string, unknown>;
      await (d.svc as unknown as { attachResolvedEnv: (...a: unknown[]) => Promise<void> }).attachResolvedEnv(row, spec, { withBuild: true });
      expect(spec.env).toEqual({ SHARED: "sv" });
      expect(spec.buildArgs).toEqual({});
    });

    it("corrupt meta fails the deploy closed with a message that names the app, not any variable or value", async () => {
      const row = { ...git, envEnc: '{"TOPSECRET_NAME":"v"}', envMetaEnc: "garbage" };
      const d = deployDeps(row);
      await d.svc.deploy("u1", "app1");
      expect(failed(d)).toBe(true);
      expect(d.calls).toHaveLength(0);
      const err = JSON.stringify(d.depUpdate.mock.calls) + JSON.stringify((d.svc as unknown as { deployLogs: { push: jest.Mock } }).deployLogs.push.mock?.calls ?? []);
      expect(err).not.toContain("TOPSECRET_NAME");
    });

    it("a Vault-ref key carrying buildTime fails the deploy; runtime:false on an IMAGE app fails the deploy", async () => {
      const refRow = { ...git, envEnc: '{"V":"x"}', envMetaEnc: meta({ V: { buildTime: true } }) };
      const a = deployDeps(refRow, [], { V: "from-vault" });
      await a.svc.deploy("u1", "app1");
      expect(failed(a)).toBe(true);
      expect(a.calls).toHaveLength(0);
      const imgRow = { ...baseApp, envEnc: '{"K":"v"}', envMetaEnc: meta({ K: { buildTime: true, runtime: false } }) };
      const b = deployDeps(imgRow);
      await b.svc.deploy("u1", "app1");
      expect(failed(b)).toBe(true);
    });

    it("an IMAGE app with a lone stale buildTime flag still deploys (ignored; never rewrites user data)", async () => {
      const row = { ...baseApp, envEnc: '{"K":"v"}', envMetaEnc: meta({ K: { buildTime: true } }) };
      const d = deployDeps(row);
      await d.svc.deploy("u1", "app1");
      expect(failed(d)).toBe(false);
      expect(d.calls).toHaveLength(1);
    });

    it("legacy data: an unflagged value with a line break (app env or shared variable) is delivered as multiline at deploy time and logged by key", async () => {
      const d = deployDeps({ ...baseApp, envEnc: JSON.stringify({ SSH_PRIVATE_KEY: "RAWKEY\nLINE2\n", A: "1" }) }, [{ key: "SHARED_CERT", valueEnc: "RAWCERT\nLINE2" }]);
      await d.svc.deploy("u1", "app1");
      expect(failed(d)).toBe(false);
      expect(d.calls[0]).toContain('env SHARED_CERT="$TUGRA_ML_0" SSH_PRIVATE_KEY="$TUGRA_ML_1" docker run -d');
      expect(d.calls[0]).toContain("-e SHARED_CERT -e SSH_PRIVATE_KEY");
      expect(d.calls[0]).not.toContain("RAWKEY");
      expect(d.calls[0]).not.toContain("RAWCERT");
      const logged = ((d.svc as unknown as { deployLogs: { push: jest.Mock } }).deployLogs.push.mock.calls as unknown[][]).map((c) => String(c[1])).join("");
      expect(logged).toContain("TUGRA: auto multiline: SSH_PRIVATE_KEY");
      expect(logged).toContain("TUGRA: auto multiline: SHARED_CERT");
      expect(logged).not.toContain("RAWKEY");
    });

    it("legacy data: a line break on a name that cannot be multiline fails the deploy naming the key (rename or remove the line break), never the value", async () => {
      const d = deployDeps({ ...baseApp, envEnc: JSON.stringify({ PATH: "TOPSECRETVALUE\nx", A: "1" }) });
      await d.svc.deploy("u1", "app1");
      expect(failed(d)).toBe(true);
      expect(d.calls).toHaveLength(0);
      const err = JSON.stringify(d.depUpdate.mock.calls) + JSON.stringify((d.svc as unknown as { deployLogs: { push: jest.Mock } }).deployLogs.push.mock.calls);
      expect(err).toContain('environment variable \\"PATH\\" contains a line break');
      expect(err).toContain("rename it or remove the line break");
      expect(err).not.toContain("TOPSECRETVALUE");
    });

    it("a multiline variable rides the deploy script as base64 in an unexported prefix assignment, never the raw value", async () => {
      const d = deployDeps({ ...baseApp, envEnc: JSON.stringify({ PEM: "RAWSECRET\nLINE2", A: "1" }), envMetaEnc: meta({ PEM: { multiline: true } }) });
      await d.svc.deploy("u1", "app1");
      expect(d.calls[0]).toContain('PEM="$TUGRA_ML_0"');
      expect(d.calls[0]).toContain("-e PEM");
      expect(d.calls[0]).not.toContain("RAWSECRET");
    });
  });

  it("rollback applies the flags too (a multiline variable is delivered by name)", async () => {
    let sentCmd = "";
    const row = { ...baseApp, source: "IMAGE", envEnc: JSON.stringify({ A: "1", B: "2" }), envMetaEnc: meta({ B: { multiline: true } }) };
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "RUNNING" ? null : { id: "target", status: "SUCCESS", imageTag: "tugra_app1:target", registryImage: null, imageDigest: null })),
        create: jest.fn().mockResolvedValue({ id: "roll1", createdAt: new Date() }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "roll1", status: "SUCCESS" }),
      },
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", certMode: "http" }) },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sentCmd = cmd; return Promise.resolve({ exitCode: 0, output: "up" }); }) } as unknown as AgentWsServer;
    await make(prisma, accessWith({}), agentWs).rollback("u1", "app1", "target");
    expect(sentCmd).toContain('B="$TUGRA_ML_0"');
  
  });
});

describe("ApplicationsService custom container labels (D5)", () => {
  const row = { ...app, source: "IMAGE", image: "nginx", status: "RUNNING", isPreview: false, clusterId: null as string | null, dockerOptions: null as string | null, customLabels: null as unknown };
  const mk = (over: Record<string, unknown> = {}, access: Partial<TeamAccessService> = {}) => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...row, ...over }), update },
      deployment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = make(prisma, accessWith(access), {} as AgentWsServer);
    (audit.log as jest.Mock).mockClear();
    return { svc, update };
  };

  describe("setCustomLabels", () => {
    it("is write-gated", async () => {
      const denied = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) };
      await expect(mk({}, denied).svc.setCustomLabels("u1", "app1", { labels: { a: "1" } })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses COMPOSE and preview apps", async () => {
      await expect(mk({ source: "COMPOSE" }).svc.setCustomLabels("u1", "app1", { labels: { a: "1" } })).rejects.toThrow(/compose file/);
      await expect(mk({ isPreview: true }).svc.setCustomLabels("u1", "app1", { labels: { a: "1" } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("persists sorted, stores a DB null on empty, and audits key names never values", async () => {
      const ok = mk();
      await ok.svc.setCustomLabels("u1", "app1", { labels: { zeta: "SECRET_VALUE_1", alpha: "SECRET_VALUE_2" } });
      const data = ok.update.mock.calls[0][0].data;
      expect(Object.keys(data.customLabels)).toEqual(["alpha", "zeta"]);
      expect(data.customLabels).toEqual({ alpha: "SECRET_VALUE_2", zeta: "SECRET_VALUE_1" });
      const calls = (audit.log as jest.Mock).mock.calls;
      expect(calls[0][0]).toMatchObject({ action: "app.custom_labels.update", target: "app1", meta: { count: 2, keys: ["alpha", "zeta"] } });
      expect(JSON.stringify(calls)).not.toContain("SECRET_VALUE");
      const reset = mk({ customLabels: { a: "1" } });
      await reset.svc.setCustomLabels("u1", "app1", { labels: {} });
      expect(reset.update.mock.calls[0][0].data.customLabels).toBe(Prisma.DbNull);
    });

    it("rejects reserved namespaces and case-duplicates naming the key (400)", async () => {
      await expect(mk().svc.setCustomLabels("u1", "app1", { labels: { "Traefik.x": "1" } })).rejects.toThrow(/"Traefik\.x"/);
      await expect(mk().svc.setCustomLabels("u1", "app1", { labels: { "com.docker.compose.project": "x" } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(mk().svc.setCustomLabels("u1", "app1", { labels: { Foo: "1", foo: "2" } })).rejects.toThrow(/duplicates/);
    });

    it("refuses a key already set via --label in dockerOptions, but not on a swarm app", async () => {
      await expect(mk({ dockerOptions: "--label team=x" }).svc.setCustomLabels("u1", "app1", { labels: { Team: "y" } })).rejects.toThrow(/already set via --label/);
      const swarm = mk({ dockerOptions: "--label team=x", clusterId: "c1" });
      await swarm.svc.setCustomLabels("u1", "app1", { labels: { team: "y" } });
      expect(swarm.update).toHaveBeenCalled();
    });
  });

  describe("setDockerOptions cross-check", () => {
    it("refuses a raw --label that collides with a stored custom label (case-insensitive), not on swarm", async () => {
      await expect(mk({ customLabels: { Team: "core" } }).svc.setDockerOptions("u1", "app1", "--label team=x")).rejects.toThrow(/is a custom label/);
      const fine = mk({ customLabels: { team: "core" } });
      await fine.svc.setDockerOptions("u1", "app1", "--label other=x");
      expect(fine.update).toHaveBeenCalled();
      const swarm = mk({ customLabels: { team: "core" }, clusterId: "c1" });
      await swarm.svc.setDockerOptions("u1", "app1", "--label team=x");
      expect(swarm.update).toHaveBeenCalled();
    });
    it("now rejects the wider reserved label namespaces", async () => {
      await expect(mk().svc.setDockerOptions("u1", "app1", "--label tugra.role=gpu-probe")).rejects.toThrow(/reserved tugra\./);
    });
  });

  describe("view", () => {
    it("exposes customLabels to a writer and hides it from a non-writer", async () => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...row, customLabels: { team: "core" } }) },
        deployment: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const writer = await make(prisma, accessWith({}), {} as AgentWsServer).get("u1", "app1");
      expect((writer as { customLabels: unknown }).customLabels).toEqual({ team: "core" });
      const viewer = await make(prisma, accessWith({ membershipPermissions: jest.fn().mockResolvedValue(new Set()) }), {} as AgentWsServer).get("u1", "app1");
      expect((viewer as { customLabels: unknown }).customLabels).toBeNull();
    });
  });

  describe("deploy / rollback re-validation", () => {
    const bad = { customLabels: { "tugra.role": "gpu-probe" } };
    it("executeDeploy fails the deployment on a stored reserved label and sends nothing", async () => {
      const depUpdate = jest.fn().mockResolvedValue({});
      const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...row, ...bad }), update: jest.fn().mockResolvedValue({}) },
        deployment: { create: jest.fn().mockResolvedValue({ id: "d1" }), update: depUpdate, findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }), findFirst: jest.fn().mockResolvedValue(null) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      await make(prisma, accessWith({}), { sendCommand: send } as unknown as AgentWsServer).deploy("u1", "app1");
      await flushMicrotasks();
      expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", logs: expect.stringContaining("reserved") }) }));
      expect(send).not.toHaveBeenCalled();
    });

    it("rollback and rollbackDetached reject before touching anything", async () => {
      const create = jest.fn();
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...row, ...bad }) },
        deployment: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null), create },
      } as unknown as PrismaService;
      const svc = make(prisma, accessWith({}), {} as AgentWsServer);
      await expect(svc.rollback("u1", "app1", "t1")).rejects.toThrow(/reserved/);
      await expect(svc.rollbackDetached("u1", "app1", "t1", { key: "k" })).rejects.toThrow(/reserved/);
      expect(create).not.toHaveBeenCalled();
    });

    it("a collision with dockerOptions --label also fails the deploy gate (classic only)", async () => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...row, customLabels: { team: "a" }, dockerOptions: "--label team=b" }) },
        deployment: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      await expect(make(prisma, accessWith({}), {} as AgentWsServer).rollback("u1", "app1", "t1")).rejects.toThrow(/already set via --label/);
    });
  });

  describe("swarm scrub trigger", () => {
    const swarmRow = { ...row, clusterId: "c1", customLabels: null };
    const run = async (snapshots: { latest?: unknown; latestOk?: unknown }) => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(swarmRow), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d2", createdAt: new Date() }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({ id: "d2", status: "SUCCESS" }),
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockImplementation((args: { where: { configSnapshot?: unknown; status?: string; id?: unknown } }) => {
            if (!args.where.configSnapshot) return Promise.resolve(null);
            expect(args.where.id).toEqual({ not: "d2" }); // the current deployment is excluded
            return Promise.resolve((args.where.status === "SUCCESS" ? snapshots.latestOk : snapshots.latest) ?? null);
          }),
        },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const svc = make(prisma, accessWith({}), {} as AgentWsServer);
      const deploy = jest.fn().mockResolvedValue({ exitCode: 0, output: "", digest: null, registryRef: null });
      (svc as unknown as { swarmDeploy: { deploy: jest.Mock } }).swarmDeploy = { deploy };
      await svc.deploy("u1", "app1");
      await flushMicrotasks();
      return (deploy.mock.calls[0][1] as { customLabelsScrub?: boolean }).customLabelsScrub;
    };
    const had = { configSnapshot: { customLabels: { team: "abc123abc123" } } };
    const none = { configSnapshot: { snapV: 2 } };

    it("is true when the previous snapshot had labels, false when it had none", async () => {
      expect(await run({ latest: had, latestOk: had })).toBe(true);
      expect(await run({ latest: none, latestOk: none })).toBe(false);
      expect(await run({})).toBe(false);
    });
    it("stays true when the latest attempt had none but the latest SUCCESS still did (failed removal)", async () => {
      expect(await run({ latest: none, latestOk: had })).toBe(true);
    });
  });

  describe("clone", () => {
    const src = { ...row, id: "src1", name: "shop", domain: null, certPem: null, certKeyEnc: null, envEnc: null, gitTokenEnc: null, registryAuthEnc: null, buildArgsEnc: null, buildSecretsEnc: null, volumes: null, hostMounts: null, portMappings: null, placement: null, tags: [], webhookToken: "t" };
    const server = { id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http", proxyBind: "public" };
    const run = async (over: Record<string, unknown>) => {
      const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...src, ...over }), create },
        server: { findUnique: jest.fn().mockResolvedValue(server) },
        appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
        volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      } as unknown as PrismaService;
      const res = await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
      return { data: create.mock.calls[0][0].data, warnings: res.warnings };
    };
    it("copies custom labels for classic and swarm apps", async () => {
      expect((await run({ customLabels: { team: "core" } })).data.customLabels).toEqual({ team: "core" });
      expect((await run({ customLabels: { team: "core" }, clusterId: "c1" })).data.customLabels).toEqual({ team: "core" });
      expect((await run({})).data.customLabels).toBe(Prisma.DbNull);
    });
    it("drops them from a COMPOSE source with the custom_labels_dropped warning", async () => {
      const r = await run({ source: "COMPOSE", customLabels: { team: "core" } });
      expect(r.data.customLabels).toBe(Prisma.DbNull);
      expect(r.warnings).toContain("custom_labels_dropped");
    });
  });

  describe("getAppLabels", () => {
    const labelsRow = { ...row, domain: "app.example.com", certType: "le-http", basicAuthUsers: [{ user: "u", hash: "$2b$HASHSECRET" }], forwardAuth: "https://auth.internal/verify?t=FASTOKEN", envEnc: "ENVSECRET", gitTokenEnc: "GITSECRET", customLabels: { team: "core" } };
    const prismaFor = (r: Record<string, unknown>) =>
      ({
        application: { findUnique: jest.fn().mockResolvedValue(r) },
        server: { findUnique: jest.fn().mockResolvedValue(null) },
        appServiceDomain: { findMany: jest.fn().mockResolvedValue([]) },
      }) as unknown as PrismaService;

    it("is writer-only", async () => {
      const denied = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) };
      await expect(make(prismaFor(labelsRow), accessWith(denied), {} as AgentWsServer).getAppLabels("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("returns Tugra + custom labels with masked secrets and never leaks env/credentials", async () => {
      const v = await make(prismaFor(labelsRow), accessWith({}), {} as AgentWsServer).getAppLabels("u1", "app1");
      expect(v.engine).toBe("docker");
      expect(v.editable).toBe(true);
      expect(v.tugra.some((l) => l.key === "traefik.enable" && l.value === "true")).toBe(true);
      const ba = v.tugra.find((l) => l.key.endsWith("basicauth.users"))!;
      expect(ba).toMatchObject({ masked: true, value: null });
      expect(v.tugra.find((l) => l.key.endsWith("forwardauth.address"))).toMatchObject({ masked: true, value: null });
      expect(v.custom).toEqual([{ key: "team", value: "core" }]);
      const blob = JSON.stringify(v);
      for (const s of ["HASHSECRET", "FASTOKEN", "ENVSECRET", "GITSECRET"]) expect(blob).not.toContain(s);
    });
  });
});

// ── D4: custom pushed image name + alias, COMPOSE hooks, resolved compose preview, inline Dockerfile ──
describe("ApplicationsService — D4 build / registry / hooks", () => {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const auditLog = audit.log as jest.Mock;
  const reg = { id: "reg1", teamId: "t1", url: "ghcr.io", username: "bot", passwordEnc: "tok", imagePrefix: "org" };
  const pushApp = { ...app, source: "IMAGE", registryId: "reg1", pushToRegistry: true, buildServerId: null, pushImageName: null, pushImageTag: null };
  const lastAudit = () => auditLog.mock.calls[auditLog.mock.calls.length - 1][0];

  beforeEach(() => auditLog.mockClear());

  describe("setBuildConfig: pushImageName / pushImageTag", () => {
    const mk = (row: Record<string, unknown>, updateImpl?: jest.Mock) => {
      const update = updateImpl ?? jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...pushApp, ...row }), update },
        registry: { findUnique: jest.fn().mockResolvedValue(reg) },
      } as unknown as PrismaService;
      return { svc: make(prisma, access, {} as AgentWsServer), update };
    };

    it("persists a valid name + alias for an app that pushes to a registry, and audits them (non-secret)", async () => {
      const { svc, update } = mk({});
      await svc.setBuildConfig("u1", "app1", { pushImageName: "team/web", pushImageTag: "stable" });
      expect(update.mock.calls[0][0].data).toEqual({ pushImageName: "team/web", pushImageTag: "stable" });
      expect(lastAudit()).toMatchObject({ action: "app.buildconfig.update", meta: { pushImageName: "team/web", pushImageTag: "stable" } });
    });

    it("needs an effective registry AND push (or a build server): 400 otherwise", async () => {
      await expect(mk({ registryId: null }).svc.setBuildConfig("u1", "app1", { pushImageName: "web" })).rejects.toThrow(/needs a registry and push/);
      await expect(mk({ pushToRegistry: false }).svc.setBuildConfig("u1", "app1", { pushImageTag: "latest" })).rejects.toThrow(/needs a registry and push/);
      // the MERGED state counts: enabling push in the same request makes it valid
      await expect(mk({ pushToRegistry: false }).svc.setBuildConfig("u1", "app1", { pushToRegistry: true, pushImageTag: "latest" })).resolves.toBeUndefined();
      // a build server implies push
      await expect(mk({ pushToRegistry: false, buildServerId: "bs1" }).svc.setBuildConfig("u1", "app1", { pushImageName: "web" })).resolves.toBeUndefined();
    });

    it("is rejected for COMPOSE apps", async () => {
      await expect(mk({ source: "COMPOSE" }).svc.setBuildConfig("u1", "app1", { pushImageName: "web" })).rejects.toThrow(/does not apply to compose/);
    });

    it("rejects a bad name (reserved tugra_ prefix) and a bad tag template with the reason code", async () => {
      await expect(mk({}).svc.setBuildConfig("u1", "app1", { pushImageName: "tugra_other" })).rejects.toThrow(/invalid image name \(reserved\)/);
      await expect(mk({}).svc.setBuildConfig("u1", "app1", { pushImageTag: "{sha}" })).rejects.toThrow(/invalid alias tag \(needs_git\)/);
      await expect(mk({}).svc.setBuildConfig("u1", "app1", { pushImageTag: "c" + "a".repeat(24) })).rejects.toThrow(/invalid alias tag \(reserved\)/);
      // a GIT app may use the tokens
      await expect(mk({ source: "GIT" }).svc.setBuildConfig("u1", "app1", { pushImageTag: "{branch}-{sha}" })).resolves.toBeUndefined();
    });

    it("maps the unique index (P2002) to a 409", async () => {
      const err = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
      const { svc } = mk({}, jest.fn().mockRejectedValue(err));
      await expect(svc.setBuildConfig("u1", "app1", { pushImageName: "web" })).rejects.toBeInstanceOf(ConflictException);
      // any other error is not swallowed
      await expect(mk({}, jest.fn().mockRejectedValue(new Error("db down"))).svc.setBuildConfig("u1", "app1", { pushImageName: "web" })).rejects.toThrow("db down");
    });

    it("clearing the registry (or push) clears a stored name and alias; undefined leaves them alone", async () => {
      const stored = { pushImageName: "team/web", pushImageTag: "stable" };
      const a = mk(stored);
      await a.svc.setBuildConfig("u1", "app1", { registryId: null });
      expect(a.update.mock.calls[0][0].data).toEqual({ registryId: null, pushImageName: null, pushImageTag: null });
      const b = mk(stored);
      await b.svc.setBuildConfig("u1", "app1", { pushToRegistry: false });
      expect(b.update.mock.calls[0][0].data).toEqual({ pushToRegistry: false, pushImageName: null, pushImageTag: null });
      // still pushing: an unrelated update leaves both alone
      const c = mk(stored);
      await c.svc.setBuildConfig("u1", "app1", { registryId: "reg1" });
      expect("pushImageName" in c.update.mock.calls[0][0].data).toBe(false);
      expect("pushImageTag" in c.update.mock.calls[0][0].data).toBe(false);
      // an explicit null clears just that field
      const d = mk(stored);
      await d.svc.setBuildConfig("u1", "app1", { pushImageTag: null });
      expect(d.update.mock.calls[0][0].data).toEqual({ pushImageTag: null });
    });

    it("an old payload (pushToRegistry:true, no registry) behaves exactly as before: no new key, no 400", async () => {
      const { svc, update } = mk({ registryId: null, pushToRegistry: false });
      await svc.setBuildConfig("u1", "app1", { pushToRegistry: true });
      expect(update.mock.calls[0][0].data).toEqual({ pushToRegistry: true });
    });
  });

  describe("executeDeploy / cleanup with a custom name", () => {
    const deployFixture = (row: Record<string, unknown>, opts: { exitCode?: number; deploymentRows?: { id: string }[] } = {}) => {
      const depUpdate = jest.fn().mockResolvedValue({});
      const findMany = jest.fn().mockResolvedValue(opts.deploymentRows ?? [{ id: "d1" }]);
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...pushApp, ...row }), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d1" }),
          update: depUpdate,
          findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }),
          findFirst: jest.fn().mockResolvedValue(null),
          findMany,
        },
        registry: { findFirst: jest.fn().mockResolvedValue(reg) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const sent: { cap: string; cmd: string }[] = [];
      const agentWs = {
        sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => {
          sent.push({ cap, cmd });
          return Promise.resolve({ exitCode: cap === "deploy" ? opts.exitCode ?? 0 : 0, output: "" });
        }),
      } as unknown as AgentWsServer;
      return { svc: make(prisma, access, agentWs), sent, depUpdate, findMany };
    };

    it("pushes the custom immutable ref and the alias, and records the immutable ref on the deployment", async () => {
      const f = deployFixture({ pushImageName: "team/web", pushImageTag: "stable" });
      await f.svc.deploy("u1", "app1");
      const cmd = f.sent.find((s) => s.cap === "deploy")!.cmd;
      expect(cmd).toContain("docker push 'ghcr.io/org/team/web:d1'");
      expect(cmd).toContain("TUGRA_ALIAS='ghcr.io/org/team/web:stable'");
      expect(cmd).toContain('docker push "$TUGRA_ALIAS"');
      const snap = f.depUpdate.mock.calls.map((c) => c[0].data).find((d) => d.configSnapshot)!.configSnapshot;
      expect(snap).toMatchObject({ pushImageName: "team/web", pushImageTag: "stable" });
    });

    it("an unresolvable alias fails the deploy BEFORE anything runs on the agent (pre-swap) and logs why", async () => {
      const f = deployFixture({ pushImageTag: "{sha}" }); // stored bypassing the DTO: IMAGE apps cannot use {sha}
      await f.svc.deploy("u1", "app1");
      expect(f.sent.filter((s) => s.cap === "deploy")).toHaveLength(0);
      expect(f.depUpdate.mock.calls.some((c) => c[0].data.status === "FAILED")).toBe(true);
    });

    it("a hostile stored name is re-validated at deploy time and never reaches a script", async () => {
      const f = deployFixture({ pushImageName: "x'; rm -rf /; '" });
      await f.svc.deploy("u1", "app1");
      expect(f.sent.filter((s) => s.cap === "deploy")).toHaveLength(0);
    });

    it("computes ownedVersions (one deployment.findMany) ONLY when pushImageName is set, and the failed-deploy cleanup uses it", async () => {
      const custom = deployFixture({ pushImageName: "team/web" }, { exitCode: 1 });
      await custom.svc.deploy("u1", "app1");
      expect(custom.findMany).toHaveBeenCalledWith({ where: { appId: "app1" }, select: { id: true } });
      const cleanup = custom.sent.find((s) => s.cap === "cleanup")!.cmd;
      expect(cleanup).toContain("docker rmi 'ghcr.io/org/team/web:d1'");
      const plain = deployFixture({}, { exitCode: 1 });
      await plain.svc.deploy("u1", "app1");
      expect(plain.findMany).not.toHaveBeenCalled(); // no extra query for an app without a custom name
      expect(plain.sent.find((s) => s.cap === "cleanup")!.cmd).toContain("docker rmi 'ghcr.io/org/tugra_app1:d1'");
    });

    it("pruneImages passes the owned ids (custom repo tags are removed) and never touches a non-owned version", async () => {
      const prune = (svc: unknown) => (svc as { pruneImages: (a: unknown) => Promise<void> }).pruneImages.bind(svc);
      const rows = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, status: "SUCCESS", imageTag: `tugra_app1:d${i}`, registryImage: i === 5 ? "ghcr.io/org/team/web:d5" : `ghcr.io/org/team/web:d${i}`, createdAt: new Date(6 - i) }));
      const findMany = jest.fn().mockImplementation((args: { select?: unknown }) => Promise.resolve(args?.select ? rows.map((r) => ({ id: r.id })) : rows));
      const update = jest.fn().mockResolvedValue({});
      const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany, update } } as unknown as PrismaService;
      const sent: string[] = [];
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
      const svc = make(prisma, {} as TeamAccessService, agentWs);
      await prune(svc)({ ...app, id: "app1", serverId: "s1", pushImageName: "team/web" });
      expect(sent.join("\n")).toContain("docker rmi 'ghcr.io/org/team/web:d5'");
      // a registryImage whose version is NOT one of this app's deployment ids is dropped by the guard
      const foreign = [...rows.slice(0, 5), { ...rows[5], registryImage: "ghcr.io/org/team/web:cforeign" }];
      const findMany2 = jest.fn().mockImplementation((args: { select?: unknown }) => Promise.resolve(args?.select ? rows.map((r) => ({ id: r.id })) : foreign));
      const sent2: string[] = [];
      const svc2 = make({ deployment: { count: jest.fn().mockResolvedValue(0), findMany: findMany2, update } } as unknown as PrismaService, {} as TeamAccessService, { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent2.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer);
      await prune(svc2)({ ...app, id: "app1", serverId: "s1", pushImageName: "team/web" });
      expect(sent2.join("\n")).not.toContain("cforeign");
      expect(sent2.join("\n")).toContain("'tugra_app1:d5'");
    });

    it("pruneImages still reclaims old custom-named tags after pushImageName was CLEARED (the rows keep the old ref)", async () => {
      const prune = (svc: unknown) => (svc as { pruneImages: (a: unknown) => Promise<void> }).pruneImages.bind(svc);
      const rows = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, status: "SUCCESS", imageTag: `tugra_app1:d${i}`, registryImage: `ghcr.io/org/team/web:d${i}`, createdAt: new Date(6 - i) }));
      const findMany = jest.fn().mockImplementation((args: { select?: unknown }) => Promise.resolve(args?.select ? rows.map((r) => ({ id: r.id })) : rows));
      const update = jest.fn().mockResolvedValue({});
      const prisma = { deployment: { count: jest.fn().mockResolvedValue(0), findMany, update } } as unknown as PrismaService;
      const sent: string[] = [];
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
      await prune(make(prisma, {} as TeamAccessService, agentWs))({ ...app, id: "app1", serverId: "s1", pushImageName: null });
      expect(sent.join("\n")).toContain("docker rmi 'ghcr.io/org/team/web:d5'");
      expect(sent.join("\n")).toContain("docker rmi 'tugra_app1:d5'");
    });

    it("the adoption reap (finalizeAdopted, cancelled) passes the owned ids for a custom-name app", async () => {
      const findMany = jest.fn().mockResolvedValue([{ id: "d1" }]);
      const sent: string[] = [];
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...pushApp, pushImageName: "team/web" }) },
        deployment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany },
      } as unknown as PrismaService;
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { sent.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
      const dep = {
        id: "d1",
        appId: "app1",
        dispatchPlan: { v: 1, rolling: false, recreate: false, isCompose: false, isGitCompose: false, hadPrev: false, gitSourced: false, runTag: "tugra_app1:d1", registryRef: "ghcr.io/org/team/web:d1", wasRunning: false, postDeploy: false, buildLogHead: null },
        createdAt: new Date(),
        startedAt: new Date(),
      } as never;
      await make(prisma, access, agentWs).finalizeAdopted(dep, { exitCode: 137, output: "", killed: true });
      expect(findMany).toHaveBeenCalledWith({ where: { appId: "app1" }, select: { id: true } });
      expect(sent.join("\n")).toContain("docker rmi 'ghcr.io/org/team/web:d1'");
    });
  });

  describe("setDeployHooks for COMPOSE", () => {
    const YAML = "services:\n  web:\n    image: nginx\n  api:\n    image: app\n";
    const mk = (row: Record<string, unknown>) => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML, composePath: null, ...row }), update } } as unknown as PrismaService;
      return { svc: make(prisma, access, {} as AgentWsServer), update };
    };

    it("requires a service when any hook is set", async () => {
      await expect(mk({}).svc.setDeployHooks("u1", "app1", "migrate", null)).rejects.toThrow(/a service is required for a compose hook/);
      await expect(mk({}).svc.setDeployHooks("u1", "app1", null, "warm", "")).rejects.toThrow(/a service is required/);
    });

    it("a pasted compose's service must exist (the error lists the services); a valid one persists with the service", async () => {
      await expect(mk({}).svc.setDeployHooks("u1", "app1", "migrate", null, "nope")).rejects.toThrow(/service "nope" is not in the compose file \(services: web, api\)/);
      const ok = mk({});
      await ok.svc.setDeployHooks("u1", "app1", "  migrate ", "warm", "api");
      expect(ok.update.mock.calls[0][0].data).toEqual({ preDeployCommand: "migrate", postDeployCommand: "warm", composeHookService: "api" });
    });

    it("a stored service is reused when the request omits it; an explicit one replaces it", async () => {
      const a = mk({ composeHookService: "api" });
      await a.svc.setDeployHooks("u1", "app1", "migrate", null);
      expect(a.update.mock.calls[0][0].data.composeHookService).toBe("api");
      const b = mk({ composeHookService: "api" });
      await b.svc.setDeployHooks("u1", "app1", "migrate", null, "web");
      expect(b.update.mock.calls[0][0].data.composeHookService).toBe("web");
    });

    it("a git-compose service is NOT checked at save time (validated at deploy against the rendered stack)", async () => {
      const g = mk({ composeFile: null, composePath: "docker-compose.yml", gitUrl: "https://github.com/u/r.git" });
      await expect(g.svc.setDeployHooks("u1", "app1", "migrate", null, "anything")).resolves.toBeUndefined();
    });

    it("clearing both hooks also nulls the service; cluster and preview apps still reject a hook", async () => {
      const c = mk({ composeHookService: "api" });
      await c.svc.setDeployHooks("u1", "app1", null, "");
      expect(c.update.mock.calls[0][0].data).toEqual({ preDeployCommand: null, postDeployCommand: null, composeHookService: null });
      await expect(mk({ clusterId: "c1" }).svc.setDeployHooks("u1", "app1", "x", null, "api")).rejects.toBeInstanceOf(BadRequestException);
      await expect(mk({ isPreview: true }).svc.setDeployHooks("u1", "app1", null, "x", "api")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("a non-compose app rejects a hook service", async () => {
      await expect(mk({ source: "IMAGE" }).svc.setDeployHooks("u1", "app1", "migrate", null, "api")).rejects.toThrow(/applies only to compose/);
    });

    it("the audit carries the service and lengths, never the commands", async () => {
      await mk({}).svc.setDeployHooks("u1", "app1", "SECRET_PRE_CMD", "SECRET_POST_CMD", "api");
      expect(lastAudit().meta).toEqual({ preLen: 14, postLen: 15, service: "api" });
      expect(JSON.stringify(auditLog.mock.calls)).not.toContain("SECRET_PRE_CMD");
      expect(JSON.stringify(auditLog.mock.calls)).not.toContain("SECRET_POST_CMD");
    });

    it("setComposeFile rejects a file that drops the hooked service, and accepts one that keeps it", async () => {
      const row = { composeHookService: "api", preDeployCommand: "migrate", postDeployCommand: null };
      const mkFile = () => {
        const update = jest.fn().mockResolvedValue({});
        const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML, ...row }), update }, deployment: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
        return { svc: make(prisma, access, {} as AgentWsServer), update };
      };
      await expect(mkFile().svc.setComposeFile("u1", "app1", "services:\n  web:\n    image: nginx\n")).rejects.toThrow(/removes service "api" used by a deploy hook/);
      const ok = mkFile();
      await ok.svc.setComposeFile("u1", "app1", "services:\n  api:\n    image: app2\n");
      expect(ok.update).toHaveBeenCalled();
    });

    it("a compose deploy dispatches ONE command (hooks inside it) and never a separate post-deploy command", async () => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML, composePath: null, composeHookService: "api", preDeployCommand: "migrate", postDeployCommand: "warm", env: {} }), update: jest.fn().mockResolvedValue({}) },
        deployment: { create: jest.fn().mockResolvedValue({ id: "d1" }), update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "SUCCESS" }), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const cmds: string[] = [];
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string, cap: string) => { if (cap === "deploy") cmds.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
      await make(prisma, access, agentWs).deploy("u1", "app1");
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).toContain("TUGRA_PREDEPLOY: running");
      expect(cmds[0]).toContain("TUGRA_POSTDEPLOY: running");
      expect(cmds[0].indexOf("TUGRA_PREDEPLOY: running")).toBeLessThan(cmds[0].indexOf(" up -d "));
    });

    it("a hook service missing from the stored compose fails the deploy pre-swap (nothing runs on the agent)", async () => {
      const depUpdate = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML, composePath: null, composeHookService: "gone", preDeployCommand: "migrate", postDeployCommand: null, env: {} }), update: jest.fn().mockResolvedValue({}) },
        deployment: { create: jest.fn().mockResolvedValue({ id: "d1" }), update: depUpdate, findUnique: jest.fn().mockResolvedValue({ id: "d1", status: "FAILED" }), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
      await make(prisma, access, { sendCommand: send } as unknown as AgentWsServer).deploy("u1", "app1");
      expect(send).not.toHaveBeenCalled();
      expect(depUpdate.mock.calls.some((c) => c[0].data.status === "FAILED")).toBe(true);
    });

    it("a rollback emits no hook markers for a compose app", async () => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML, composePath: null, composeHookService: "api", preDeployCommand: "migrate", postDeployCommand: "warm", env: {} }), update: jest.fn().mockResolvedValue({}) },
        deployment: {
          create: jest.fn().mockResolvedValue({ id: "d2" }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({ id: "d2", status: "SUCCESS" }),
          findFirst: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
            Promise.resolve(where.status === "RUNNING" ? null : { id: "target", status: "SUCCESS", configSnapshot: { composeFile: YAML, env: {}, volumes: [] } }),
          ),
          findMany: jest.fn().mockResolvedValue([]),
        },
        sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService;
      const cmds: string[] = [];
      const agentWs = { sendCommand: jest.fn().mockImplementation((_s: string, cmd: string) => { cmds.push(cmd); return Promise.resolve({ exitCode: 0, output: "" }); }) } as unknown as AgentWsServer;
      await make(prisma, access, agentWs).rollback("u1", "app1", "target");
      expect(cmds.some((c) => c.includes(" up -d "))).toBe(true);
      for (const c of cmds) {
        expect(c).not.toContain("TUGRA_PREDEPLOY");
        expect(c).not.toContain("TUGRA_POSTDEPLOY");
      }
    });
  });

  describe("setBuild: inline Dockerfile", () => {
    const gitApp = { ...app, source: "GIT", image: null, gitUrl: "https://github.com/acme/app.git", buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile", disableBuildCache: false };
    const mk = (row: Record<string, unknown> = {}) => {
      const update = jest.fn().mockResolvedValue({});
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...gitApp, ...row }), update }, deployment: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
      return { svc: make(prisma, access, {} as AgentWsServer), update };
    };
    const text = "FROM alpine:3.20\nRUN echo hi\n";

    it("persists the text for DOCKERFILE (replace semantics), leaves dockerfilePath stored, and audits only the byte length", async () => {
      const m = mk();
      await m.svc.setBuild("u1", "app1", { buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile", inlineDockerfile: text });
      const data = m.update.mock.calls[0][0].data;
      expect(data.inlineDockerfile).toBe(text);
      expect(data.dockerfilePath).toBe("docker/Dockerfile");
      expect(lastAudit().meta).toMatchObject({ inlineDockerfile: Buffer.byteLength(text) });
      expect(JSON.stringify(auditLog.mock.calls)).not.toContain("alpine");
    });

    it("omitting it clears a stored one (the card resends every field); switching away from DOCKERFILE clears it too", async () => {
      const a = mk({ inlineDockerfile: text });
      await a.svc.setBuild("u1", "app1", { buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile" });
      expect(a.update.mock.calls[0][0].data.inlineDockerfile).toBeNull();
      const b = mk({ inlineDockerfile: text });
      await b.svc.setBuild("u1", "app1", { buildType: "NIXPACKS" });
      expect(b.update.mock.calls[0][0].data.inlineDockerfile).toBeNull();
      // an app that never used it writes nothing for the column
      const c = mk();
      await c.svc.setBuild("u1", "app1", { buildType: "DOCKERFILE" });
      expect(c.update.mock.calls[0][0].data.inlineDockerfile).toBeUndefined();
    });

    it("the DTO refuses NUL, a missing FROM, an oversized text and a non-DOCKERFILE build type", async () => {
      const { SetBuildSchema } = await import("./dto");
      const ok = (o: object) => SetBuildSchema.safeParse({ buildType: "DOCKERFILE", ...o }).success;
      expect(ok({ inlineDockerfile: text })).toBe(true);
      expect(ok({ inlineDockerfile: "# syntax=docker/dockerfile:1\nARG V=1\nFROM alpine:${V}\n" })).toBe(true);
      expect(ok({ inlineDockerfile: "﻿from alpine\n" })).toBe(true); // BOM + case-insensitive
      expect(ok({ inlineDockerfile: "FROM a\0b" })).toBe(false);
      expect(ok({ inlineDockerfile: "RUN echo hi\n" })).toBe(false);
      expect(ok({ inlineDockerfile: "# only a comment\n" })).toBe(false);
      expect(ok({ inlineDockerfile: "FROM alpine\n" + "#".repeat(49 * 1024) })).toBe(false);
      expect(ok({ inlineDockerfile: "FROM alpine\n" + "é".repeat(25000) })).toBe(false); // 48 KiB counts BYTES
      expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS", inlineDockerfile: text }).success).toBe(false);
      expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", inlineDockerfile: null }).success).toBe(true);
    });
  });

  describe("copies: clone and preview", () => {
    it("clone copies the inline Dockerfile and the hook service, but NOT pushImageName / pushImageTag", async () => {
      const src = { ...app, id: "src1", name: "shop", source: "IMAGE", image: "nginx", isPreview: false, volumes: null, pushImageName: "team/web", pushImageTag: "stable", inlineDockerfile: "FROM x", composeHookService: "api", registryId: "reg1", pushToRegistry: true, envEnc: null };
      const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data, id: "clone1", createdAt: new Date() }));
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue(src), create },
        server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1", publicIp: null, publicIpv6: null, wildcardDomain: null, magicSuffix: null, certMode: "http", proxyBind: "public" }) },
        appIcon: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
        scheduledTask: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
        volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
      } as unknown as PrismaService;
      await make(prisma, {}, {} as AgentWsServer).clone("u1", "src1", {});
      const data = create.mock.calls[0][0].data;
      expect(data.inlineDockerfile).toBe("FROM x");
      expect(data.composeHookService).toBe("api");
      expect(data.registryId).toBe("reg1");
      expect("pushImageName" in data).toBe(false);
      expect("pushImageTag" in data).toBe(false);
    });

    it("a PR preview copies the inline Dockerfile only (no push fields, no hooks)", async () => {
      const create = jest.fn().mockResolvedValue({ id: "pv1", teamId: "t1", serverId: "s1", source: "GIT", isPreview: true });
      const prisma = { application: { findFirst: jest.fn().mockResolvedValue(null), create } } as unknown as PrismaService;
      const svc = make(prisma, {} as TeamAccessService, {} as AgentWsServer);
      jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue(undefined);
      const parent = { id: "app1", name: "web", teamId: "t1", serverId: "s1", environmentId: "e1", source: "GIT", gitUrl: "https://github.com/u/r.git", previewEnabled: true, domain: "app.example.com", envEnc: JSON.stringify({}), buildType: "DOCKERFILE", inlineDockerfile: "FROM y", pushImageName: "team/web", pushImageTag: "stable", composeHookService: "api", preDeployCommand: "x" } as unknown as Parameters<typeof svc.upsertPreview>[0];
      await svc.upsertPreview(parent, 7, "feature-7");
      const data = create.mock.calls[0][0].data;
      expect(data.inlineDockerfile).toBe("FROM y");
      for (const k of ["pushImageName", "pushImageTag", "composeHookService", "preDeployCommand"]) expect(k in data).toBe(false);
    });
  });

  describe("view(): visibility", () => {
    const listOne = async (row: Record<string, unknown>, perms: Set<string>) => {
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue([{ ...app, teamId: "t1", source: "IMAGE", environmentId: "e1", networks: [], networkAliases: [], dockerOptions: null, ...row }]) },
        environment: { findMany: jest.fn().mockResolvedValue([{ id: "e1", name: "production", project: { id: "p1", name: "Default" } }]) },
      } as unknown as PrismaService;
      const acc = {
        accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: Role.OWNER, restrictedAccess: false, accessedProjects: [], accessedResources: [] }]])),
        permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", perms]])),
        membershipPermissions: jest.fn().mockResolvedValue(perms),
      } as unknown as TeamAccessService;
      return (await make(prisma, acc, {} as AgentWsServer).list("u1"))[0];
    };
    const row = { source: "COMPOSE", composeFile: "services:\n  web:\n    image: n\n  api:\n    image: a\n", composePath: null, inlineDockerfile: "FROM secret_tok", composeHookService: "api", pushImageName: "team/web", pushImageTag: "stable" };

    it("a writer sees the inline text, the hook service and the pasted-compose service list", async () => {
      const v = await listOne(row, OWNER_PERMS());
      expect(v.inlineDockerfile).toBe("FROM secret_tok");
      expect(v.hasInlineDockerfile).toBe(true);
      expect(v.composeHookService).toBe("api");
      expect(v.composeServices).toEqual(["web", "api"]);
    });

    it("a read-only member sees only the booleans / non-secret push fields", async () => {
      const v = await listOne(row, new Set());
      expect(v.inlineDockerfile).toBeNull();
      expect(v.hasInlineDockerfile).toBe(true);
      expect(v.composeHookService).toBeNull();
      expect(v.composeServices).toEqual([]);
      expect(v.pushImageName).toBe("team/web");
      expect(v.pushImageTag).toBe("stable");
    });

    it("a git-compose app has no service list (the names are unknown on the hub)", async () => {
      const v = await listOne({ ...row, composeFile: null, composePath: "docker-compose.yml", gitUrl: "https://x/r.git" }, OWNER_PERMS());
      expect(v.composeServices).toEqual([]);
    });
  });

  describe("previewCompose", () => {
    const YAML = "services:\n  web:\n    image: nginx\n    environment:\n      A: ${A}\n";
    const render = (text: string) => `${COMPOSE_RENDERED_MARKER}${Buffer.from(text).toString("base64")}\n${COMPOSE_SHA_MARKER}${createHash("sha256").update(text).digest("hex")}\n`;
    const mk = (row: Record<string, unknown>, send: jest.Mock, sharedRows: { key: string; valueEnc: string }[] = []) => {
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML, composePath: null, env: {}, ...row }) },
        sharedVariable: { findMany: jest.fn().mockResolvedValue(sharedRows) },
      } as unknown as PrismaService;
      return make(prisma, access, { sendCommand: send } as unknown as AgentWsServer);
    };

    it("returns the redacted resolved compose, services, sha256 and audits only the byte size", async () => {
      const resolved = "services:\n  web:\n    image: nginx\n    command: run SHAREDSECRET_value_1\n    environment:\n      A: ${A}\n      PW: hunter2hunter2\n";
      const send = jest.fn().mockResolvedValue({ exitCode: 0, output: render(resolved) });
      const svc = mk({}, send, [{ key: "TOKEN", valueEnc: "SHAREDSECRET_value_1" }]);
      const r = await svc.previewCompose("u1", "app1");
      expect(r.services).toEqual(["web"]);
      expect(r.resolvedCompose).not.toContain("hunter2");
      expect(r.resolvedCompose).not.toContain("SHAREDSECRET_value_1");
      expect(r.resolvedCompose).toContain("${A}");
      expect(r.redactions).toBe(2);
      expect(r.sha256).toBe(createHash("sha256").update(r.resolvedCompose).digest("hex"));
      expect(send).toHaveBeenCalledWith("s1", expect.stringContaining("config --no-interpolate"), "deploy", 120_000);
      expect(lastAudit()).toMatchObject({ action: "app.compose.preview", target: "app1", meta: { bytes: Buffer.byteLength(r.resolvedCompose) } });
      expect(JSON.stringify(auditLog.mock.calls)).not.toContain("nginx");
    });

    it("400 for a non-compose app, a preview app and a pasted app with no file; the agent is never called", async () => {
      const send = jest.fn();
      await expect(mk({ source: "IMAGE" }, send).previewCompose("u1", "app1")).rejects.toBeInstanceOf(BadRequestException);
      await expect(mk({ isPreview: true }, send).previewCompose("u1", "app1")).rejects.toBeInstanceOf(BadRequestException);
      await expect(mk({ composeFile: null }, send).previewCompose("u1", "app1")).rejects.toBeInstanceOf(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });

    it("a non-writer is refused (apps:config)", async () => {
      const deny = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) } as unknown as TeamAccessService;
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE", composeFile: YAML }) } } as unknown as PrismaService;
      const send = jest.fn();
      await expect(make(prisma, deny, { sendCommand: send } as unknown as AgentWsServer).previewCompose("u1", "app1")).rejects.toBeInstanceOf(ForbiddenException);
      expect(send).not.toHaveBeenCalled();
    });

    it("409 while another preview of the same app is in flight, and the slot is released afterwards", async () => {
      let release!: (v: unknown) => void;
      const send = jest.fn().mockImplementationOnce(() => new Promise((r) => (release = r))).mockResolvedValue({ exitCode: 0, output: render("services:\n  web:\n    image: n\n") });
      const svc = mk({}, send);
      const first = svc.previewCompose("u1", "app1");
      await flushMicrotasks();
      await expect(svc.previewCompose("u1", "app1")).rejects.toBeInstanceOf(ConflictException);
      release({ exitCode: 0, output: render("services:\n  web:\n    image: n\n") });
      await first;
      await expect(svc.previewCompose("u1", "app1")).resolves.toBeDefined();
    });

    it("an offline agent surfaces as the typed error (and still releases the slot)", async () => {
      const { AgentOfflineException } = await import("../agent-gateway/agent-offline.exception");
      const send = jest.fn().mockRejectedValueOnce(new AgentOfflineException("offline")).mockResolvedValue({ exitCode: 0, output: render("services:\n  web:\n    image: n\n") });
      const svc = mk({}, send);
      await expect(svc.previewCompose("u1", "app1")).rejects.toBeInstanceOf(AgentOfflineException);
      await expect(svc.previewCompose("u1", "app1")).resolves.toBeDefined();
    });

    it("422 when the agent's compose lacks --no-interpolate, when the compose is unrenderable, and when the output is unreadable", async () => {
      const { UnprocessableEntityException } = await import("@nestjs/common");
      const unsupported = mk({}, jest.fn().mockResolvedValue({ exitCode: 2, output: "TUGRA_PREVIEW: unsupported\n" }));
      await expect(unsupported.previewCompose("u1", "app1")).rejects.toThrow(/update Docker Compose on the agent/);
      const err = mk({}, jest.fn().mockResolvedValue({ exitCode: 1, output: `TUGRA_PREVIEW_ERR_B64=${Buffer.from("yaml: line 3: bad").toString("base64")}\n` }));
      await expect(err.previewCompose("u1", "app1")).rejects.toThrow(/could not be rendered: the file is not valid YAML \(near line 3\)/);
      const junk = mk({}, jest.fn().mockResolvedValue({ exitCode: 0, output: "nothing useful" }));
      await expect(junk.previewCompose("u1", "app1")).rejects.toBeInstanceOf(UnprocessableEntityException);
      const big = mk({ composeFile: "services:\n" + "# x\n".repeat(60_000) }, jest.fn());
      await expect(big.previewCompose("u1", "app1")).rejects.toThrow(/too large to preview/);
    });

    it("git-compose: clones with the source token, and a rendered stack that escapes the clone is a WARNING (display only)", async () => {
      const resolved = "services:\n  web:\n    image: n\n    volumes:\n      - /etc:/host\n";
      const send = jest.fn().mockResolvedValue({ exitCode: 0, output: render(resolved) });
      const svc = mk({ composeFile: null, composePath: "docker-compose.yml", gitUrl: "https://github.com/u/r.git", gitBranch: "main" }, send);
      const r = await svc.previewCompose("u1", "app1");
      expect(send.mock.calls[0][1]).toContain("git clone");
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(r.services).toEqual(["web"]);
    });

    it("never exposes a tool in the MCP surface and the response field name is denied by the sanitizer", async () => {
      const { sanitizeToolResult } = await import("../mcp/tool-result-sanitizer");
      expect((sanitizeToolResult({ resolvedCompose: "x" }) as Record<string, unknown>).resolvedCompose).toBeNull();
      const tools = readFileSync(join(__dirname, "../mcp/mcp.service.ts"), "utf8");
      expect(tools).not.toMatch(/compose-preview|previewCompose|compose_preview/);
    });
  });
});

// ── app move guards (G3-D): every guard triggers ONLY while a live AppMove exists for the app ──
describe("ApplicationsService — app move guards", () => {
  const LIVE = { id: "mv1", phase: "TRANSFERRING" };
  const movingApp = { ...app, status: "RUNNING", source: "IMAGE" };
  const okAccess = (): TeamAccessService =>
    ({
      requirePermission: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
      requireResourceAccess: jest.fn().mockResolvedValue(undefined),
      membershipPermissions: jest.fn().mockResolvedValue(OWNER_PERMS()),
    }) as unknown as TeamAccessService;

  function mk(move: { id: string; phase: string } | null, extra: Record<string, unknown> = {}) {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(movingApp), update: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
      appMove: { findFirst: jest.fn().mockResolvedValue(move), findMany: jest.fn().mockResolvedValue(move ? [{ appId: movingApp.id, ...move }] : []) },
      deployment: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      ...extra,
    } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const svc = make(prisma, okAccess(), { sendCommand } as unknown as AgentWsServer);
    return { svc, prisma, sendCommand };
  }

  // [method, args after (userId, id)] — every config edit / lifecycle action / rollback entry the spec names.
  const GUARDED: [string, unknown[]][] = [
    ["rollback", ["d1"]],
    ["rollbackDetached", ["d1", { key: "k" }]],
    ["stop", []], ["start", []], ["restart", []], ["remove", [{}]],
    ["scaleNow", [2]], ["setClusterConfig", [{}]], ["setPlacement", [{}]],
    ["setNetworks", [{ networks: [] }]], ["setNetworkAliases", [[]]], ["setDbNetwork", [true]],
    ["setExtraPorts", [[]]], ["setContainerPort", [80]], ["setHostMounts", [[]]], ["setVolumes", [[]]],
    ["setDomain", [null]], ["setExtraDomains", [[]]], ["setServiceDomains", [[]]], ["expose", [{}]], ["setDomainOptions", [{}]],
    ["setBasicAuth", [[]]], ["setRedirects", [[]]], ["setCustomCert", ["c", "k"]], ["clearCustomCert", []], ["autoSetupDomain", [{}]],
    ["setComposeFile", ["services: {}"]], ["setSource", [{}]], ["setBuild", [{}]], ["setBuildConfig", [{}]],
    ["setDockerOptions", [null]], ["setCustomLabels", [{}]], ["setLimits", [{}]], ["setContainerCommand", [{}]], ["setDeployHooks", [{}]],
    ["setHealthCheck", [{}]], ["setConfigMountContent", ["/t", "x"]], ["setEnv", [{}]], ["setBuildArgs", [{}]], ["setBuildSecrets", [{}]],
    ["setCredentials", [{}]], ["setDeploySettings", [{}]], ["setRestartPolicy", [null]],
  ];

  it.each(GUARDED)("%s is refused with 409 app_move_in_progress during a move — before any side effect", async (method, args) => {
    const { svc, prisma, sendCommand } = mk(LIVE);
    const err = await (svc as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]("u1", "app1", ...args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: "app_move_in_progress" });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(prisma.application.update as jest.Mock).not.toHaveBeenCalled();
    expect(prisma.application.delete as jest.Mock).not.toHaveBeenCalled();
  });

  it("the guard is inert for an app with NO live move (stop runs as before)", async () => {
    const { svc, sendCommand, prisma } = mk(null);
    await svc.stop("u1", "app1");
    expect(sendCommand).toHaveBeenCalled();
    expect(prisma.application.update as jest.Mock).toHaveBeenCalled();
  });

  it("ensureNoActiveDeploy / assertNoActiveDeploy also refuse during a move (file edits, rollback, config edits)", async () => {
    const { svc } = mk(LIVE);
    await expect(svc.assertNoActiveDeploy("app1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "app_move_in_progress" }) });
    await expect((svc as unknown as { ensureNoActiveDeploy: (id: string) => Promise<void> }).ensureNoActiveDeploy("app1")).rejects.toBeInstanceOf(ConflictException);
    const none = mk(null).svc;
    await expect(none.assertNoActiveDeploy("app1")).resolves.toBeUndefined();
  });

  it("an active DEPLOY is still reported as such first (existing semantics unchanged)", async () => {
    const { svc, prisma } = mk(LIVE);
    (prisma.deployment.findFirst as jest.Mock).mockResolvedValue({ id: "d" });
    await expect((svc as unknown as { ensureNoActiveDeploy: (id: string) => Promise<void> }).ensureNoActiveDeploy("app1")).rejects.toBeInstanceOf(AppBusyException);
  });

  it("deploy QUEUEING stays allowed during a move (a QUEUED row is created, nothing is dispatched)", async () => {
    const created = { id: "dq", appId: "app1", status: "QUEUED" };
    const { svc, prisma, sendCommand } = mk(LIVE);
    (prisma.deployment.create as jest.Mock).mockResolvedValue(created);
    (prisma.deployment.findUnique as jest.Mock).mockResolvedValue(created);
    // claimNext (live move) only admits move:<id>, so the manual deploy waits: it is not claimed.
    jest.spyOn(svc as unknown as { claimNext: () => Promise<null> }, "claimNext").mockResolvedValue(null);
    const row = await svc.deploy("u1", "app1");
    expect(prisma.deployment.create as jest.Mock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "QUEUED" }) }));
    expect(row).toMatchObject({ id: "dq", status: "QUEUED" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rejects the reserved move: Idempotency-Key namespace from clients", async () => {
    const { svc } = mk(null);
    await expect(svc.deploy("u1", "app1", undefined, "move:abc")).rejects.toThrow(/reserved/);
    await expect(svc.deploy("u1", "app1", undefined, "  move:abc")).rejects.toThrow(/reserved/);
  });

  describe("claimNext", () => {
    type Row = { id: string; appId: string; status: string; idempotencyKey: string | null; createdAt: number };
    function queue(rows: Row[], move: { id: string; phase: string } | null) {
      const claimed: string[] = [];
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        deployment: {
          count: jest.fn().mockResolvedValue(0),
          findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            const key = where.idempotencyKey as { in: string[] } | undefined;
            const notIn = (where.id as { notIn: string[] }).notIn;
            return (
              rows
                .filter((r) => r.status === "QUEUED" && !notIn.includes(r.id))
                .filter((r) => (key ? key.in.includes(r.idempotencyKey ?? "") : (r.idempotencyKey ?? "").startsWith("move:") === false))
                .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
            );
          }),
          updateMany: jest.fn(async ({ where }: { where: { id: string } }) => {
            const r = rows.find((x) => x.id === where.id && x.status === "QUEUED");
            if (!r) return { count: 0 };
            r.status = "RUNNING";
            claimed.push(r.id);
            return { count: 1 };
          }),
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
        },
        appMove: { findFirst: jest.fn().mockResolvedValue(move) },
      };
      const prisma = { ...tx, $transaction: (cb: (t: unknown) => unknown) => cb(tx) } as unknown as PrismaService;
      const svc = make(prisma, okAccess(), {} as AgentWsServer);
      const claimNext = (id: string) => (svc as unknown as { claimNext: (id: string) => Promise<Row | null> }).claimNext(id);
      return { claimNext, claimed, tx };
    }
    const R = (id: string, key: string | null, at: number): Row => ({ id, appId: "app1", status: "QUEUED", idempotencyKey: key, createdAt: at });

    it("with a live move ONLY its own move:<id> deploy is claimable — older queued rows wait", async () => {
      const q = queue([R("old-webhook", null, 1), R("old-manual", "client-key", 2), R("move-dep", "move:mv1", 3)], LIVE);
      expect((await q.claimNext("app1"))?.id).toBe("move-dep");
      expect(await q.claimNext("app1")).toBeNull(); // nothing else is claimable until the move ends
      expect(q.claimed).toEqual(["move-dep"]);
    });

    it("with a live move but no move deploy queued yet, nothing is claimed", async () => {
      const q = queue([R("old-webhook", null, 1)], LIVE);
      expect(await q.claimNext("app1")).toBeNull();
    });

    it("the move's rollback deploy (move:<id>:rb) is claimable too, ahead of every other queued row", async () => {
      const q = queue([R("old", null, 1), R("rb", "move:mv1:rb", 5)], LIVE);
      expect((await q.claimNext("app1"))?.id).toBe("rb");
      expect(await q.claimNext("app1")).toBeNull();
    });

    it("another move's deploy key is never claimable", async () => {
      const q = queue([R("foreign", "move:other", 1)], LIVE);
      expect(await q.claimNext("app1")).toBeNull();
    });

    it("without a live move the queue is FIFO as before and a stale move: row (its move is over) is never run", async () => {
      const q = queue([R("stale-move", "move:mv0", 1), R("w1", null, 2), R("w2", "k", 3)], null);
      expect((await q.claimNext("app1"))?.id).toBe("w1");
      expect((await q.claimNext("app1"))?.id).toBe("w2");
      expect(await q.claimNext("app1")).toBeNull();
      expect(q.claimed).not.toContain("stale-move");
    });
  });

  describe("resolveRollbackSource (server-aware)", () => {
    const resolve = (a: Record<string, unknown>, t: Record<string, unknown> | null) =>
      (mk(null).svc as unknown as { resolveRollbackSource: (a: unknown, t: unknown) => Promise<unknown> }).resolveRollbackSource({ ...movingApp, ...a }, t);
    const row = (over: Record<string, unknown>) => ({ id: "d1", appId: "app1", status: "SUCCESS", imageTag: "tugra_app1:d1", registryImage: null, imageDigest: null, runServerId: null, ...over });

    it("a pre-move deploy with only a local tag on the OLD server is not rollbackable (409 rollback_predates_move)", async () => {
      await expect(resolve({ serverId: "s2" }, row({ runServerId: "s1" }))).rejects.toMatchObject({ response: expect.objectContaining({ code: "rollback_predates_move" }) });
    });

    it("legacy NULL runServerId rows behave as before", async () => {
      await expect(resolve({ serverId: "s2" }, row({ runServerId: null }))).resolves.toMatchObject({ isCompose: false });
    });

    it("a row that ran on the CURRENT server is fine (move back, or never moved)", async () => {
      await expect(resolve({ serverId: "s1" }, row({ runServerId: "s1" }))).resolves.toBeDefined();
    });

    it("a registry image or a pinned digest is still rollbackable across servers", async () => {
      await expect(resolve({ serverId: "s2" }, row({ runServerId: "s1", registryImage: "r/x:1" }))).resolves.toBeDefined();
      await expect(resolve({ serverId: "s2" }, row({ runServerId: "s1", imageDigest: "nginx@sha256:abc" }))).resolves.toBeDefined();
    });

    it("compose apps are unaffected (the YAML snapshot is the artifact)", async () => {
      await expect(resolve({ serverId: "s2", source: "COMPOSE" }, row({ runServerId: "s1", imageTag: null, configSnapshot: { composeFile: "services: {}" } }))).resolves.toMatchObject({ isCompose: true });
    });
  });

  describe("AppView.move", () => {
    it("get() reports the live move {id, phase}; null when there is none", async () => {
      const { svc } = mk(LIVE);
      expect((await svc.get("u1", "app1")).move).toEqual({ id: "mv1", phase: "TRANSFERRING" });
      expect((await mk(null).svc.get("u1", "app1")).move).toBeNull();
    });

    it("list() batches live moves in ONE query and attaches them per app", async () => {
      const apps = [{ ...movingApp, id: "a1", environmentId: "e1" }, { ...movingApp, id: "a2", environmentId: "e1" }];
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue(apps) },
        containerState: { findMany: jest.fn().mockResolvedValue([]) },
        environment: { findMany: jest.fn().mockResolvedValue([]) },
        appMove: { findMany: jest.fn().mockResolvedValue([{ appId: "a2", id: "mvX", phase: "DEPLOYING" }]) },
      } as unknown as PrismaService;
      const acc = accessWith({
        accessByTeam: jest.fn().mockResolvedValue(new Map([["t1", { role: "OWNER", scoped: false, accessedProjects: [], accessedResources: [] }]])),
        permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", OWNER_PERMS()]])),
      } as never);
      const svc = make(prisma, acc, {} as AgentWsServer);
      const out = await svc.list("u1");
      expect(prisma.appMove.findMany as jest.Mock).toHaveBeenCalledTimes(1);
      expect(Object.fromEntries(out.map((v) => [v.id, v.move]))).toEqual({ a1: null, a2: { id: "mvX", phase: "DEPLOYING" } });
    });
  });

  describe("remove() and move archives", () => {
    const archive = { id: "ckmoveabcdefghijklmnopqrs", appId: "app1", phase: "COMPLETED", sourceServerId: "s0", targetServerId: "s1", sourcePurgedAt: null, volumes: [{ name: "data", dockerName: "tugra_appv_app1_data", state: "APPLIED" }] };
    function mkRemove(archives: unknown[]) {
      const sent: { host: string; cmd: string }[] = [];
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        application: { findUnique: jest.fn().mockResolvedValue({ ...movingApp, serverId: "s1", source: "IMAGE", clusterId: null, networks: [], dockerOptions: null, buildServerId: null }), delete: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        appMove: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue(archives), update },
      } as unknown as PrismaService;
      const agentWs = {
        sendCommand: jest.fn().mockImplementation((host: string, cmd: string) => {
          sent.push({ host, cmd });
          return Promise.resolve({ exitCode: 0, output: cmd.includes("TUGRA_VX_CLEANUP_DONE") ? "TUGRA_VX_VOL tugra_appv_app1_data removed\nTUGRA_VX_CLEANUP_DONE\n" : "" });
        }),
        isOnline: jest.fn().mockReturnValue(true),
      } as unknown as AgentWsServer;
      return { sent, update, prisma, svc: make(prisma, okAccess(), agentWs, makeDeployLogs(), makeMonitors()) };
    }

    it("deleting an app best-effort purges the archived data a COMPLETED move left on the old server (before the row is deleted)", async () => {
      const t = mkRemove([archive]);
      await t.svc.remove("u1", "app1");
      const purge = t.sent.find((s) => s.host === "s0");
      expect(purge?.cmd).toContain("docker volume rm 'tugra_appv_app1_data'");
      expect(t.update).toHaveBeenCalledWith({ where: { id: archive.id }, data: { sourcePurgedAt: expect.any(Date) } });
      expect((t.prisma.application.delete as jest.Mock)).toHaveBeenCalled();
      expect(t.prisma.appMove.findMany).toHaveBeenCalledWith({ where: { appId: "app1", phase: "COMPLETED", sourcePurgedAt: null } });
    });

    it("keepVolumes keeps the old server's archive too: no purge command, no stamp, and the lookup is skipped", async () => {
      const t = mkRemove([archive]);
      await t.svc.remove("u1", "app1", { keepVolumes: true });
      expect(t.sent.some((s) => s.host === "s0")).toBe(false);
      expect(t.update).not.toHaveBeenCalled();
      expect(t.prisma.appMove.findMany).not.toHaveBeenCalled();
      expect((t.prisma.application.delete as jest.Mock)).toHaveBeenCalled();
    });

    it("an unreachable old server never blocks the delete (the move's sweeper keeps the archive; AppMove has no FK to the app)", async () => {
      const t = mkRemove([archive]);
      (t.prisma as unknown as { appMove: { findMany: jest.Mock } }).appMove.findMany.mockResolvedValue([{ ...archive }]);
      const agentWs = (t.svc as unknown as { agentWs: { sendCommand: jest.Mock } }).agentWs;
      agentWs.sendCommand.mockImplementation((host: string, cmd: string) => (host === "s0" ? Promise.reject(new Error("agent offline")) : Promise.resolve({ exitCode: 0, output: cmd })));
      await t.svc.remove("u1", "app1");
      expect((t.prisma.application.delete as jest.Mock)).toHaveBeenCalled();
      expect(t.update).not.toHaveBeenCalled();
    });

    it("an app with no archive deletes exactly as before", async () => {
      const t = mkRemove([]);
      await t.svc.remove("u1", "app1");
      expect(t.sent.every((s) => s.host === "s1")).toBe(true);
    });
  });

  describe("move seams used by the runner", () => {
    it("moveLifecycle (classic app) uses the SAME builders as stop/start/remove, and the remove keeps the volumes", async () => {
      const { svc } = mk(null);
      const life = await svc.moveLifecycle({ ...movingApp, volumes: [{ name: "data", path: "/data" }] } as never);
      expect(life.stop).toBe("docker stop tugra_app1 2>/dev/null || true");
      expect(life.start).toBe("docker start tugra_app1");
      expect(life.removeContainer).toContain("docker rm -f tugra_app1");
      expect(life.removeContainer).not.toMatch(/docker volume rm/); // the archive: volumes stay until the purge
      expect(life.timeoutMs).toBeGreaterThanOrEqual(120_000);
    });

    it("moveLifecycle (compose app) builds compose stop/start and a `down` WITHOUT -v", async () => {
      const { svc } = mk(null);
      const compose = { ...movingApp, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx\n", env: {}, envEnc: null };
      const life = await svc.moveLifecycle(compose as never);
      expect(life.stop).toMatch(/compose.* stop/);
      expect(life.start).toMatch(/compose.* start/);
      expect(life.removeContainer).toMatch(/compose.* down/);
      expect(life.removeContainer).not.toMatch(/ down[^\n]*(-v|--volumes)/);
    });

    it("submitMoveDeploy enqueues with the move's key, the `move` trigger and the detached shape; unknown app is 404", async () => {
      const { svc } = mk(null);
      const spy = jest.spyOn(svc as unknown as { submitDeploy: (...a: unknown[]) => Promise<unknown> }, "submitDeploy").mockResolvedValue({ id: "dep1", status: "RUNNING" });
      await expect(svc.submitMoveDeploy("app1", "u1", "move:mv1")).resolves.toMatchObject({ id: "dep1" });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "app1" }), "u1", false, "move:mv1", { detach: true, trigger: "move" });
      const none = mk(null);
      (none.prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(none.svc.submitMoveDeploy("nope", "u1", "move:x")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("syncAfterMove re-pushes log drains to BOTH servers, resyncs the tunnel only when exposed, and reports failed steps", async () => {
      const pushForServers = jest.fn().mockResolvedValue(undefined);
      const monitors = makeMonitors();
      monitors.removeForApp.mockRejectedValue(new Error("monitor down"));
      const prisma = { application: { findUnique: jest.fn().mockResolvedValue({ ...movingApp, tunnelExposed: false }) }, appMove: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
      const svc = make(prisma, okAccess(), {} as AgentWsServer, makeDeployLogs(), monitors, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { pushForServers });
      expect(await svc.syncAfterMove("app1", ["s1", "s2", "s1"])).toEqual(["monitor"]);
      expect(pushForServers).toHaveBeenCalledWith(["s1", "s2", "s1"]);
    });

    it("cancelMoveDeployment: a QUEUED row is cancelled by CAS; a RUNNING one has its in-flight agent command killed; a finished one is left alone", async () => {
      const updateMany = jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      const cancelCommand = jest.fn().mockReturnValue(true);
      const prisma = {
        deployment: { updateMany, findUnique: jest.fn().mockResolvedValue({ id: "d2", status: "SUCCESS" }), count: jest.fn().mockResolvedValue(0) },
        appMove: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      const svc = make(prisma, okAccess(), { cancelCommand } as unknown as AgentWsServer);
      expect(await svc.cancelMoveDeployment("d1", "rolled back")).toBe(true);
      expect(updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "QUEUED" }, data: { status: "CANCELLED", exitCode: -1, logs: "rolled back" } });
      // RUNNING with a live in-memory command
      (svc as unknown as { activeDeployCommands: Map<string, { serverId: string; reqId: string }> }).activeDeployCommands.set("d3", { serverId: "s2", reqId: "r9" });
      expect(await svc.cancelMoveDeployment("d3", "x")).toBe(true);
      expect(cancelCommand).toHaveBeenCalledWith("s2", "r9");
      // nothing to cancel
      expect(await svc.cancelMoveDeployment("d2", "x")).toBe(false);
    });

    it("drainApp runs the queue drain for the app", async () => {
      const { svc } = mk(null);
      const drain = jest.spyOn(svc as unknown as { drain: (id: string) => Promise<void> }, "drain").mockResolvedValue(undefined);
      await svc.drainApp("app1");
      expect(drain).toHaveBeenCalledWith("app1");
    });
  });

  it("upsertPreview (PR webhook) is skipped, not failed, while the parent is moving", async () => {
    const create = jest.fn();
    const { svc, prisma } = mk(LIVE, { application: { findFirst: jest.fn(), create, findUnique: jest.fn() } });
    const parent = { id: "app1", name: "web", teamId: "t1", serverId: "s1", environmentId: "e1", source: "GIT", gitUrl: "https://github.com/u/r.git", previewEnabled: true, domain: "app.example.com" } as unknown as Parameters<typeof svc.upsertPreview>[0];
    await svc.upsertPreview(parent, 7, "feat");
    expect(create).not.toHaveBeenCalled();
    expect(prisma.appMove.findFirst as jest.Mock).toHaveBeenCalled();
  });
});
