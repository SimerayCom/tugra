import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ApplicationsService } from "./applications.service";
import { SetEnvironmentSchema } from "./dto";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { CryptoService } from "../crypto/crypto.service";
import { TEMPLATES, templateMetaList } from "../templates/catalog";
import type { TemplateCatalogService } from "../catalog/template-catalog.service";

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
) {
  // createFromTemplate v2 probes listening ports (outside the tx) before allocating.
  portAlloc.probeUsedPorts = portAlloc.probeUsedPorts ?? jest.fn().mockResolvedValue(new Set());
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
  } as unknown as Partial<PrismaService>;
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
    { installationToken: jest.fn().mockResolvedValue("ghs_inst") } as unknown as import("../git-sources/git-sources.service").GitSourcesService,
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
      scale: jest.fn().mockResolvedValue(undefined),
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
      get: () => ({ syncIngress: jest.fn().mockResolvedValue(undefined) }),
    } as unknown as import("@nestjs/core").ModuleRef,
  );
}

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
  type WithRunDeploy = { runDeploy: (...a: unknown[]) => Promise<unknown> };

  it("fires a best-effort deploy when deploy:true", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    const runDeploy = jest
      .spyOn(svc as unknown as WithRunDeploy, "runDeploy")
      .mockResolvedValue(undefined);
    await svc.create("u1", { name: "web", serverId: "s1", image: "nginx", deploy: true });
    expect(runDeploy).toHaveBeenCalledWith(expect.objectContaining({ id: "app1" }), "u1");
  });

  it("does not deploy when the deploy flag is absent", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    const runDeploy = jest
      .spyOn(svc as unknown as WithRunDeploy, "runDeploy")
      .mockResolvedValue(undefined);
    await svc.create("u1", { name: "web", serverId: "s1", image: "nginx" });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("still creates successfully when the best-effort deploy fails (agent offline)", async () => {
    const { prisma, access } = createDeps();
    const svc = make(prisma, access, {} as AgentWsServer);
    jest
      .spyOn(svc as unknown as WithRunDeploy, "runDeploy")
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

  it("refuses a second deploy while one is already running (409)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: { findFirst: jest.fn().mockResolvedValue({ id: "running", status: "RUNNING" }) },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(make(prisma, access, {} as AgentWsServer).deploy("u1", "app1")).rejects.toThrow(
      /already running/,
    );
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
      expect.objectContaining({ data: { envEnc: 'enc({"FOO":"bar"})' } }),
    );
  });

  it("start and restart run lifecycle commands and set RUNNING", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const svc = make(prisma, access, { sendCommand } as unknown as AgentWsServer);
    await svc.start("u1", "app1");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker start tugra_app1", "deploy");
    await svc.restart("u1", "app1");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker restart tugra_app1", "deploy");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
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
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { memoryMb: 256, cpus: 0.5, reserveMemoryMb: null, reserveCpus: null, gpus: "all", deployTimeoutSec: 600 } }),
    );
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

  it("an Automatic (type null) save preserves a legacy healthCmd", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setHealthCheck("u1", "app1", { type: null, command: null });
    const data = update.mock.calls[0][0].data;
    expect("healthCmd" in data).toBe(false); // untouched → a pre-existing native check survives
    expect(data.healthCheckType).toBeNull();
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
    expect(custom.sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "deploy", 600000, expect.any(Function));
    const def = mk(null);
    await def.svc.deploy("u1", "app1");
    expect(def.sendCommand).toHaveBeenCalledWith("s1", expect.any(String), "deploy", 300000, expect.any(Function));
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
    expect(update).toHaveBeenCalledWith({ where: { id: "app1" }, data: { domain: null, domainKind: "none" } });
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
    await svc.upsertPreview(parentApp as never, 5, "feature-x");

    const data = create.mock.calls[0][0].data;
    expect(data.isPreview).toBe(true);
    expect(data.parentAppId).toBe("parent1");
    expect(data.prNumber).toBe(5);
    expect(data.gitBranch).toBe("feature-x");
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
      expect.objectContaining({ where: { id: "prev1" }, data: { gitBranch: "feat-v2" } }),
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
    expect(del).toHaveBeenCalledWith({ where: { id: "prev1" } });
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
