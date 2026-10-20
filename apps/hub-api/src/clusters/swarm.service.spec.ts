import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { SwarmService } from "./swarm.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const TOKEN = "SWMTKN-1-supersecret";
const MGR_TOKEN = "SWMTKN-1-managersecret";

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
  managerTokenExit?: number; // `swarm join-token -q manager` exit
  promoteExit?: number; // `docker node promote` exit
  demoteExit?: number; // `docker node demote` exit
  drainExit?: number; // node-drain script exit (0 clean, 2 timeout)
  nodeRmExit?: number; // `docker node rm` exit
  nodeInspectOut?: string; // `docker node inspect` output (for status() live parsing)
  labelExit?: number; // `docker node update --label-*` exit
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
    if (command.includes("join-token -q manager")) {
      return { exitCode: opts.managerTokenExit ?? 0, output: opts.managerTokenExit ? "" : MGR_TOKEN };
    }
    if (command.includes("swarm init")) return { exitCode: 0, output: "" };
    if (command.includes("swarm join ")) return { exitCode: opts.joinExit?.[serverId] ?? 0, output: "joined" };
    if (command.includes("node promote")) return { exitCode: opts.promoteExit ?? 0, output: "" };
    if (command.includes("node demote")) return { exitCode: opts.demoteExit ?? 0, output: "" };
    if (command.includes("node update --availability drain")) {
      return { exitCode: opts.drainExit ?? 0, output: opts.drainExit === 2 ? "TUGRA_DRAIN: timeout" : "TUGRA_DRAIN: clean" };
    }
    if (command.includes("--label-add") || command.includes("--label-rm")) return { exitCode: opts.labelExit ?? 0, output: "" };
    if (command.includes("node rm")) return { exitCode: opts.nodeRmExit ?? 0, output: "" };
    if (command.includes("node inspect")) return { exitCode: 0, output: opts.nodeInspectOut ?? "" };
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
  apps?: object[]; // rows for replicaRiskWarning (name/replicas) and stripPlacementNamingNode (id/placement)
  otherOnline?: number; // server.count → other online swarm members
  ingressReplicas?: number; // cluster.ingressReplicas (for setIngressReplicas revert tests)
  agent?: AgentWsServer;
} = {}) {
  const cluster = {
    id: "c1",
    teamId: "t1",
    swarmStatus: opts.swarmStatus ?? "NONE",
    swarmManagerId: opts.swarmManagerId ?? null,
    swarmLastError: null,
    ingressReplicas: opts.ingressReplicas ?? 1,
  };
  const clusterUpdate = jest.fn().mockResolvedValue(cluster);
  const clusterUpdateMany = jest.fn().mockResolvedValue({ count: opts.casCount ?? 1 });
  const serverUpdate = jest.fn().mockResolvedValue({});
  const serverUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const appUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    cluster: {
      findUnique: jest.fn().mockResolvedValue(cluster),
      update: clusterUpdate,
      updateMany: clusterUpdateMany,
    },
    server: {
      findMany: jest.fn().mockResolvedValue(opts.members ?? []),
      findUnique: jest.fn().mockResolvedValue({ swarmError: "join failed: exit 1" }),
      update: serverUpdate,
      updateMany: serverUpdateMany,
      count: jest.fn().mockResolvedValue(opts.otherOnline ?? 0),
    },
    application: {
      count: jest.fn().mockResolvedValue(opts.appCount ?? 0),
      findMany: jest.fn().mockResolvedValue(opts.apps ?? []),
      update: appUpdate,
    },
  } as unknown as PrismaService;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamIds: jest.fn().mockResolvedValue(["t1"]),
  } as unknown as TeamAccessService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const agent = opts.agent ?? agentMock();
  const swarmProxy = {
    teardown: jest.fn().mockResolvedValue(true),
    ensure: jest.fn().mockResolvedValue(undefined),
    ingressInfo: jest.fn().mockResolvedValue({ replicas: 1, nodes: [{ id: "mgr", name: "mgr", ip: "1.1.1.1" }] }),
  } as unknown as import("./swarm-proxy.service").SwarmProxyService;
  const svc = new SwarmService(prisma, access, audit, agent, swarmProxy);
  return { svc, prisma, access, audit, agent, swarmProxy, clusterUpdate, clusterUpdateMany, serverUpdate, serverUpdateMany, appUpdate };
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

