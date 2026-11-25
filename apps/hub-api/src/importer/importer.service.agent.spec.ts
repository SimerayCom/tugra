import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { HostMatchVerdict } from "@tugra/shared";
import { ImporterService } from "./importer.service";
import { AgentCoolifyClient } from "./sources/agent-coolify.client";
import { AgentCoolifySource } from "./sources/agent-coolify.source";
import { CoolifySource } from "./sources/coolify.source";
import { fixtureRead } from "./__fixtures__/agent-coolify.fixture";

/**
 * The agent transport of the import session (Coolify hub takeover, lane A): connect without a token, open through the agent, keep the
 * team and the consent checks the token path never needed, and add the agent facts to the plan without touching planHash.
 */

const SERVER = { id: "srv-agent", teamId: "t1" };

function make(over: { session?: unknown; optIn?: boolean; server?: unknown; read?: () => Promise<ReturnType<typeof fixtureRead>>; verdicts?: HostMatchVerdict[]; roleError?: Error } = {}) {
  const importSession = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sess-a", ...data })),
    findUnique: jest.fn().mockResolvedValue(over.session ?? null),
    update: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma = {
    importSession,
    server: { findUnique: jest.fn().mockResolvedValue(over.server === undefined ? SERVER : over.server), findMany: jest.fn().mockResolvedValue([]) },
    coolifyInventory: { findFirst: jest.fn().mockResolvedValue(over.optIn === false ? null : { id: "inv-1" }) },
  };
  const crypto = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) };
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    requireRole: jest.fn(async () => {
      if (over.roleError) throw over.roleError;
    }),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map()),
  };
  const audit = { log: jest.fn() };
  const reads = { read: jest.fn(over.read ?? (async () => fixtureRead())) };
  const sources = {
    create: jest.fn((_k: string) => new CoolifySource({ get: jest.fn() } as never)),
    createAgent: jest.fn((serverId: string) => new AgentCoolifySource(new AgentCoolifyClient(reads, serverId))),
    label: jest.fn(() => "Coolify"),
  };
  const hostMatch = { verdicts: jest.fn().mockResolvedValue(over.verdicts ?? []) };
  const svc = new ImporterService({} as never, prisma as never, crypto as never, access as never, audit as never, sources as never, undefined, hostMatch as never);
  return { svc, prisma, importSession, crypto, access, audit, sources, reads, hostMatch };
}

const agentSession = (over: Record<string, unknown> = {}) => ({
  id: "sess-a",
  teamId: "t1",
  actorId: "u1",
  sourceKind: "coolify",
  baseUrl: "agent://srv-agent",
  tokenEnc: "",
  transport: "agent",
  agentServerId: "srv-agent",
  scopeKey: "",
  status: "active",
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});

