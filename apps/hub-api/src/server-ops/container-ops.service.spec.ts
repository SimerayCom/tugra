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

// `docker ps -a` output the agent returns: nginx (foreign, stopped), a managed db (running), Tugra's own
// hub (running). kind is derived from the name by resolveContainerLabel, so no app/db rows are needed.
const PS_OUTPUT = "nginx\texited\ntugra_db_x\trunning\ntugra-hub-api-1\trunning";
// A sendCommand mock that answers the `docker ps -a` inventory call with PS_OUTPUT and every other command
// (the actual lifecycle action) with `result`. action() lists first, then runs the command.
function sendMock(result: { exitCode: number; output: string } = { exitCode: 0, output: "" }) {
  return jest.fn().mockImplementation((_s: string, cmd: string) =>
    Promise.resolve(cmd.includes("ps -a") ? { exitCode: 0, output: PS_OUTPUT } : result),
  );
}

function make(over: {
  requirePermission?: jest.Mock;
  isOnline?: jest.Mock;
  forServer?: jest.Mock;
  stream?: jest.Mock;
  sendCommand?: jest.Mock;
} = {}) {
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue(server) },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const access = { requirePermission: over.requirePermission ?? jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
  const agentWs = {
    isOnline: over.isOnline ?? jest.fn().mockReturnValue(true),
    sendCommand: over.sendCommand ?? sendMock(),
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
    const sendCommand = sendMock();
    (audit.log as jest.Mock).mockClear();
    await make({ sendCommand }).action("u1", "s1", "tugra_db_x", "restart");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker restart tugra_db_x", "bulk", expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.container.restart" }));
  });

  it("starts a STOPPED container (the metrics inventory can't see it; the live ps -a list can)", async () => {
    const sendCommand = sendMock();
    (audit.log as jest.Mock).mockClear();
    await make({ sendCommand }).action("u1", "s1", "nginx", "start"); // nginx is `exited` in PS_OUTPUT
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker start nginx", "bulk", expect.any(Number));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.container.start" }));
  });

  it("force-removes a FOREIGN container when the name is confirmed", async () => {
    const sendCommand = sendMock();
    await make({ sendCommand }).action("u1", "s1", "nginx", "remove", "nginx");
    expect(sendCommand).toHaveBeenCalledWith("s1", "docker rm -f nginx", "bulk", expect.any(Number));
  });

  it("THROWS and does not audit success when the docker command exits non-zero", async () => {
    // sendCommand resolves even on a non-zero exit (the command ran but failed) — the action must not
    // report success, or the 200 + UI toast would lie. (The ps -a listing still succeeds.)
    const sendCommand = sendMock({ exitCode: 1, output: "Error response from daemon" });
    (audit.log as jest.Mock).mockClear();
    await expect(make({ sendCommand }).action("u1", "s1", "tugra_db_x", "restart")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("refuses to remove a MANAGED (db/app) container — steer to resource delete", async () => {
    const sendCommand = sendMock();
    await expect(make({ sendCommand }).action("u1", "s1", "tugra_db_x", "remove", "tugra_db_x")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalledWith("s1", "docker rm -f tugra_db_x", "bulk", expect.any(Number)); // guard fired; action never ran
  });

  it("refuses remove without a matching name confirmation", async () => {
    const sendCommand = sendMock();
    await expect(make({ sendCommand }).action("u1", "s1", "nginx", "remove", "wrong")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalledWith("s1", "docker rm -f nginx", "bulk", expect.any(Number));
  });

  it("never acts on Tugra's own control-plane containers", async () => {
    const sendCommand = sendMock();
    await expect(make({ sendCommand }).action("u1", "s1", "tugra-hub-api-1", "stop")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalledWith("s1", "docker stop tugra-hub-api-1", "bulk", expect.any(Number));
  });

  it("rejects an action on a container that isn't on the host at all", async () => {
    const sendCommand = sendMock();
    await expect(make({ sendCommand }).action("u1", "s1", "ghost", "restart")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalledWith("s1", "docker restart ghost", "bulk", expect.any(Number));
  });

  it("rejects a non-writer (servers:ops required) for actions", async () => {
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException());
    await expect(make({ requirePermission }).action("u1", "s1", "nginx", "restart")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects an action when the agent is offline (before any command)", async () => {
    const isOnline = jest.fn().mockReturnValue(false);
    const sendCommand = sendMock();
    await expect(make({ isOnline, sendCommand }).action("u1", "s1", "nginx", "restart")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("ContainerOpsService.list (host-wide incl. stopped)", () => {
  it("returns every container with its state + resolved kind", async () => {
    const r = await make().list("u1", "s1");
    const names = r.containers.map((c) => c.name).sort();
    expect(names).toEqual(["nginx", "tugra-hub-api-1", "tugra_db_x"]);
    const nginx = r.containers.find((c) => c.name === "nginx")!;
    expect(nginx.state).toBe("exited");
    expect(nginx.kind).toBe("other");
    expect(r.containers.find((c) => c.name === "tugra_db_x")!.kind).toBe("db");
    expect(r.containers.find((c) => c.name === "tugra-hub-api-1")!.kind).toBe("system");
  });

  it("rejects a non-writer (servers:ops required)", async () => {
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException());
    await expect(make({ requirePermission }).list("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects when the agent is offline", async () => {
    const isOnline = jest.fn().mockReturnValue(false);
    await expect(make({ isOnline }).list("u1", "s1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