describe("SwarmService.joinNode", () => {
  const activeMembers = () => [
    member({ id: "mgr", swarmRole: "MANAGER", reportedIps: ["10.0.0.5"] }),
    member({ id: "w1", swarmRole: "WORKER" }),
    member({ id: "s2" }), // fresh: online, swarm-capable, not yet joined
  ];
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;

  it("rejects when the swarm is not ACTIVE (no CAS, no agent)", async () => {
    const { svc, agent, clusterUpdateMany } = make({ swarmStatus: "NONE", members: activeMembers() });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toBeInstanceOf(ConflictException);
    expect(sc(agent)).not.toHaveBeenCalled();
    expect(clusterUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a serverId that is not a member of the cluster", async () => {
    const { svc, agent } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers() });
    await expect(svc.joinNode("u1", "c1", { serverId: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("is idempotent: an already-joined target returns without CAS or agent contact", async () => {
    const { svc, agent, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers() });
    await svc.joinNode("u1", "c1", { serverId: "w1" }); // already WORKER
    expect(sc(agent)).not.toHaveBeenCalled();
    expect(clusterUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an offline target before the CAS", async () => {
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER" }), member({ id: "s2", status: "OFFLINE" })] });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toBeInstanceOf(BadRequestException);
    expect(clusterUpdateMany).not.toHaveBeenCalled();
  });

  it("requires the swarm capability on the target", async () => {
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER" }), member({ id: "s2", capabilities: ["deploy"] })] });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toThrow(/swarm.*capability/i);
  });

  it("throws when the manager is offline, before any CAS", async () => {
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER", status: "OFFLINE" }), member({ id: "s2" })] });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(clusterUpdateMany).not.toHaveBeenCalled();
  });

  it("409s when the ACTIVE→JOINING CAS is lost (no agent contact)", async () => {
    const { svc, agent } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers(), casCount: 0 });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toBeInstanceOf(ConflictException);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("happy path: joins ONLY the new node, rotates the token, → ACTIVE", async () => {
    const agent = agentMock();
    const { svc, clusterUpdateMany, serverUpdate, audit } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers(), agent });
    await svc.joinNode("u1", "c1", { serverId: "s2" });
    const calls = sc(agent).mock.calls;
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("join-token -q worker"))).toBe(true);
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("join-token --rotate -q worker"))).toBe(true);
    expect(calls.some((c) => c[0] === "s2" && (c[1] as string).includes("swarm join "))).toBe(true);
    expect(calls.some((c) => c[0] === "w1")).toBe(false); // the existing worker is never touched
    expect(serverUpdate).toHaveBeenCalledWith({ where: { id: "s2" }, data: expect.objectContaining({ swarmRole: "WORKER" }) });
    const term = (clusterUpdateMany as unknown as jest.Mock).mock.calls.find((c) => c[0].where?.swarmStatus === "JOINING" && c[0].data?.swarmStatus === "ACTIVE");
    // Success MUST clear any stale swarmLastError (else a prior failed attempt's banner persists on a healthy
    // swarm and masks a later real "manager offline").
    expect(term?.[0]).toMatchObject({ where: { id: "c1", swarmStatus: "JOINING" }, data: { swarmStatus: "ACTIVE", swarmLastError: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.join_node" }));
  });

  it("never lets the join token reach persisted state", async () => {
    const agent = agentMock();
    const { svc, serverUpdate, clusterUpdate, clusterUpdateMany, audit } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers(), agent });
    await svc.joinNode("u1", "c1", { serverId: "s2" });
    expect(allArgs(serverUpdate as unknown as jest.Mock)).not.toContain("SWMTKN");
    expect(allArgs(clusterUpdate as unknown as jest.Mock)).not.toContain("SWMTKN");
    expect(allArgs(clusterUpdateMany as unknown as jest.Mock)).not.toContain("SWMTKN");
    expect(allArgs(audit.log as unknown as jest.Mock)).not.toContain("SWMTKN");
  });

  it("a failed join reverts to ACTIVE (never DEGRADED) with a sanitized error", async () => {
    const agent = agentMock({ joinExit: { s2: 1 } });
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers(), agent });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const calls = (clusterUpdateMany as unknown as jest.Mock).mock.calls;
    expect(calls.some((c) => c[0].data?.swarmStatus === "DEGRADED")).toBe(false);
    const revert = calls.find((c) => c[0].where?.swarmStatus === "JOINING" && c[0].data?.swarmStatus === "ACTIVE");
    expect(revert?.[0].data).toEqual(expect.objectContaining({ swarmStatus: "ACTIVE", swarmLastError: expect.any(String) }));
  });

  it("a token-fetch failure aborts before touching the target and reverts to ACTIVE", async () => {
    const agent = agentMock({ tokenExit: 1 });
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: activeMembers(), agent });
    await expect(svc.joinNode("u1", "c1", { serverId: "s2" })).rejects.toThrow(/join token/i);
    expect(sc(agent).mock.calls.some((c) => c[0] === "s2" && (c[1] as string).includes("swarm join "))).toBe(false);
    const revert = (clusterUpdateMany as unknown as jest.Mock).mock.calls.find((c) => c[0].where?.swarmStatus === "JOINING" && c[0].data?.swarmStatus === "ACTIVE");
    expect(revert).toBeTruthy();
  });
});