describe("ImporterService.connectAgent", () => {
  it("reads once, stores an agent session with NO token and only an encrypted summary of the read, and audits it", async () => {
    const { svc, importSession, crypto, access, audit, reads } = make();
    const res = await svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(access.requireRole).toHaveBeenCalledWith("u1", "t1", [Role.OWNER, Role.ADMIN]);
    expect(reads.read).toHaveBeenCalledTimes(1);
    const data = importSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceKind: "coolify", transport: "agent", agentServerId: "srv-agent", baseUrl: "agent://srv-agent", tokenEnc: "", status: "active" });
    // the summary is counts and versions: nothing of any row, no value, no secret count beyond a number
    const summary = JSON.parse(crypto.encrypt.mock.calls[0][0]);
    expect(summary).toMatchObject({ transport: "agent", counts: { teams: 3, applications: 4, databases: 2, services: 1 } });
    expect(data.snapshotEnc).toBe(`enc(${JSON.stringify(summary)})`);
    expect(JSON.stringify(summary)).not.toMatch(/example\.com|198\.51\.100|NODE_ENV/);
    expect(res).toMatchObject({ sessionId: "sess-a", read: { transport: "agent", schemaVersion: "2025_11_20_000000_add_something" } });
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(/example\.com|198\.51\.100/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.connect", meta: expect.objectContaining({ transport: "agent", serverId: "srv-agent" }) }));
  });

  it("is owner/admin only: a member without the role is refused before the server is even looked up", async () => {
    const { svc, prisma, reads } = make({ roleError: new ForbiddenException("role") });
    await expect(svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.server.findUnique).not.toHaveBeenCalled();
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("refuses a server of another team (404, nothing read)", async () => {
    const { svc, reads, importSession } = make({ server: { id: "srv-agent", teamId: "other" } });
    await expect(svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent" })).rejects.toBeInstanceOf(NotFoundException);
    expect(reads.read).not.toHaveBeenCalled();
    expect(importSession.create).not.toHaveBeenCalled();
  });

  it("needs the server's own opt-in (the consent for reading that host's Coolify): without it nothing is read", async () => {
    const { svc, reads, importSession } = make({ optIn: false });
    await expect(svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent" })).rejects.toMatchObject({ response: { code: "not_enabled" } });
    expect(reads.read).not.toHaveBeenCalled();
    expect(importSession.create).not.toHaveBeenCalled();
  });

  it("a host that cannot be read (offline agent, no Coolify, not read-only) stores no session", async () => {
    const { svc, importSession } = make({ read: async () => Promise.reject(new ConflictException({ code: "agent_offline", message: "offline" })) });
    await expect(svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent" })).rejects.toBeInstanceOf(BadRequestException);
    expect(importSession.create).not.toHaveBeenCalled();
  });
});

describe("ImporterService.plan — agent session", () => {
  it("opens through the agent (never through a token), and adds the agent facts to the preflight outside planHash", async () => {
    const { svc, sources, crypto, reads } = make({ session: agentSession() });
    const plan = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    expect(sources.createAgent).toHaveBeenCalledWith("srv-agent", expect.objectContaining({ run: { sessionId: "sess-a", userId: "u1" } }));
    expect(sources.create).not.toHaveBeenCalled();
    expect(crypto.decrypt).not.toHaveBeenCalled(); // no token to decrypt
    expect(reads.read).toHaveBeenCalledTimes(1);
    expect(plan.totals.apps).toBe(4);
    expect(plan.preflight?.agentRead).toMatchObject({ transport: "agent", agentServerId: "srv-agent", counts: { applications: 4 } });
    expect(plan.preflight?.teams).toEqual([{ ref: "1", name: "Acme" }, { ref: "2", name: "Beta Labs" }]);
    expect(plan.preflight?.projects?.every((p) => !!p.team)).toBe(true);
  });

  it("the same plan twice reads twice: no stored snapshot stands in for a fresh read (drift, freeze and the final data pass see the truth)", async () => {
    const { svc, reads } = make({ session: agentSession() });
    const a = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    const b = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    expect(reads.read).toHaveBeenCalledTimes(2);
    expect(a.planHash).toBe(b.planHash);
  });

  it("fails closed when the opt-in has been withdrawn since the session was made", async () => {
    const { svc, reads } = make({ session: agentSession(), optIn: false });
    await expect(svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" })).rejects.toMatchObject({ response: { code: "not_enabled" } });
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("is owner/admin only on every open, not just at connect (a demoted actor is refused)", async () => {
    const { svc, reads } = make({ session: agentSession(), roleError: new ForbiddenException("role") });
    await expect(svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("another user's agent session is refused, and an agent session without its server is not an agent session", async () => {
    await expect(make({ session: agentSession({ actorId: "someone-else" }) }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ session: agentSession({ agentServerId: null }) }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an expired or revoked agent session is refused before any read", async () => {
    const { svc, reads } = make({ session: agentSession({ status: "revoked" }) });
    await expect(svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" })).rejects.toBeInstanceOf(BadRequestException);
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("an API session keeps using the token path and its plan carries no agent block", async () => {
    const apiSession = { ...agentSession(), transport: "api", agentServerId: null, baseUrl: "https://coolify.example.com", tokenEnc: "enc(T)" };
    const { svc, sources, reads } = make({ session: apiSession });
    // the fake token source answers nothing: only the routing matters here
    await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" }).catch(() => undefined);
    expect(sources.create).toHaveBeenCalledWith("coolify", "https://coolify.example.com", "T");
    expect(sources.createAgent).not.toHaveBeenCalled();
    expect(reads.read).not.toHaveBeenCalled();
  });
});

describe("ImporterService.plan — agent transport matches hosts with the evidence ladder", () => {
  const verdict = (over: Partial<HostMatchVerdict>): HostMatchVerdict => ({ coolifyServerUuid: "srv-edge", status: "probable", tugraServerId: "tugra-1", candidates: [{ serverId: "tugra-1", name: "edge-1", teamId: "t1", evidence: [{ kind: "ip", equal: true }] }], ...over });

  it("a probable verdict becomes a probable match with its evidence kinds, and the control-plane row is the agent's own server", async () => {
    const local = verdict({ coolifyServerUuid: "srv-local", status: "certain", tugraServerId: "srv-agent", candidates: [{ serverId: "srv-agent", name: "hub-box", teamId: "t1", evidence: [{ kind: "machine_id", equal: true }] }] });
    const { svc, hostMatch } = make({ session: agentSession(), verdicts: [local, verdict({})] });
    const plan = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    const hosts = plan.preflight!.hosts!;
    expect(hostMatch.verdicts).toHaveBeenCalledWith("u1", expect.arrayContaining([expect.objectContaining({ uuid: "srv-local", isLocal: true }), expect.objectContaining({ uuid: "srv-edge", address: "198.51.100.7", isLocal: false })]), { localServerId: "srv-agent" });
    expect(hosts.find((h) => h.ref === "srv-edge")).toMatchObject({ tugra: { serverId: "tugra-1", confidence: "probable" }, match: { status: "probable", linkedBy: "auto", evidence: [{ kind: "ip", equal: true }] } });
    expect(hosts.find((h) => h.ref === "srv-local")).toMatchObject({ tugra: { serverId: "srv-agent", confidence: "certain" }, match: { status: "certain" } });
    expect(JSON.stringify(hosts)).not.toContain("198.51.100"); // a verdict only: no source address
  });

  it("an ambiguous or unmatched host gets a verdict but no Tugra server (the owner picks)", async () => {
    const { svc } = make({ session: agentSession(), verdicts: [verdict({ status: "ambiguous", tugraServerId: null })] });
    const plan = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    const edge = plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!;
    expect(edge.tugra).toBeUndefined();
    expect(edge.match).toMatchObject({ status: "ambiguous", linkedBy: null });
  });
});
