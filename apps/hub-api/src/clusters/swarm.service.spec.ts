import { BadRequestException, ConflictException } from "@nestjs/common";
import { SwarmService } from "./swarm.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const TOKEN = "SWMTKN-1-supersecret";

function member(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    name: "s1",
    status: "ONLINE",
    publicIp: "1.2.3.4",
    reportedIps: ["10.0.0.5"],
    capabilities: ["swarm"],
    swarmRole: null as string | null,
    swarmNodeId: null as string | null,
    swarmError: null as string | null,
    ...over,
  };
}

/** Scriptable agent: responds by inspecting the command string + per-server state. */
function agentMock(opts: {
  infoState?: Record<string, string>; // serverId → LocalNodeState ("inactive"|"active")
  joinExit?: Record<string, number>; // worker serverId → join exit code
  tokenExit?: number;
} = {}) {
  const sendCommand = jest.fn(async (serverId: string, command: string) => {
    if (command.includes("docker info")) {
      const state = opts.infoState?.[serverId] ?? "inactive";
      return { exitCode: 0, output: JSON.stringify({ LocalNodeState: state, NodeID: `node_${serverId}` }) };
    }
    if (command.includes("join-token --rotate")) return { exitCode: 0, output: "SWMTKN-ROTATED" };
    if (command.includes("join-token -q worker")) {
      return { exitCode: opts.tokenExit ?? 0, output: opts.tokenExit ? "" : TOKEN };
    }
    if (command.includes("swarm init")) return { exitCode: 0, output: "" };
    if (command.includes("swarm join ")) return { exitCode: opts.joinExit?.[serverId] ?? 0, output: "joined" };
    if (command.includes("node ls")) return { exitCode: 0, output: "" };
    if (command.includes("swarm leave")) return { exitCode: 0, output: "" };
    return { exitCode: 0, output: "" };
  });
  return { sendCommand } as unknown as AgentWsServer;
}

function make(opts: {
  members?: ReturnType<typeof member>[];
  swarmStatus?: string;
  swarmManagerId?: string | null;
  casCount?: number;
  appCount?: number;
  agent?: AgentWsServer;
} = {}) {
  const cluster = {
    id: "c1",
    teamId: "t1",
    swarmStatus: opts.swarmStatus ?? "NONE",
    swarmManagerId: opts.swarmManagerId ?? null,
    swarmLastError: null,
  };
  const clusterUpdate = jest.fn().mockResolvedValue(cluster);
  const clusterUpdateMany = jest.fn().mockResolvedValue({ count: opts.casCount ?? 1 });
  const serverUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    cluster: {
      findUnique: jest.fn().mockResolvedValue(cluster),
      update: clusterUpdate,
      updateMany: clusterUpdateMany,
    },
    server: {
      findMany: jest.fn().mockResolvedValue(opts.members ?? []),
      update: serverUpdate,
    },
    application: { count: jest.fn().mockResolvedValue(opts.appCount ?? 0) },
  } as unknown as PrismaService;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamIds: jest.fn().mockResolvedValue(["t1"]),
  } as unknown as TeamAccessService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const agent = opts.agent ?? agentMock();
  const swarmProxy = { teardown: jest.fn().mockResolvedValue(true) } as unknown as import("./swarm-proxy.service").SwarmProxyService;
  const svc = new SwarmService(prisma, access, audit, agent, swarmProxy);
  return { svc, prisma, access, audit, agent, swarmProxy, clusterUpdate, clusterUpdateMany, serverUpdate };
}

/** Every arg passed to a jest.fn, flattened to a string — for leak assertions. */
function allArgs(fn: jest.Mock): string {
  return fn.mock.calls.map((c) => JSON.stringify(c)).join("|");
}