describe("SwarmService.leaveNode", () => {
  const mgr = () => member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" });
  const worker = (over = {}) => member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1", ...over });
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;

  it("refuses when the swarm is not ACTIVE/DEGRADED (no agent contact)", async () => {
    const { svc, agent } = make({ swarmStatus: "NONE", members: [mgr(), worker()] });
    await expect(svc.leaveNode("u1", "c1", "w1")).rejects.toBeInstanceOf(ConflictException);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("404s when the serverId is not a member", async () => {
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()] });
    await expect(svc.leaveNode("u1", "c1", "nope")).rejects.toThrow(/not found/i);
  });

  it("400s when the target never joined the swarm (swarmRole null)", async () => {
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), member({ id: "s2" })] });
    await expect(svc.leaveNode("u1", "c1", "s2")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses removing a MANAGER directly, pointing at Demote first, no docker command", async () => {
    const { svc, agent } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()] });
    await expect(svc.leaveNode("u1", "c1", "mgr")).rejects.toThrow(/manager/i);
    await expect(svc.leaveNode("u1", "c1", "mgr")).rejects.toThrow(/demote/i);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("503s when the manager is offline", async () => {
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr", status: "OFFLINE" }), worker()] });
    await expect(svc.leaveNode("u1", "c1", "w1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("409s when the busy-marker CAS is lost, before any agent contact", async () => {
    const { svc, agent } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], casCount: 0 });
    await expect(svc.leaveNode("u1", "c1", "w1")).rejects.toBeInstanceOf(ConflictException);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  // The success cluster-restore is a CAS'd updateMany (FORMING→prior status), not a plain update, so a
  // concurrent dissolve() can't be clobbered. This helper finds that terminal restore call.
  const restoreCall = (cum: jest.Mock) => cum.mock.calls.find((c) => c[0].where?.swarmStatus === "FORMING" && c[0].data?.swarmStatus === "ACTIVE");

  it("happy path (ONLINE worker): drain → local leave → node rm, clears role+cluster, restores ACTIVE", async () => {
    const agent = agentMock();
    const { svc, serverUpdate, clusterUpdateMany, audit } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], agent });
    await svc.leaveNode("u1", "c1", "w1");
    const calls = sc(agent).mock.calls;
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("node update --availability drain"))).toBe(true);
    expect(calls.some((c) => c[0] === "w1" && (c[1] as string).includes("swarm leave"))).toBe(true);
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("node rm --force"))).toBe(true);
    expect(serverUpdate).toHaveBeenCalledWith({ where: { id: "w1" }, data: { swarmRole: null, swarmNodeId: null, swarmError: null, clusterId: null } });
    expect(restoreCall(clusterUpdateMany as unknown as jest.Mock)?.[0].data).toEqual({ swarmStatus: "ACTIVE", swarmLastError: null });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.leave_node" }));
  });

  it("OFFLINE worker: never dispatches to the dead node, still drains+removes, notes it", async () => {
    const agent = agentMock();
    const { svc, serverUpdate } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker({ status: "OFFLINE" })], agent });
    await svc.leaveNode("u1", "c1", "w1");
    const calls = sc(agent).mock.calls;
    expect(calls.some((c) => c[0] === "w1")).toBe(false); // never talk to the offline node
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("node rm --force"))).toBe(true);
    const w1Update = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "w1");
    expect(w1Update![0].data.swarmError).toMatch(/not attempted/i);
    expect(w1Update![0].data.swarmError).toMatch(/swarm leave --force/);
  });

  it("ONLINE worker whose swarm capability was revoked: skips local leave with a note, still removes", async () => {
    const agent = agentMock();
    const { svc, serverUpdate } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker({ capabilities: ["deploy"] })], agent });
    await svc.leaveNode("u1", "c1", "w1");
    const calls = sc(agent).mock.calls;
    expect(calls.some((c) => c[0] === "w1")).toBe(false); // no local leave attempted
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("node rm --force"))).toBe(true);
    const w1Update = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "w1");
    expect(w1Update![0].data.swarmError).toMatch(/not attempted/i);
  });

  it("drain timeout still proceeds and notes possible Pending tasks", async () => {
    const agent = agentMock({ drainExit: 2 });
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], agent });
    await svc.leaveNode("u1", "c1", "w1");
    expect(restoreCall(clusterUpdateMany as unknown as jest.Mock)?.[0].data.swarmLastError).toMatch(/Pending|vacate/i);
  });

  it("replica-risk is advisory: warns in swarmLastError but never blocks", async () => {
    const agent = agentMock();
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], apps: [{ name: "api", replicas: 3 }], otherOnline: 1, agent });
    await svc.leaveNode("u1", "c1", "w1");
    expect(sc(agent).mock.calls.some((c) => (c[1] as string).includes("node rm --force"))).toBe(true); // executed anyway
    const data = restoreCall(clusterUpdateMany as unknown as jest.Mock)?.[0].data;
    expect(data.swarmLastError).toMatch(/api/);
    expect(data.swarmLastError).toMatch(/under-replicated/i);
  });

  it("no warning + clean removal → swarmLastError null", async () => {
    const agent = agentMock();
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], apps: [], agent });
    await svc.leaveNode("u1", "c1", "w1");
    expect(restoreCall(clusterUpdateMany as unknown as jest.Mock)?.[0].data.swarmLastError).toBeNull();
  });

  it("node-rm failure throws and CAS-restores the prior status with a sanitized error", async () => {
    const agent = agentMock({ nodeRmExit: 1 });
    const { svc, clusterUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], agent });
    await expect(svc.leaveNode("u1", "c1", "w1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    const revert = (clusterUpdateMany as unknown as jest.Mock).mock.calls.find((c) => c[0].where?.swarmStatus === "FORMING" && c[0].data?.swarmStatus === "ACTIVE");
    expect(revert?.[0].data).toEqual(expect.objectContaining({ swarmStatus: "ACTIVE", swarmLastError: expect.any(String) }));
  });

  it("never persists raw docker output", async () => {
    const agent = agentMock({ drainExit: 2 });
    const { svc, serverUpdate, clusterUpdate, clusterUpdateMany, audit } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [mgr(), worker()], agent });
    await svc.leaveNode("u1", "c1", "w1");
    for (const fn of [serverUpdate, clusterUpdate, clusterUpdateMany, audit.log]) {
      expect(allArgs(fn as unknown as jest.Mock)).not.toContain("TUGRA_DRAIN");
    }
  });

  it("strips app placement pinned to the removed node (by hostname or node id) so it can't go unschedulable", async () => {
    const inspect = JSON.stringify({ ID: "node_w1", Description: { Hostname: "worker-3" }, Spec: { Role: "worker", Availability: "active", Labels: {} }, Status: { State: "ready" } });
    const agent = agentMock({ nodeInspectOut: inspect });
    const { svc, appUpdate } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [mgr(), worker()],
      apps: [{ id: "app1", name: "api", replicas: 1, placement: { constraints: [{ type: "hostname", op: "eq", value: "worker-3" }, { type: "role", op: "eq", value: "worker" }], spreadLabelKey: null } }],
      otherOnline: 5,
      agent,
    });
    await svc.leaveNode("u1", "c1", "w1");
    // the worker-3 hostname pin is stripped; the unrelated role rule survives
    expect(appUpdate).toHaveBeenCalledWith({ where: { id: "app1" }, data: { placement: { constraints: [{ type: "role", op: "eq", value: "worker" }], spreadLabelKey: null } } });
  });
});

