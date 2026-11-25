import { HostMatchService, linkOf, preflightMatchOf } from "./host-match.service";
import type { HostMatchVerdict } from "@tugra/shared";

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `n-${id}`, teamId: "t1", publicIp: null, publicIpv6: null, hostname: null, reportedIps: [], ...over });

function make(rows: unknown[], perms: Array<[string, string[]]>, identity: Record<string, unknown> = {}) {
  const prisma = { server: { findMany: jest.fn().mockResolvedValue(rows) } };
  const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map(perms.map(([t, p]) => [t, new Set(p)]))) };
  const servers = { hostIdentityOf: jest.fn((id: string) => identity[id]) };
  return { svc: new HostMatchService(prisma as never, access as never, servers as never), prisma, access, servers };
}

describe("HostMatchService.verdicts", () => {
  it("loads only the servers of the caller's teams and marks the ones they can manage", async () => {
    const { svc, prisma } = make([row("mine", { publicIp: "203.0.113.5" }), row("theirs", { teamId: "t2", publicIp: "203.0.113.5" })], [["t1", ["servers:manage"]], ["t2", ["apps:config"]]]);
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: "203.0.113.5" }]);
    expect(prisma.server.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: { in: ["t1", "t2"] } } }));
    // the second team's server shares the address (so it is not probable) but is never offered
    expect(v.status).toBe("ambiguous");
    expect(v.candidates.map((c) => c.serverId)).toEqual(["mine"]);
  });

  it("a team where the caller lacks servers:manage never yields a link, even for an identity match", async () => {
    const facts = { machineIdHash: "m" };
    const { svc } = make([row("a", { teamId: "t2" })], [["t2", ["apps:config"]]], { a: facts });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: null, facts }]);
    expect(v).toMatchObject({ status: "none", candidates: [] });
    expect(linkOf(v)).toBeNull();
  });

  it("attaches the identity facts the agents reported", async () => {
    const facts = { dockerEngineId: "eng-1" };
    const { svc, servers } = make([row("a")], [["t1", ["servers:manage"]]], { a: facts });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: null, facts }]);
    expect(servers.hostIdentityOf).toHaveBeenCalledWith("a");
    expect(v).toMatchObject({ status: "certain", tugraServerId: "a" });
  });

  it("the Coolify host row is the reading agent's own server", async () => {
    const { svc } = make([row("agent")], [["t1", ["servers:manage"]]]);
    const [v] = await svc.verdicts("u1", [{ uuid: "c0", address: "host.docker.internal", isLocal: true }], { localServerId: "agent" });
    expect(v).toMatchObject({ status: "probable", tugraServerId: "agent" });
  });

  it("has no query to make for no hosts, and none for a caller in no team", async () => {
    const empty = make([], []);
    expect(await empty.svc.verdicts("u1", [])).toEqual([]);
    expect(empty.prisma.server.findMany).not.toHaveBeenCalled();
    const noTeam = make([row("a")], []);
    expect((await noTeam.svc.verdicts("u1", [{ uuid: "c1", address: "203.0.113.5" }]))[0].status).toBe("none");
    expect(noTeam.prisma.server.findMany).not.toHaveBeenCalled();
  });
});

describe("what a verdict allows", () => {
  const v = (status: HostMatchVerdict["status"], over: Partial<HostMatchVerdict> = {}): HostMatchVerdict => ({
    coolifyServerUuid: "c1",
    status,
    tugraServerId: status === "certain" || status === "probable" ? "s1" : null,
    candidates: [{ serverId: "s1", name: "n", teamId: "t1", evidence: [{ kind: "ip", equal: true }] }],
    ...over,
  });

  it("links certain and probable as an AUTO link with the evidence, never ambiguous or none", () => {
    expect(linkOf(v("probable"))).toEqual({ teamId: "t1", serverId: "s1", linkedBy: "auto", evidence: [{ kind: "ip", equal: true }] });
    expect(linkOf(v("certain"))).toMatchObject({ linkedBy: "auto" });
    expect(linkOf(v("ambiguous"))).toBeNull();
    expect(linkOf(v("none"))).toBeNull();
    expect(linkOf(v("probable", { tugraServerId: "ghost" }))).toBeNull();
  });

  it("shows the verdict kinds only", () => {
    expect(preflightMatchOf(v("probable"))).toEqual({ status: "probable", linkedBy: "auto", evidence: [{ kind: "ip", equal: true }] });
    expect(preflightMatchOf(v("ambiguous"))).toEqual({ status: "ambiguous", linkedBy: null, evidence: [] });
  });
});
