import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ApplicationsService } from "./applications.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const audit = { log: jest.fn() } as unknown as AuditService;

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
});
