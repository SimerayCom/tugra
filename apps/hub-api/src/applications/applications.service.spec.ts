import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ApplicationsService } from "./applications.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s,
} as unknown as CryptoService;

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer>,
) {
  return new ApplicationsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    agentWs as AgentWsServer,
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
      },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "deployed" }),
    } as unknown as AgentWsServer;

    const svc = make(prisma, access, agentWs);
    const dep = await svc.deploy("u1", "app1");

    expect(agentWs.sendCommand).toHaveBeenCalled();
    expect(depUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", exitCode: 0 }) }),
    );
    expect(appUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "RUNNING" } }),
    );
    expect(dep?.status).toBe("SUCCESS");
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
      },
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