describe("SwarmService status() live-parse + setNodeLabels", () => {
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;
  const inspectLine = JSON.stringify({ ID: "node_mgr", Description: { Hostname: "mgr-host" }, Spec: { Role: "manager", Availability: "active", Labels: { zone: "east" } }, Status: { State: "ready" } });

  it("status() parses labels/role/hostname/state from docker node inspect + threads swarmNodeId", async () => {
    const agent = agentMock({ nodeInspectOut: inspectLine });
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" })], agent });
    const view = await svc.status("u1", "c1");
    expect(view.live).toEqual([{ id: "node_mgr", hostname: "mgr-host", role: "manager", state: "ready", availability: "active", labels: { zone: "east" } }]);
    expect(view.nodes.find((n) => n.serverId === "mgr")?.swarmNodeId).toBe("node_mgr");
  });

  it("setNodeLabels dispatches a node update to the manager under swarm cap + audits", async () => {
    const agent = agentMock({ nodeInspectOut: inspectLine });
    const { svc, audit } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" })], agent });
    await svc.setNodeLabels("u1", "c1", "node_mgr", { add: { zone: "east" }, remove: [] });
    const call = sc(agent).mock.calls.find((c) => (c[1] as string).includes("--label-add"));
    expect(call?.[0]).toBe("mgr");
    expect(call?.[1] as string).toContain("--label-add 'zone=east'");
    expect(call?.[2]).toBe("swarm");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.node.labels" }));
  });

  it("setNodeLabels 400s when the swarm is not active", async () => {
    const { svc } = make({ swarmStatus: "NONE", members: [member({ id: "mgr", swarmRole: "MANAGER" })] });
    await expect(svc.setNodeLabels("u1", "c1", "node_mgr", { add: { a: "b" }, remove: [] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("setNodeLabels 503s when the manager is offline", async () => {
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER", status: "OFFLINE" })] });
    await expect(svc.setNodeLabels("u1", "c1", "node_mgr", { add: { a: "b" }, remove: [] })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("SwarmService.addManager", () => {
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;
  // 2 existing managers so adding a 3rd is an ODD (quorum-safe) count that skips the even-guard.
  const twoManagers = () => [
    member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr", reportedIps: ["10.0.0.5"] }),
    member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
  ];

  it("promotes an ONLINE worker via docker node promote dispatched to another online manager, sets MANAGER", async () => {
    const agent = agentMock();
    const { svc, serverUpdateMany, audit } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [...twoManagers(), member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1" })],
      agent,
    });
    await svc.addManager("u1", "c1", { serverId: "w1" });
    const promote = sc(agent).mock.calls.find((c) => (c[1] as string).includes("node promote"));
    expect(promote?.[0]).toBe("mgr"); // dispatched THROUGH an existing manager
    expect(promote?.[1] as string).toContain("node promote 'node_w1'");
    expect(serverUpdateMany).toHaveBeenCalledWith({ where: { id: "w1", clusterId: "c1" }, data: { swarmRole: "MANAGER", swarmError: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.addManager", meta: expect.objectContaining({ serverId: "w1", managerCount: 3 }) }));
  });

  it("joins a fresh member directly as manager: fetch manager token → swarm join → rotate manager token → MANAGER", async () => {
    const agent = agentMock();
    const { svc, serverUpdateMany } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [...twoManagers(), member({ id: "s3" })], // fresh: online, swarm-capable, not joined
      agent,
    });
    await svc.addManager("u1", "c1", { serverId: "s3" });
    const calls = sc(agent).mock.calls;
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("join-token -q manager"))).toBe(true);
    expect(calls.some((c) => c[0] === "s3" && (c[1] as string).includes("swarm join "))).toBe(true);
    expect(calls.some((c) => c[0] === "mgr" && (c[1] as string).includes("join-token --rotate -q manager"))).toBe(true);
    expect(serverUpdateMany).toHaveBeenCalledWith({ where: { id: "s3", clusterId: "c1" }, data: { swarmRole: "MANAGER", swarmNodeId: "node_s3", swarmError: null } });
  });

  it("is idempotent: an already-MANAGER target returns without any agent contact", async () => {
    const agent = agentMock();
    const { svc, serverUpdateMany } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: twoManagers(), agent });
    await svc.addManager("u1", "c1", { serverId: "m2" });
    expect(sc(agent)).not.toHaveBeenCalled();
    expect(serverUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a non-member / offline / no-swarm-capability target and a non-ACTIVE cluster, all BEFORE any agent call", async () => {
    // non-member
    let r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: twoManagers() });
    await expect(r.svc.addManager("u1", "c1", { serverId: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    expect(sc(r.agent)).not.toHaveBeenCalled();
    // offline target
    r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [...twoManagers(), member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1", status: "OFFLINE" })] });
    await expect(r.svc.addManager("u1", "c1", { serverId: "w1" })).rejects.toBeInstanceOf(BadRequestException);
    expect(sc(r.agent)).not.toHaveBeenCalled();
    // no swarm capability
    r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [...twoManagers(), member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1", capabilities: ["deploy"] })] });
    await expect(r.svc.addManager("u1", "c1", { serverId: "w1" })).rejects.toThrow(/swarm.*capability/i);
    expect(sc(r.agent)).not.toHaveBeenCalled();
    // non-ACTIVE/DEGRADED cluster
    r = make({ swarmStatus: "NONE", members: twoManagers() });
    await expect(r.svc.addManager("u1", "c1", { serverId: "m2" })).rejects.toBeInstanceOf(BadRequestException);
    expect(sc(r.agent)).not.toHaveBeenCalled();
  });

  it("refuses an even resulting manager count without acknowledgeEvenQuorum, succeeds with it set", async () => {
    // 1 existing manager + promote a worker → 2 (even) → refuse without ack.
    const oneMgr = () => [
      member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr", reportedIps: ["10.0.0.5"] }),
      member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1" }),
    ];
    let r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: oneMgr() });
    await expect(r.svc.addManager("u1", "c1", { serverId: "w1" })).rejects.toThrow(/even manager count/i);
    expect(sc(r.agent)).not.toHaveBeenCalled();
    // With acknowledgeEvenQuorum the same promote proceeds.
    const agent = agentMock();
    r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: oneMgr(), agent });
    await r.svc.addManager("u1", "c1", { serverId: "w1", acknowledgeEvenQuorum: true });
    expect(sc(agent).mock.calls.some((c) => (c[1] as string).includes("node promote"))).toBe(true);
    expect(r.serverUpdateMany).toHaveBeenCalledWith({ where: { id: "w1", clusterId: "c1" }, data: { swarmRole: "MANAGER", swarmError: null } });
  });

  it("503s when no existing manager is ONLINE to dispatch through", async () => {
    const agent = agentMock();
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [
        member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr", status: "OFFLINE" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2", status: "OFFLINE" }),
        member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1" }),
      ],
      agent,
    });
    await expect(svc.addManager("u1", "c1", { serverId: "w1" })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("a failed promote leaves swarmRole untouched and records a SANITIZED error (never raw output)", async () => {
    const agent = agentMock({ promoteExit: 1 });
    const { svc, serverUpdateMany } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [...twoManagers(), member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1" })],
      agent,
    });
    await expect(svc.addManager("u1", "c1", { serverId: "w1" })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const w1 = (serverUpdateMany as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "w1");
    expect(w1![0].data.swarmError).toEqual(expect.any(String));
    expect(w1![0].data.swarmRole).toBeUndefined(); // role NOT flipped on failure
    // no success write ever set MANAGER for w1
    expect((serverUpdateMany as unknown as jest.Mock).mock.calls.some((c) => c[0].where.id === "w1" && c[0].data.swarmRole === "MANAGER")).toBe(false);
  });

  it("NEVER lets the manager join-token reach the DB or audit log", async () => {
    const agent = agentMock();
    const { svc, serverUpdate, serverUpdateMany, clusterUpdate, clusterUpdateMany, audit } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [...twoManagers(), member({ id: "s3" })],
      agent,
    });
    await svc.addManager("u1", "c1", { serverId: "s3" });
    for (const fn of [serverUpdate, serverUpdateMany, clusterUpdate, clusterUpdateMany, audit.log]) {
      expect(allArgs(fn as unknown as jest.Mock)).not.toContain("SWMTKN");
    }
  });

  it("join-as-manager persists swarmRole=MANAGER even if the post-join node-id lookup fails (F2)", async () => {
    // The target genuinely joins as a manager (swarm join exit 0), but the FOLLOW-UP `docker info` (node-id
    // lookup) throws (WS timeout right after a Raft membership change). The role MUST still be persisted, with
    // swarmNodeId left null — otherwise the DB permanently understates a real Raft manager.
    let s3InfoCalls = 0;
    const sendCommand = jest.fn(async (serverId: string, command: string) => {
      if (command.includes("docker info")) {
        if (serverId === "s3") {
          s3InfoCalls++;
          if (s3InfoCalls === 1) return { exitCode: 0, output: JSON.stringify({ LocalNodeState: "inactive", NodeID: null }) }; // preflight OK
          throw new Error("agent ws timeout"); // post-join node-id lookup fails
        }
        return { exitCode: 0, output: JSON.stringify({ LocalNodeState: "inactive", NodeID: `node_${serverId}` }) };
      }
      if (command.includes("join-token --rotate")) return { exitCode: 0, output: "SWMTKN-ROTATED" };
      if (command.includes("join-token -q manager")) return { exitCode: 0, output: MGR_TOKEN };
      if (command.includes("swarm join ")) return { exitCode: 0, output: "joined" };
      return { exitCode: 0, output: "" };
    });
    const agent = { sendCommand } as unknown as AgentWsServer;
    const { svc, serverUpdateMany, audit } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [...twoManagers(), member({ id: "s3" })], agent });
    await svc.addManager("u1", "c1", { serverId: "s3" });
    expect(serverUpdateMany).toHaveBeenCalledWith({ where: { id: "s3", clusterId: "c1" }, data: { swarmRole: "MANAGER", swarmNodeId: null, swarmError: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.addManager" }));
  });

  it("surfaces a ConflictException when the target left the cluster mid-flight (markMember no-op) (F3)", async () => {
    const agent = agentMock();
    const r = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [...twoManagers(), member({ id: "w1", swarmRole: "WORKER", swarmNodeId: "node_w1" })],
      agent,
    });
    (r.serverUpdateMany as unknown as jest.Mock).mockResolvedValue({ count: 0 }); // concurrent setServers moved the row away
    await expect(r.svc.addManager("u1", "c1", { serverId: "w1" })).rejects.toBeInstanceOf(ConflictException);
    // the op must NOT be audited as having happened
    expect((r.audit.log as unknown as jest.Mock)).not.toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.addManager" }));
  });
});

describe("SwarmService.removeManager", () => {
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;

  it("demotes a non-primary MANAGER via docker node demote dispatched to a DIFFERENT online manager, sets WORKER", async () => {
    const agent = agentMock();
    const { svc, serverUpdateMany, audit } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [
        member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
      ],
      agent,
    });
    await svc.removeManager("u1", "c1", { serverId: "m2" });
    const demote = sc(agent).mock.calls.find((c) => (c[1] as string).includes("node demote"));
    expect(demote?.[0]).toBe("mgr"); // a DIFFERENT manager runs the demotion
    expect(demote?.[1] as string).toContain("node demote 'node_m2'");
    expect(serverUpdateMany).toHaveBeenCalledWith({ where: { id: "m2", clusterId: "c1" }, data: { swarmRole: "WORKER", swarmError: null } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.removeManager", meta: expect.objectContaining({ serverId: "m2", managerCount: 1 }) }));
  });

  it("is idempotent when the target is not currently a MANAGER (no agent contact)", async () => {
    const agent = agentMock();
    const { svc, serverUpdateMany } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [member({ id: "mgr", swarmRole: "MANAGER" }), member({ id: "w1", swarmRole: "WORKER" })],
      agent,
    });
    await svc.removeManager("u1", "c1", { serverId: "w1" });
    expect(sc(agent)).not.toHaveBeenCalled();
    expect(serverUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to demote the primary manager (cluster.swarmManagerId)", async () => {
    const agent = agentMock();
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" }), member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" })],
      agent,
    });
    await expect(svc.removeManager("u1", "c1", { serverId: "mgr" })).rejects.toThrow(/primary manager/i);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("refuses to demote the only remaining manager", async () => {
    const agent = agentMock();
    // swarmManagerId=null (no recorded primary) so we reach the only-manager guard, not the primary guard.
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: null,
      members: [member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" })],
      agent,
    });
    await expect(svc.removeManager("u1", "c1", { serverId: "m2" })).rejects.toThrow(/only manager/i);
    expect(sc(agent)).not.toHaveBeenCalled();
  });

  it("refuses an even resulting count without acknowledgeEvenQuorum, succeeds with it set", async () => {
    const threeManagers = () => [
      member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" }),
      member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
      member({ id: "m3", swarmRole: "MANAGER", swarmNodeId: "node_m3" }),
    ];
    let r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: threeManagers() });
    await expect(r.svc.removeManager("u1", "c1", { serverId: "m2" })).rejects.toThrow(/even manager count/i);
    expect(sc(r.agent)).not.toHaveBeenCalled();
    const agent = agentMock();
    r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: threeManagers(), agent });
    await r.svc.removeManager("u1", "c1", { serverId: "m2", acknowledgeEvenQuorum: true });
    expect(sc(agent).mock.calls.some((c) => (c[1] as string).includes("node demote 'node_m2'"))).toBe(true);
    expect(r.serverUpdateMany).toHaveBeenCalledWith({ where: { id: "m2", clusterId: "c1" }, data: { swarmRole: "WORKER", swarmError: null } });
  });

  it("falls back to self-dispatch when no OTHER manager is online", async () => {
    const agent = agentMock();
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [
        member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr", status: "OFFLINE" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }), // only online manager = the target
      ],
      agent,
    });
    await svc.removeManager("u1", "c1", { serverId: "m2" });
    const demote = sc(agent).mock.calls.find((c) => (c[1] as string).includes("node demote"));
    expect(demote?.[0]).toBe("m2"); // self-demote (Docker supports it) when no other manager is online
  });

  it("audit.log records cluster.swarm.removeManager and never a token", async () => {
    const agent = agentMock();
    const { svc, audit } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" }), member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" })],
      agent,
    });
    await svc.removeManager("u1", "c1", { serverId: "m2" });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.removeManager" }));
    expect(allArgs(audit.log as unknown as jest.Mock)).not.toContain("SWMTKN");
  });
});

