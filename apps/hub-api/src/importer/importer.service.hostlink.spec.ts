import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { HostEvidence, HostMatchVerdict } from "@tugra/shared";
import { ImporterService } from "./importer.service";
import { AgentCoolifyClient } from "./sources/agent-coolify.client";
import { AgentCoolifySource } from "./sources/agent-coolify.source";
import { fixtureRead } from "./__fixtures__/agent-coolify.fixture";

/**
 * The owner's own answer to "is this Coolify server that Tugra server" (agent session), and what the plan does with it.
 */

const TUGRA = [
  { id: "tugra-1", name: "edge-1", teamId: "t1", status: "ONLINE", publicIp: "198.51.100.7", publicIpv6: null, hostname: "edge", reportedIps: [] },
  { id: "tugra-2", name: "builder-1", teamId: "t1", status: "OFFLINE", publicIp: null, publicIpv6: null, hostname: "builder", reportedIps: [] },
  { id: "srv-agent", name: "hub-box", teamId: "t1", status: "ONLINE", publicIp: null, publicIpv6: null, hostname: "hub", reportedIps: [] },
  { id: "tugra-3", name: "viewer-box", teamId: "t2", status: "ONLINE", publicIp: null, publicIpv6: null, hostname: "v", reportedIps: [] },
];

const session = (over: Record<string, unknown> = {}) => ({
  id: "sess-a", teamId: "t1", actorId: "u1", sourceKind: "coolify", baseUrl: "agent://srv-agent", tokenEnc: "", transport: "agent", agentServerId: "srv-agent",
  scopeKey: "", status: "active", expiresAt: new Date(Date.now() + 60_000), hostLinks: null, sourceTeamRef: null, ...over,
});

const verdict = (over: Partial<HostMatchVerdict> = {}): HostMatchVerdict => ({ coolifyServerUuid: "srv-edge", status: "probable", tugraServerId: "tugra-1", candidates: [{ serverId: "tugra-1", name: "edge-1", teamId: "t1", evidence: [{ kind: "ip", equal: true }] }], ...over });

function make(o: { session?: Record<string, unknown> | null; verdicts?: HostMatchVerdict[]; identity?: Record<string, HostEvidence[]>; manage?: boolean; teams?: string[]; roleError?: Error } = {}) {
  const row = o.session === null ? null : session(o.session);
  const importSession = {
    findUnique: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sess-a", ...data })),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma = {
    importSession,
    server: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => TUGRA.find((s) => s.id === where.id) ?? null),
      findMany: jest.fn(async () => TUGRA.filter((s) => (o.teams ?? ["t1"]).includes(s.teamId))),
    },
    coolifyInventory: { findFirst: jest.fn().mockResolvedValue({ id: "inv" }) },
  };
  const perms = new Map<string, Set<string>>();
  for (const t of o.teams ?? ["t1"]) perms.set(t, new Set(o.manage === false ? ["apps:config"] : ["apps:config", "servers:manage"]));
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    requireRole: jest.fn(async () => {
      if (o.roleError) throw o.roleError;
    }),
    permissionsByTeam: jest.fn().mockResolvedValue(perms),
  };
  const audit = { log: jest.fn() };
  const reads = { read: jest.fn(async () => fixtureRead()) };
  const sources = {
    createAgent: jest.fn((serverId: string) => new AgentCoolifySource(new AgentCoolifyClient(reads, serverId))),
    finishAgentRun: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
    label: jest.fn(() => "Coolify"),
  };
  // The direct identity comparison between the Coolify server and a Tugra server (by Tugra server id); nothing reported = no evidence.
  const hostMatch = {
    verdicts: jest.fn().mockResolvedValue(o.verdicts ?? [verdict()]),
    identityBetween: jest.fn(async (_agent: string, _uuid: string, tugraId: string) => o.identity?.[tugraId] ?? []),
  };
  const svc = new ImporterService({} as never, prisma as never, { encrypt: (s: string) => s, decrypt: (s: string) => s } as never, access as never, audit as never, sources as never, undefined, hostMatch as never);
  return { svc, prisma, importSession, access, audit, sources, hostMatch, reads };
}

const link = (over: Record<string, unknown> = {}) => ({ coolifyServerUuid: "srv-edge", serverId: "tugra-1", ...over }) as never;

