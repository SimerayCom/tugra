import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ApplicationsService } from "./applications.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { CryptoService } from "../crypto/crypto.service";

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

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer>,
  deployLogs: DeployLogHub = makeDeployLogs(),
) {
  return new ApplicationsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    agentWs as AgentWsServer,
    deployLogs,
    { ensureProxy: jest.fn() } as unknown as import("./proxy.service").ProxyService,
    crypto,
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

describe("ApplicationsService", () => {
  it("forbids creating an app for a team the user can't write to", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(
      svc.create("u1", { name: "web", serverId: "s1", image: "nginx" }),
    ).rejects.toThrow(/nope/);
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
  });

  it("refuses a second deploy while one is already running (409)", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      deployment: { findFirst: jest.fn().mockResolvedValue({ id: "running", status: "RUNNING" }) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    expect(await svc.getEnv("u1", "app1")).toEqual({ FOO: "bar" });
  });

  it("forbids a non-writer from reading or setting env", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setEnv("u1", "app1", { FOO: "bar" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { envEnc: 'enc({"FOO":"bar"})' } }),
    );
  });

  it("forbids a non-writer from setting resource limits", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setLimits("u1", "app1", { healthCmd: "ping", memoryMb: 256, cpus: 0.5 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { healthCmd: "ping", memoryMb: 256, cpus: 0.5 } }),
    );
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
      requireRole: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue(Role.OWNER),
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
  });

  it("forbids a non-writer from setting credentials", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { teamRole: jest.fn().mockResolvedValue(Role.OWNER) } as unknown as TeamAccessService;
    const view = await make(prisma, access, {} as AgentWsServer).get("u1", "app1");
    expect(view.hasGitToken).toBe(true);
    expect(view.registryUrl).toBe("reg.io");
    expect(view.registryUser).toBe("u");
    expect(JSON.stringify(view)).not.toContain("ghp_abc");
    expect(JSON.stringify(view)).not.toContain('"token":"p"');
  });

  it("persists domain options for a writer", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).setDomainOptions("u1", "app1", {
      domainRedirect: "root",
      securityHeaders: true,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { domainRedirect: "root", securityHeaders: true } }),
    );
  });

  it("rejects moving an app to an environment in another team", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn() },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { teamId: "OTHER" } }) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setEnvironment("u1", "app1", "e1"),
    ).rejects.toThrow(/not found in this team/);
  });

  it("assigns an app to a same-team environment and can unassign", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update },
      environment: { findUnique: jest.fn().mockResolvedValue({ id: "e1", project: { teamId: "t1" } }) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await svc.setEnvironment("u1", "app1", "e1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { environmentId: "e1" } }));
    await svc.setEnvironment("u1", "app1", null);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { environmentId: null } }));
  });

  it("forbids a non-writer from setting volumes", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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

  it("refuses rollback for a compose app", async () => {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue({ ...app, source: "COMPOSE" }) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = make(prisma, access, {} as AgentWsServer);
    await expect(svc.rollback("u1", "app1", "depX")).rejects.toThrow(/compose/);
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
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await expect(
      make(prisma, access, {} as AgentWsServer).setPreviewEnabled("u1", "parent1", true),
    ).rejects.toThrow(/domain/);
  });

  it("list() excludes preview apps from the top-level listing", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { application: { findMany } } as unknown as PrismaService;
    const access = {
      roleByTeam: jest.fn().mockResolvedValue(new Map([["t1", Role.OWNER]])),
    } as unknown as TeamAccessService;
    await make(prisma, access, {} as AgentWsServer).list("u1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isPreview: false }) }),
    );
  });

  it("rolls back by re-running the target image tag without rebuilding", async () => {
    const depUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app), update: jest.fn().mockResolvedValue({}) },
      deployment: {
        findFirst: jest.fn().mockResolvedValue({ id: "dep1", appId: "app1", status: "SUCCESS", imageTag: "tugra_app1:dep1" }),
        create: jest.fn().mockResolvedValue({ id: "dep2" }),
        update: depUpdate,
        findUnique: jest.fn().mockResolvedValue({ id: "dep2", status: "SUCCESS" }),
      },
      sharedVariable: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
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
});