describe("SwarmService quorum + status failover", () => {
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;
  const nodeLine = (id: string, role: string, state: string) =>
    JSON.stringify({ ID: id, Description: { Hostname: id }, Spec: { Role: role, Availability: "active", Labels: {} }, Status: { State: state } });
  const readyLine = (id: string, role: string) => nodeLine(id, role, "ready");

  it("quorum is null when swarmStatus is NONE", async () => {
    const { svc } = make({ swarmStatus: "NONE", members: [] });
    const view = await svc.status("u1", "c1");
    expect(view.quorum).toBeNull();
  });

  it("reports hasQuorum true for 1/1 online (from live docker node inspect)", async () => {
    const agent = agentMock({ nodeInspectOut: readyLine("node_mgr", "manager") });
    const { svc } = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr" })], agent });
    const view = await svc.status("u1", "c1");
    expect(view.quorum).toEqual({ managers: 1, managersOnline: 1, hasQuorum: true });
  });

  it("computes quorum from LIVE managers: false for 1/3 ready, true for 2/3 and 3/3 (Raft majority = floor(N/2)+1)", async () => {
    const members3 = () => [
      member({ id: "m1", swarmRole: "MANAGER", swarmNodeId: "node_m1" }),
      member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
      member({ id: "m3", swarmRole: "MANAGER", swarmNodeId: "node_m3" }),
    ];
    const mk = (readyCount: number) =>
      make({
        swarmStatus: "ACTIVE", swarmManagerId: "m1", members: members3(),
        agent: agentMock({
          nodeInspectOut: [
            nodeLine("node_m1", "manager", readyCount >= 1 ? "ready" : "down"),
            nodeLine("node_m2", "manager", readyCount >= 2 ? "ready" : "down"),
            nodeLine("node_m3", "manager", readyCount >= 3 ? "ready" : "down"),
          ].join("\n"),
        }),
      });
    expect((await mk(1).svc.status("u1", "c1")).quorum).toEqual({ managers: 3, managersOnline: 1, hasQuorum: false });
    expect((await mk(2).svc.status("u1", "c1")).quorum).toEqual({ managers: 3, managersOnline: 2, hasQuorum: true });
    expect((await mk(3).svc.status("u1", "c1")).quorum).toEqual({ managers: 3, managersOnline: 3, hasQuorum: true });
  });

  it("falls back to the cached (DB-derived) quorum when no live data is available", async () => {
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "m1",
      members: [
        member({ id: "m1", swarmRole: "MANAGER", swarmNodeId: "node_m1" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2", status: "OFFLINE" }),
        member({ id: "m3", swarmRole: "MANAGER", swarmNodeId: "node_m3", status: "OFFLINE" }),
      ],
      agent: agentMock({ nodeInspectOut: "" }), // empty inspect → live[] empty → cached quorum
    });
    expect((await svc.status("u1", "c1")).quorum).toEqual({ managers: 3, managersOnline: 1, hasQuorum: false });
  });

  it("does NOT count a ghost dead-manager row from a prior incarnation: live-only managers drive quorum (F1)", async () => {
    // DB still carries m_ghost as swarmRole=MANAGER (dissolve()'s abandon path keeps it), but the freshly
    // re-formed swarm's live inspect only knows the real manager m1 → quorum must be healthy 1/1, not 1/2. This
    // is the fix: the scary "Quorum lost" signal must NOT fire because of a stale prior-incarnation row.
    // (The pre-existing readyCount<joinedCount self-heal may still flag the un-cleared ghost as a generic
    // DEGRADED anomaly worth the operator's attention — that behavior predates this change and is out of scope.)
    const inspect = readyLine("node_m1", "manager");
    const agent = agentMock({ nodeInspectOut: inspect });
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "m1",
      members: [
        member({ id: "m1", swarmRole: "MANAGER", swarmNodeId: "node_m1" }),
        member({ id: "m_ghost", swarmRole: "MANAGER", swarmNodeId: "node_ghost_old", status: "OFFLINE" }),
      ],
      agent,
    });
    const view = await svc.status("u1", "c1");
    expect(view.quorum).toEqual({ managers: 1, managersOnline: 1, hasQuorum: true });
  });

  it("status() downgrades ACTIVE→DEGRADED when the LIVE manager quorum is lost", async () => {
    // 1 of 3 managers ready in the live Raft view → quorum lost → self-heal downgrades + persists DEGRADED.
    const inspect = [nodeLine("node_m1", "manager", "ready"), nodeLine("node_m2", "manager", "down"), nodeLine("node_m3", "manager", "down")].join("\n");
    const agent = agentMock({ nodeInspectOut: inspect });
    const { svc, clusterUpdate } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "m1",
      members: [
        member({ id: "m1", swarmRole: "MANAGER", swarmNodeId: "node_m1" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
        member({ id: "m3", swarmRole: "MANAGER", swarmNodeId: "node_m3" }),
      ],
      agent,
    });
    const view = await svc.status("u1", "c1");
    expect(view.swarmStatus).toBe("DEGRADED");
    expect(view.quorum).toEqual({ managers: 3, managersOnline: 1, hasQuorum: false });
    expect(clusterUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { swarmStatus: "DEGRADED" } });
  });

  it("status() fails over: primary OFFLINE but a secondary manager ONLINE → dispatches node inspect to the secondary and returns live data", async () => {
    const agent = agentMock({ nodeInspectOut: readyLine("node_m2", "manager") });
    const { svc } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "mgr",
      members: [
        member({ id: "mgr", swarmRole: "MANAGER", swarmNodeId: "node_mgr", status: "OFFLINE" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
      ],
      agent,
    });
    const view = await svc.status("u1", "c1");
    const inspect = sc(agent).mock.calls.find((c) => (c[1] as string).includes("node inspect"));
    expect(inspect?.[0]).toBe("m2"); // dispatched to the online backup, not the offline primary
    expect(view.live?.length).toBeGreaterThan(0);
  });
});

