import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SwarmProxyService } from "./swarm-proxy.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ConfigService } from "@nestjs/config";

function make(opts: {
  swarmStatus?: string;
  swarmManagerId?: string | null;
  managerStatus?: string;
  swarmNodeId?: string | null;
  classicDomainApps?: number;
  classicProxyOutput?: string; // buildClassicProxyRunningScript output
  proxyReplicas?: string; // buildSwarmProxyStatusScript output
} = {}) {
  const cluster = { swarmStatus: opts.swarmStatus ?? "ACTIVE", swarmManagerId: opts.swarmManagerId ?? "mgr" };
  const prisma = {
    cluster: { findUnique: jest.fn().mockResolvedValue(cluster) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "mgr", status: opts.managerStatus ?? "ONLINE", swarmNodeId: opts.swarmNodeId ?? "node_1" }) },
    application: { count: jest.fn().mockResolvedValue(opts.classicDomainApps ?? 0) },
  } as unknown as PrismaService;
  const send = jest.fn(async (_serverId: string, cmd: string, _cap: string) => {
    if (cmd.includes("docker ps --filter name=^/tugra-proxy$")) return { exitCode: 0, output: opts.classicProxyOutput ?? "" };
    if (cmd.includes("docker service ls --filter name=tugra-swarm-proxy")) return { exitCode: 0, output: opts.proxyReplicas ?? "1/1" };
    return { exitCode: 0, output: "" };
  });
  const agent = { sendCommand: send } as unknown as AgentWsServer;
  const config = { get: () => "ops@x.io" } as unknown as ConfigService;
  return { svc: new SwarmProxyService(prisma, agent, config), send };
}

describe("SwarmProxyService.ensure", () => {
  it("stands up the overlay + swarm-Traefik on the manager and verifies it reached 1/1", async () => {
    const { svc, send } = make();
    await svc.ensure("c1");
    const ensureCall = send.mock.calls.find((c) => (c[1] as string).includes("docker service create --detach --name tugra-swarm-proxy"));
    expect(ensureCall).toBeTruthy();
    expect(ensureCall![0]).toBe("mgr");
    expect(ensureCall![2]).toBe("swarm");
    expect(ensureCall![1]).toContain("docker node update --label-add tugra.proxy=true 'node_1'");
  });

  it("refuses when the manager also hosts classic domain-routed apps (:80/:443 collision)", async () => {
    const { svc } = make({ classicDomainApps: 2 });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses when a classic tugra-proxy container is running on the manager", async () => {
    const { svc } = make({ classicProxyOutput: "tugra-proxy" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("errors when the swarm proxy never reaches 1/1 (e.g. pin/constraint didn't take)", async () => {
    const { svc } = make({ proxyReplicas: "0/1" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("errors when the manager is offline", async () => {
    const { svc } = make({ managerStatus: "OFFLINE" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("blocks a non-formed swarm", async () => {
    const { svc } = make({ swarmStatus: "NONE" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