describe("SwarmService.form", () => {
  it("rejects a manager that is not a member of THIS cluster and never touches an agent", async () => {
    const { svc, agent, clusterUpdateMany } = make({ members: [member({ id: "other" })] });
    await expect(svc.form("u1", "c1", { managerServerId: "mgr" })).rejects.toBeInstanceOf(BadRequestException);
    expect((agent as unknown as { sendCommand: jest.Mock }).sendCommand).not.toHaveBeenCalled();
    expect(clusterUpdateMany).not.toHaveBeenCalled(); // no CAS before validation passes
  });

  it("rejects an offline manager before the concurrency CAS (no partial writes)", async () => {
    const { svc, agent, clusterUpdateMany } = make({ members: [member({ id: "mgr", status: "OFFLINE" })] });
    await expect(svc.form("u1", "c1", { managerServerId: "mgr" })).rejects.toBeInstanceOf(BadRequestException);
    expect((agent as unknown as { sendCommand: jest.Mock }).sendCommand).not.toHaveBeenCalled();
    expect(clusterUpdateMany).not.toHaveBeenCalled();
  });

  it("requires the swarm capability on the manager", async () => {
    const { svc } = make({ members: [member({ id: "mgr", capabilities: ["deploy"] })] });
    await expect(svc.form("u1", "c1", { managerServerId: "mgr" })).rejects.toThrow(/swarm.*capability/i);
  });

  it("409s when a concurrent op already holds the cluster (CAS lost)", async () => {
    const { svc, agent } = make({ members: [member({ id: "mgr" })], casCount: 0 });
    await expect(svc.form("u1", "c1", { managerServerId: "mgr" })).rejects.toBeInstanceOf(ConflictException);
    expect((agent as unknown as { sendCommand: jest.Mock }).sendCommand).not.toHaveBeenCalled();
  });

  it("happy path: inits the manager on its private IP, joins the worker, rotates the token, → ACTIVE", async () => {
    const agent = agentMock();
    const { svc, clusterUpdateMany, serverUpdate, audit } = make({
      members: [member({ id: "mgr", reportedIps: ["10.0.0.5"] }), member({ id: "w1" })],
      agent,
    });
    await svc.form("u1", "c1", { managerServerId: "mgr" });
    const cmds = (agent as unknown as { sendCommand: jest.Mock }).sendCommand.mock.calls.map((c) => c[1] as string);
    expect(cmds.some((c) => c.includes("swarm init") && c.includes("--advertise-addr '10.0.0.5'"))).toBe(true);
    expect(cmds.some((c) => c.includes("swarm join ") && c.includes("10.0.0.5:2377"))).toBe(true);
    expect(cmds.some((c) => c.includes("join-token --rotate -q worker"))).toBe(true);
    expect(serverUpdate).toHaveBeenCalledWith({ where: { id: "mgr" }, data: expect.objectContaining({ swarmRole: "MANAGER" }) });
    expect(serverUpdate).toHaveBeenCalledWith({ where: { id: "w1" }, data: expect.objectContaining({ swarmRole: "WORKER" }) });
    // The terminal commit is CAS-guarded (only overwrites while we still hold FORMING).
    const term = (clusterUpdateMany as unknown as jest.Mock).mock.calls.find((c) => c[0].data?.swarmStatus === "ACTIVE");
    expect(term?.[0]).toMatchObject({ where: { id: "c1", swarmStatus: "FORMING" }, data: expect.objectContaining({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", swarmLastError: null }) });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.form" }));
  });

  it("NEVER lets the join token reach the DB, audit log, or any persisted field", async () => {
    const agent = agentMock();
    const { svc, clusterUpdate, clusterUpdateMany, serverUpdate, audit } = make({
      members: [member({ id: "mgr" }), member({ id: "w1" })],
      agent,
    });
    await svc.form("u1", "c1", { managerServerId: "mgr" });
    expect(allArgs(serverUpdate as unknown as jest.Mock)).not.toContain("SWMTKN");
    expect(allArgs(clusterUpdate as unknown as jest.Mock)).not.toContain("SWMTKN");
    expect(allArgs(clusterUpdateMany as unknown as jest.Mock)).not.toContain("SWMTKN");
    expect(allArgs(audit.log as unknown as jest.Mock)).not.toContain("SWMTKN");
  });

  it("partial failure → DEGRADED; the failed worker gets a sanitized error and NO role", async () => {
    const agent = agentMock({ joinExit: { w1: 1 } });
    const { svc, clusterUpdateMany, serverUpdate } = make({
      members: [member({ id: "mgr" }), member({ id: "w1" })],
      agent,
    });
    await svc.form("u1", "c1", { managerServerId: "mgr" });
    expect((clusterUpdateMany as unknown as jest.Mock).mock.calls.some((c) => c[0].data?.swarmStatus === "DEGRADED")).toBe(true);
    const w1Call = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "w1");
    expect(w1Call![0].data).toEqual({ swarmError: expect.stringContaining("join failed") });
    expect(w1Call![0].data.swarmRole).toBeUndefined();
  });

  it("excludes a worker already in a foreign swarm (no join issued) → DEGRADED", async () => {
    const agent = agentMock({ infoState: { w1: "active" } });
    const { svc, clusterUpdateMany, serverUpdate } = make({
      members: [member({ id: "mgr" }), member({ id: "w1" })],
      agent,
    });
    await svc.form("u1", "c1", { managerServerId: "mgr" });
    const cmds = (agent as unknown as { sendCommand: jest.Mock }).sendCommand.mock.calls
      .filter((c) => c[0] === "w1")
      .map((c) => c[1] as string);
    expect(cmds.some((c) => c.includes("swarm join "))).toBe(false);
    const w1Call = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "w1");
    expect(w1Call![0].data).toEqual({ swarmError: "already in a swarm" });
    expect((clusterUpdateMany as unknown as jest.Mock).mock.calls.some((c) => c[0].data?.swarmStatus === "DEGRADED")).toBe(true);
  });

  it("idempotent retry on DEGRADED: skips init and does not re-join an already-joined worker", async () => {
    const agent = agentMock();
    const { svc } = make({
      swarmStatus: "DEGRADED",
      swarmManagerId: "mgr", // the cluster still records mgr as its manager (a real DEGRADED state)
      members: [
        member({ id: "mgr", swarmRole: "MANAGER" }),
        member({ id: "w1", swarmRole: "WORKER" }), // already joined
        member({ id: "w2" }), // needs joining
      ],
      agent,
    });
    await svc.form("u1", "c1", { managerServerId: "mgr" });
    const cmds = (agent as unknown as { sendCommand: jest.Mock }).sendCommand.mock.calls;
    expect(cmds.some((c) => (c[1] as string).includes("swarm init"))).toBe(false); // manager already up
    expect(cmds.some((c) => c[0] === "w1" && (c[1] as string).includes("swarm join "))).toBe(false); // not re-joined
    expect(cmds.some((c) => c[0] === "w2" && (c[1] as string).includes("swarm join "))).toBe(true);
  });

  it("refuses a manager with a STALE MANAGER role the cluster no longer records (abandon-path safeguard)", async () => {
    // Fresh (NONE) cluster, swarmManagerId=null, but the chosen server still carries a leftover MANAGER role
    // from a previously-abandoned swarm whose daemon is still active. managerReady must be false → the
    // foreign-swarm preflight runs and refuses, instead of silently reusing the old swarm.
    const agent = agentMock({ infoState: { mgr: "active" } });
    const { svc } = make({
      swarmStatus: "NONE",
      swarmManagerId: null,
      members: [member({ id: "mgr", swarmRole: "MANAGER" })],
      agent,
    });
    await expect(svc.form("u1", "c1", { managerServerId: "mgr" })).rejects.toBeInstanceOf(ConflictException);
    expect((agent as unknown as { sendCommand: jest.Mock }).sendCommand.mock.calls.some((c) => (c[1] as string).includes("swarm init"))).toBe(false);
  });
});