describe("SwarmService ingress HA", () => {
  it("getIngress: read-gated (non-member rejected), then delegates to swarmProxy.ingressInfo", async () => {
    const r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER" })] });
    const out = await r.svc.getIngress("u1", "c1");
    expect((r.swarmProxy.ingressInfo as unknown as jest.Mock)).toHaveBeenCalledWith("c1");
    expect(out).toEqual({ replicas: 1, nodes: [{ id: "mgr", name: "mgr", ip: "1.1.1.1" }] });
    // non-member → requireRead throws before any delegation
    const r2 = make({ swarmStatus: "ACTIVE", members: [] });
    (r2.access.teamIds as unknown as jest.Mock).mockResolvedValue([]);
    await expect(r2.svc.getIngress("u1", "c1")).rejects.toBeInstanceOf(NotFoundException);
    expect((r2.swarmProxy.ingressInfo as unknown as jest.Mock)).not.toHaveBeenCalled();
  });

  it("setIngressReplicas: write-gated, persists the column, triggers ensure() only when ACTIVE/DEGRADED", async () => {
    // ACTIVE → persists + ensure()
    const r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER" })] });
    await r.svc.setIngressReplicas("u1", "c1", 2);
    expect(r.clusterUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ingressReplicas: 2 } });
    expect((r.swarmProxy.ensure as unknown as jest.Mock)).toHaveBeenCalledWith("c1");
    expect(r.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.ingress_replicas", meta: { replicas: 2 } }));
    // NONE → persists but does NOT reconcile (no swarm up to reconcile)
    const r2 = make({ swarmStatus: "NONE", members: [] });
    await r2.svc.setIngressReplicas("u1", "c1", 3);
    expect(r2.clusterUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ingressReplicas: 3 } });
    expect((r2.swarmProxy.ensure as unknown as jest.Mock)).not.toHaveBeenCalled();
  });

  it("setIngressReplicas: an ensure() failure REVERTS the persisted value and rethrows (no misleading success)", async () => {
    const r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER" })] });
    (r.swarmProxy.ensure as unknown as jest.Mock).mockRejectedValue(new Error("ingress HA (2+ replicas) requires DNS-01"));
    await expect(r.svc.setIngressReplicas("u1", "c1", 2)).rejects.toThrow(/DNS-01/);
    // first write set 2, then it is reverted to the prior value (1 from the loadCluster mock's ingressReplicas)
    expect(r.clusterUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ingressReplicas: 2 } });
    expect(r.clusterUpdate).toHaveBeenLastCalledWith({ where: { id: "c1" }, data: { ingressReplicas: 1 } });
    // never audits a change that didn't converge
    expect(r.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "cluster.swarm.ingress_replicas" }));
  });

  it("setIngressReplicas: clamps out-of-range values (defence-in-depth beyond the DTO)", async () => {
    const r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [member({ id: "mgr", swarmRole: "MANAGER" })] });
    await r.svc.setIngressReplicas("u1", "c1", 9);
    expect(r.clusterUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ingressReplicas: 3 } }); // capped at 3
  });

  it("setIngressReplicas: non-permitted user rejected before any write", async () => {
    const r = make({ swarmStatus: "ACTIVE", swarmManagerId: "mgr", members: [] });
    (r.access.requirePermission as unknown as jest.Mock).mockRejectedValue(new Error("forbidden"));
    await expect(r.svc.setIngressReplicas("u1", "c1", 2)).rejects.toThrow();
    expect(r.clusterUpdate).not.toHaveBeenCalled();
  });
});