describe("ImporterService.setHostLink", () => {
  it("stores the owner's answer as ids on the session, reading the Coolify servers once, and audits it", async () => {
    const m = make();
    const r = await m.svc.setHostLink("u1", "sess-a", link({ serverId: "tugra-2" }));
    expect(r.hostLinks).toEqual({ "srv-edge": { serverId: "tugra-2" } });
    expect(m.importSession.update).toHaveBeenCalledWith({ where: { id: "sess-a" }, data: { hostLinks: { "srv-edge": { serverId: "tugra-2" } } } });
    expect(m.reads.read).toHaveBeenCalledTimes(1);
    expect(m.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "import.host_link", target: "sess-a", meta: { coolifyServerUuid: "srv-edge", serverId: "tugra-2" } });
    expect(JSON.stringify(m.audit.log.mock.calls)).not.toContain("198.51.100");
  });

  it("keeps the answers already given and adds to them", async () => {
    const m = make({ session: { hostLinks: { "srv-build": { serverId: null } } } });
    const r = await m.svc.setHostLink("u1", "sess-a", link());
    expect(r.hostLinks).toEqual({ "srv-build": { serverId: null }, "srv-edge": { serverId: "tugra-1" } });
  });

  it("'not the same server' stores null, and a reset takes the answer back", async () => {
    const m = make({ session: { hostLinks: { "srv-edge": { serverId: "tugra-1" } } } });
    expect((await m.svc.setHostLink("u1", "sess-a", link({ serverId: null }))).hostLinks).toEqual({ "srv-edge": { serverId: null } });
    const m2 = make({ session: { hostLinks: { "srv-edge": { serverId: "tugra-1" } } } });
    expect((await m2.svc.setHostLink("u1", "sess-a", link({ reset: true }))).hostLinks).toEqual({});
  });

  it("refuses 'same machine' against the machine's own identity: a different host key, machine id or engine id is a 409 and stores nothing", async () => {
    for (const kind of ["ssh_host_key", "machine_id", "docker_engine_id"] as const) {
      const m = make({ identity: { "tugra-1": [{ kind, equal: false }] } });
      await expect(m.svc.setHostLink("u1", "sess-a", link())).rejects.toMatchObject({ response: { code: "identity_conflict" } });
      expect(m.importSession.update).not.toHaveBeenCalled();
      expect(m.audit.log).not.toHaveBeenCalled();
    }
  });

  it("refuses on a differing identity even when the ladder lists no candidate at all (no other fact is shared)", async () => {
    const m = make({ verdicts: [verdict({ status: "none", tugraServerId: null, candidates: [] })], identity: { "tugra-1": [{ kind: "machine_id", equal: false }] } });
    await expect(m.svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(ConflictException);
    expect(m.importSession.update).not.toHaveBeenCalled();
    expect(m.hostMatch.identityBetween).toHaveBeenCalledWith("srv-agent", "srv-edge", "tugra-1");
  });

  it("a single differing kind refuses even when the other kinds agree", async () => {
    const m = make({ identity: { "tugra-1": [{ kind: "machine_id", equal: true }, { kind: "ssh_host_key", equal: false }] } });
    await expect(m.svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(ConflictException);
  });

  it("an address or host name that differs is not an identity conflict: the owner may still say it is the machine", async () => {
    const m = make({ identity: { "tugra-1": [{ kind: "ip", equal: false }, { kind: "hostname", equal: false }] } });
    await expect(m.svc.setHostLink("u1", "sess-a", link())).resolves.toBeDefined();
  });

  it("an identity that agrees, or that nobody reported, is not a conflict (the owner may confirm what they know)", async () => {
    await expect(make({ identity: { "tugra-1": [{ kind: "machine_id", equal: true }] } }).svc.setHostLink("u1", "sess-a", link())).resolves.toBeDefined();
    await expect(make().svc.setHostLink("u1", "sess-a", link())).resolves.toBeDefined();
  });

  it("the Coolify host itself is always 'this server': no answer can be given for it", async () => {
    const m = make();
    await expect(m.svc.setHostLink("u1", "sess-a", link({ coolifyServerUuid: "srv-local" }))).rejects.toMatchObject({ response: { code: "local_row" } });
    expect(m.importSession.update).not.toHaveBeenCalled();
  });

  it("an unknown Coolify server is a 404", async () => {
    await expect(make().svc.setHostLink("u1", "sess-a", link({ coolifyServerUuid: "nope" }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it("names only a Tugra server the caller manages: one outside the caller's teams is a 404, one without servers:manage is a 403", async () => {
    await expect(make().svc.setHostLink("u1", "sess-a", link({ serverId: "tugra-3" }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(make().svc.setHostLink("u1", "sess-a", link({ serverId: "ghost" }))).rejects.toBeInstanceOf(NotFoundException);
    const noManage = make({ manage: false });
    await expect(noManage.svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(ForbiddenException);
    expect(noManage.importSession.update).not.toHaveBeenCalled();
  });

  it("is the session owner's, an agent session, still active, and owner/admin of the team", async () => {
    await expect(make({ session: null }).svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ session: { transport: "api", agentServerId: null } }).svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ session: { actorId: "someone-else" } }).svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ session: { status: "revoked" } }).svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ session: { expiresAt: new Date(Date.now() - 1) } }).svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(BadRequestException);
    const m = make({ roleError: new ForbiddenException("role") });
    await expect(m.svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.reads.read).not.toHaveBeenCalled();
  });

  it("bounds the number of answers a session keeps", async () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`u${i}`, { serverId: null }]));
    const m = make({ session: { hostLinks: many } });
    await expect(m.svc.setHostLink("u1", "sess-a", link())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("ignores junk stored under hostLinks (an id the shape does not allow is dropped on read)", async () => {
    const m = make({ session: { hostLinks: { "bad key!": { serverId: "x" }, "srv-build": "str", "srv-x": { serverId: 5 }, ok1: { serverId: "tugra-2" } } } });
    const r = await m.svc.setHostLink("u1", "sess-a", link());
    expect(r.hostLinks).toEqual({ ok1: { serverId: "tugra-2" }, "srv-edge": { serverId: "tugra-1" } });
  });
});

describe("ImporterService.plan: the owner's answer reaches the hosts", () => {
  const planOf = async (o: NonNullable<Parameters<typeof make>[0]>) => {
    const m = make({ ...o, verdicts: o.verdicts ?? [verdict({ status: "ambiguous", tugraServerId: null })] });
    const plan = await m.svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    return { plan, ...m };
  };

  it("'this is that server' becomes a probable match the owner chose, with the evidence beside it, unlocking the choice without preselecting it", async () => {
    const { plan } = await planOf({ session: { hostLinks: { "srv-edge": { serverId: "tugra-1" } } } });
    const edge = plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!;
    expect(edge.tugra).toEqual({ serverId: "tugra-1", name: "edge-1", teamId: "t1", via: "owner", confidence: "probable" });
    expect(edge.match).toEqual({ status: "probable", linkedBy: "user", evidence: [{ kind: "ip", equal: true }] });
    expect(edge.agentOnline).toBe(true);
  });

  it("an answer whose identity now differs from the machine's own is dropped at plan time, with the conflict shown, whatever the ladder listed", async () => {
    const { plan } = await planOf({ session: { hostLinks: { "srv-edge": { serverId: "tugra-1" } } }, identity: { "tugra-1": [{ kind: "docker_engine_id", equal: false }] } });
    const edge = plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!;
    expect(edge.tugra).toBeUndefined();
    expect(edge.agentOnline).toBe(false);
    expect(edge.match).toEqual({ status: "none", linkedBy: "user", evidence: [{ kind: "docker_engine_id", equal: false }, { kind: "ip", equal: true }] });
  });

  it("an answer whose identity agrees shows that identity as evidence beside the address", async () => {
    const { plan } = await planOf({ session: { hostLinks: { "srv-edge": { serverId: "tugra-1" } } }, identity: { "tugra-1": [{ kind: "machine_id", equal: true }] } });
    const edge = plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!;
    expect(edge.tugra).toMatchObject({ serverId: "tugra-1", via: "owner" });
    expect(edge.match).toEqual({ status: "probable", linkedBy: "user", evidence: [{ kind: "machine_id", equal: true }, { kind: "ip", equal: true }] });
  });

  it("a Tugra server whose agent is offline is matched, but not online", async () => {
    const { plan } = await planOf({ session: { hostLinks: { "srv-edge": { serverId: "tugra-2" } } } });
    expect(plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!).toMatchObject({ tugra: { serverId: "tugra-2" }, agentOnline: false });
  });

  it("'not the same server' removes the match, whatever the evidence said", async () => {
    const { plan } = await planOf({ verdicts: [verdict()], session: { hostLinks: { "srv-edge": { serverId: null } } } });
    const edge = plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!;
    expect(edge.tugra).toBeUndefined();
    expect(edge.match).toEqual({ status: "none", linkedBy: "user", evidence: [] });
    expect(edge.agentOnline).toBe(false);
  });

  it("an answer naming a server the caller can no longer see leaves no match (never a dangling id)", async () => {
    const { plan } = await planOf({ session: { hostLinks: { "srv-edge": { serverId: "tugra-3" } } } });
    expect(plan.preflight!.hosts!.find((h) => h.ref === "srv-edge")!.tugra).toBeUndefined();
  });

  it("an answer stored for the Coolify host's own row is ignored: it stays this server", async () => {
    const local = verdict({ coolifyServerUuid: "srv-local", status: "certain", tugraServerId: "srv-agent", candidates: [{ serverId: "srv-agent", name: "hub-box", teamId: "t1", evidence: [{ kind: "machine_id", equal: true }] }] });
    const { plan } = await planOf({ verdicts: [local], session: { hostLinks: { "srv-local": { serverId: null } } } });
    expect(plan.preflight!.hosts!.find((h) => h.ref === "srv-local")!.match?.status).not.toBe("none");
  });

  it("the plan hash does not move with an answer (it is outside the hash)", async () => {
    const a = await planOf({});
    const b = await planOf({ session: { hostLinks: { "srv-edge": { serverId: "tugra-1" } } } });
    expect(b.plan.planHash).toBe(a.plan.planHash);
  });
});

describe("ImporterService: the agent session around connect and revoke", () => {
  it("connect refuses a Coolify team that has no projects, and stores the one it was given", async () => {
    const m = make();
    await expect(m.svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent", sourceTeamRef: "99" })).rejects.toMatchObject({ response: { code: "unknown_team" } });
    expect(m.importSession.create).not.toHaveBeenCalled();
    const res = await m.svc.connectAgent("u1", { sourceKind: "coolify", teamId: "t1", serverId: "srv-agent", sourceTeamRef: "2" });
    expect(m.importSession.create.mock.calls[0][0].data).toMatchObject({ sourceTeamRef: "2" });
    expect(res.teams).toEqual([{ ref: "1", name: "Acme" }, { ref: "2", name: "Beta Labs" }]);
  });

  it("the source of an agent session is built for THAT session as the run, with the chosen team", async () => {
    const m = make({ session: { sourceTeamRef: "2" } });
    await m.svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    expect(m.sources.createAgent).toHaveBeenCalledWith("srv-agent", { run: { sessionId: "sess-a", userId: "u1" }, teamRef: "2" });
  });

  it("the plan names the team the owner picked (ref) and the Coolify team of each server, and no team when none was picked", async () => {
    const picked = await make({ session: { sourceTeamRef: "2" } }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    expect(picked.preflight!.sourceTeamRef).toBe("2");
    expect(picked.preflight!.hosts!.find((h) => h.ref === "srv-edge")!.team).toEqual({ ref: "1", name: "Acme" });
    const none = await make().svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-a" });
    expect(none.preflight).not.toHaveProperty("sourceTeamRef");
  });

  it("ending the session ends the consent of its run; an API session has none to end", async () => {
    const m = make();
    await m.svc.revokeSession("u1", "sess-a");
    expect(m.sources.finishAgentRun).toHaveBeenCalledWith("srv-agent", "sess-a");
    const api = make({ session: { transport: "api", agentServerId: null } });
    await api.svc.revokeSession("u1", "sess-a");
    expect(api.sources.finishAgentRun).not.toHaveBeenCalled();
  });

  it("a failure to end the consent never keeps the session alive", async () => {
    const m = make();
    m.sources.finishAgentRun.mockRejectedValueOnce(new Error("db down"));
    await expect(m.svc.revokeSession("u1", "sess-a")).resolves.toEqual({ ok: true });
    expect(m.importSession.update).toHaveBeenCalledWith({ where: { id: "sess-a" }, data: { status: "revoked" } });
  });
});