describe("SwarmService.dissolve", () => {
  it("dead worker: teardown still completes, worker gets a marker, cluster → NONE (abandoned)", async () => {
    const { svc, clusterUpdate, serverUpdate } = make({
      swarmStatus: "ACTIVE",
      swarmManagerId: "mgr",
      members: [member({ id: "mgr", swarmRole: "MANAGER" }), member({ id: "w1", swarmRole: "WORKER", status: "OFFLINE" })],
    });
    await svc.dissolve("u1", "c1");
    const w1Call = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "w1");
    expect(w1Call![0].data.swarmError).toMatch(/not reachable/);
    expect(clusterUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({ swarmStatus: "NONE", swarmManagerId: null, swarmLastError: expect.stringContaining("could not be cleanly removed") }),
    });
  });

  it("dead manager (abandon path): cluster → NONE but the manager KEEPS its role + gets a marker", async () => {
    const { svc, clusterUpdate, serverUpdate } = make({
      swarmStatus: "ACTIVE",
      swarmManagerId: "mgr",
      members: [member({ id: "mgr", swarmRole: "MANAGER", status: "OFFLINE" })],
    });
    await svc.dissolve("u1", "c1");
    const mgrCall = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "mgr");
    expect(mgrCall![0].data).toEqual({ swarmError: expect.stringContaining("manager unreachable") });
    expect(mgrCall![0].data.swarmRole).toBeUndefined(); // role preserved, not cleared
    expect(clusterUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: expect.objectContaining({ swarmStatus: "NONE", swarmManagerId: null }) });
  });

  it("is idempotent when there is no swarm (NONE)", async () => {
    const { svc, clusterUpdateMany } = make({ swarmStatus: "NONE", members: [] });
    await svc.dissolve("u1", "c1");
    expect(clusterUpdateMany).not.toHaveBeenCalled(); // returned before the CAS
  });

  it("refuses to dissolve while apps are still deployed to the cluster's swarm (would strand live services)", async () => {
    const { svc, clusterUpdateMany } = make({
      swarmStatus: "ACTIVE",
      swarmManagerId: "mgr",
      members: [member({ id: "mgr", swarmRole: "MANAGER" })],
      appCount: 2,
    });
    await expect(svc.dissolve("u1", "c1")).rejects.toBeInstanceOf(ConflictException);
    expect(clusterUpdateMany).not.toHaveBeenCalled(); // blocked before the DISSOLVING CAS
  });
});