describe("SwarmService.dissolve multi-manager", () => {
  const sc = (agent: AgentWsServer) => (agent as unknown as { sendCommand: jest.Mock }).sendCommand;

  it("two online managers: teardown dispatched once, then BOTH leave --force", async () => {
    const agent = agentMock();
    const { svc, swarmProxy, serverUpdate } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "m1",
      members: [member({ id: "m1", swarmRole: "MANAGER", swarmNodeId: "node_m1" }), member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" })],
      agent,
    });
    await svc.dissolve("u1", "c1");
    expect((swarmProxy.teardown as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((swarmProxy.teardown as unknown as jest.Mock)).toHaveBeenCalledWith("m1", "c1"); // via the first online manager
    expect(sc(agent).mock.calls.some((c) => c[0] === "m1" && (c[1] as string).includes("swarm leave --force"))).toBe(true);
    expect(sc(agent).mock.calls.some((c) => c[0] === "m2" && (c[1] as string).includes("swarm leave --force"))).toBe(true);
    // both managers get their role cleared
    expect(serverUpdate).toHaveBeenCalledWith({ where: { id: "m1" }, data: expect.objectContaining({ swarmRole: null }) });
    expect(serverUpdate).toHaveBeenCalledWith({ where: { id: "m2" }, data: expect.objectContaining({ swarmRole: null }) });
  });

  it("primary OFFLINE + secondary ONLINE: teardown STILL runs (via the secondary); the offline primary keeps its role and gets the live-HTTPS marker", async () => {
    const agent = agentMock();
    const { svc, swarmProxy, serverUpdate } = make({
      swarmStatus: "ACTIVE", swarmManagerId: "m1",
      members: [
        member({ id: "m1", swarmRole: "MANAGER", swarmNodeId: "node_m1", status: "OFFLINE" }),
        member({ id: "m2", swarmRole: "MANAGER", swarmNodeId: "node_m2" }),
      ],
      agent,
    });
    await svc.dissolve("u1", "c1");
    expect((swarmProxy.teardown as unknown as jest.Mock)).toHaveBeenCalledWith("m2", "c1"); // dispatched via the online secondary
    const m1 = (serverUpdate as unknown as jest.Mock).mock.calls.find((c) => c[0].where.id === "m1");
    expect(m1![0].data.swarmError).toMatch(/live HTTPS/i);
    expect(m1![0].data.swarmRole).toBeUndefined(); // dead primary keeps its role for the next Form's preflight
  });
});
