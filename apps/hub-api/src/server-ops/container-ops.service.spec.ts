import { BadRequestException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { ContainerOpsService } from "./container-ops.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { LogStreamService } from "../agent-gateway/log-stream.service";
import { ContainerMetricsService } from "../metrics/container-metrics.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const server = { id: "s1", teamId: "t1" };

function make(over: {
  requirePermission?: jest.Mock;
  isOnline?: jest.Mock;
  forServer?: jest.Mock;
  stream?: jest.Mock;
  sendCommand?: jest.Mock;
} = {}) {
  const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
  const access = { requirePermission: over.requirePermission ?? jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const agentWs = {
    isOnline: over.isOnline ?? jest.fn().mockReturnValue(true),
    sendCommand: over.sendCommand ?? jest.fn().mockResolvedValue({ exitCode: 0, output: "" }),
  } as unknown as AgentWsServer;
  const logStream = { stream: over.stream ?? jest.fn().mockReturnValue({ pipe: jest.fn() }) } as unknown as LogStreamService;
  const containerMetrics = {
    forServer:
      over.forServer ??
      jest.fn().mockResolvedValue({
        containers: [
          { name: "nginx", kind: "other" },
          { name: "tugra_db_x", kind: "db" },
          { name: "tugra-hub-api-1", kind: "system" },
        ],
      }),
  } as unknown as ContainerMetricsService;
  return new ContainerOpsService(prisma, access, audit, agentWs, logStream, containerMetrics);
}

describe("ContainerOpsService", () => {
  it("streams a container that is actually on the host (writer) and audits", async () => {
    const stream = jest.fn().mockReturnValue({ pipe: jest.fn() });
    (audit.log as jest.Mock).mockClear();
    const svc = make({ stream });
    await svc.streamLogs("u1", "s1", "nginx", { tail: 100 });
    expect(stream).toHaveBeenCalledWith("s1", "nginx", expect.objectContaining({ follow: true }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.container.logs.stream" }));
  });

  it("rejects a container that is NOT in the host inventory (no arbitrary target)", async () => {
    const stream = jest.fn();
    await expect(make({ stream }).streamLogs("u1", "s1", "someone-elses-db", {})).rejects.toBeInstanceOf(BadRequestException);
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects an invalid container name before touching the inventory", async () => {
    const forServer = jest.fn();
    await expect(make({ forServer }).streamLogs("u1", "s1", "bad name; rm -rf", {})).rejects.toBeInstanceOf(BadRequestException);
    expect(forServer).not.toHaveBeenCalled();
  });

  it("rejects a non-writer (servers:ops required)", async () => {
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException());
    await expect(make({ requirePermission }).streamLogs("u1", "s1", "nginx", {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects when the agent is offline", async () => {
    const isOnline = jest.fn().mockReturnValue(false);
    await expect(make({ isOnline }).streamLogs("u1", "s1", "nginx", {})).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("restarts a container and audits", async () => {
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    (audit.log as jest.Mock).mockClear();
    await make({ sendCommand }).action("u1", "s1", "tugra_db_x", "restart");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker restart tugra_db_x", "bulk", expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.container.restart" }));
  });

  it("force-removes a FOREIGN container when the name is confirmed", async () => {
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    await make({ sendCommand }).action("u1", "s1", "nginx", "remove", "nginx");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker rm -f nginx", "bulk", expect.any(Number));
  });

  it("THROWS and does not audit success when the docker command exits non-zero", async () => {
    // sendCommand resolves even on a non-zero exit (the command ran but failed) — the action must not
    // report success, or the 200 + UI toast would lie.
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 1, output: "Error response from daemon" });
    (audit.log as jest.Mock).mockClear();
    await expect(make({ sendCommand }).action("u1", "s1", "tugra_db_x", "restart")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("refuses to remove a MANAGED (db/app) container — steer to resource delete", async () => {
    const sendCommand = jest.fn();
    await expect(make({ sendCommand }).action("u1", "s1", "tugra_db_x", "remove", "tugra_db_x")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("refuses remove without a matching name confirmation", async () => {
    const sendCommand = jest.fn();
    await expect(make({ sendCommand }).action("u1", "s1", "nginx", "remove", "wrong")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("never acts on Tugra's own control-plane containers", async () => {
    const sendCommand = jest.fn();
    await expect(make({ sendCommand }).action("u1", "s1", "tugra-hub-api-1", "stop")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rejects a non-writer (servers:ops required) for actions", async () => {
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException());
    await expect(make({ requirePermission }).action("u1", "s1", "nginx", "restart")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
