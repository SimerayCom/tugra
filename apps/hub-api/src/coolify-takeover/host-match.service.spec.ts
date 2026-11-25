import { HostMatchService, linkOf, preflightMatchOf, probeIdentity } from "./host-match.service";
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
    const facts = { dockerEngineId: "eng-1", machineIdHash: "m".repeat(64) };
    const { svc, servers } = make([row("a")], [["t1", ["servers:manage"]]], { a: facts });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: null, facts }]);
    expect(servers.hostIdentityOf).toHaveBeenCalledWith("a");
    expect(v).toMatchObject({ status: "certain", tugraServerId: "a" });
  });

  it("a lone engine id (a cloned VM) is only probable", async () => {
    const facts = { dockerEngineId: "eng-1" };
    const { svc } = make([row("a")], [["t1", ["servers:manage"]]], { a: facts });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: null, facts }]);
    expect(v).toMatchObject({ status: "probable", tugraServerId: "a" });
  });

  it("the Coolify host row is the reading agent's own server", async () => {
    const { svc } = make([row("agent")], [["t1", ["servers:manage"]]]);
    const [v] = await svc.verdicts("u1", [{ uuid: "c0", address: "host.docker.internal", isLocal: true }], { localServerId: "agent" });
    expect(v).toMatchObject({ status: "certain", tugraServerId: "agent" });
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

describe("HostMatchService: the SSH probe's identity facts reach the ladder", () => {
  const HEX = "0123456789abcdef".repeat(4);
  const FP = "SHA256:" + "A".repeat(43);
  function makeWithProbes(probes: Array<{ coolifyServerUuid: string; probe: unknown; hostKeyFp: string | null }>, rows: unknown[], identity: Record<string, unknown> = {}) {
    const prisma = { server: { findMany: jest.fn().mockResolvedValue(rows) }, coolifySshTarget: { findMany: jest.fn().mockResolvedValue(probes) } };
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:manage"])]])) };
    const servers = { hostIdentityOf: jest.fn((id: string) => identity[id]) };
    return { svc: new HostMatchService(prisma as never, access as never, servers as never), prisma };
  }

  it("a probed machine id and engine id that equal the agent's make the match certain, with no address in common", async () => {
    const { svc, prisma } = makeWithProbes([{ coolifyServerUuid: "c1", probe: { machineIdHash: HEX, dockerEngineId: "ENGINE-1234" }, hostKeyFp: null }], [row("a", { publicIp: "203.0.113.1" })], { a: { machineIdHash: HEX, dockerEngineId: "ENGINE-1234" } });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: "198.51.100.9" }], { localServerId: "agent" });
    expect(prisma.coolifySshTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ serverId: "agent", coolifyServerUuid: { in: ["c1"] } }) }));
    expect(v).toMatchObject({ status: "certain", tugraServerId: "a" });
    expect(v.candidates[0].evidence).toEqual(expect.arrayContaining([{ kind: "machine_id", equal: true }, { kind: "docker_engine_id", equal: true }]));
  });

  it("the sshd host key the Coolify host saw on the wire confirms alone against any key the agent reports about itself", async () => {
    const { svc } = makeWithProbes([{ coolifyServerUuid: "c1", probe: { sshHostKeyFp: FP }, hostKeyFp: FP }], [row("a")], { a: { sshHostKeyFp: "SHA256:" + "B".repeat(43), sshHostKeyFps: ["SHA256:" + "B".repeat(43), FP] } });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: null }], { localServerId: "agent" });
    expect(v).toMatchObject({ status: "certain", tugraServerId: "a" });
  });

  it("a probed identity that differs is a conflict: the shared address no longer makes it probable", async () => {
    const { svc } = makeWithProbes([{ coolifyServerUuid: "c1", probe: { machineIdHash: "f".repeat(64) }, hostKeyFp: null }], [row("a", { publicIp: "203.0.113.5" })], { a: { machineIdHash: HEX } });
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: "203.0.113.5" }], { localServerId: "agent" });
    expect(v.status).not.toBe("certain");
    expect(v.tugraServerId).toBeNull();
  });

  it("a server nobody probed is unknown, never 'different'; only the rows without facts are looked up, and the Coolify host row never is", async () => {
    const { svc, prisma } = makeWithProbes([], [row("a", { publicIp: "203.0.113.5" })]);
    const all = await svc.verdicts(
      "u1",
      [{ uuid: "c1", address: "203.0.113.5" }, { uuid: "c2", address: null, facts: { machineIdHash: HEX } }, { uuid: "c0", address: "host.docker.internal", isLocal: true }],
      { localServerId: "agent" },
    );
    const v = all.find((x) => x.coolifyServerUuid === "c1")!;
    expect(prisma.coolifySshTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ coolifyServerUuid: { in: ["c1"] } }) }));
    expect(v.status).toBe("probable"); // by address, as before
  });

  it("looks at probes only when the Coolify host's agent is named (the token path has none)", async () => {
    const { svc, prisma } = makeWithProbes([], [row("a")]);
    await svc.verdicts("u1", [{ uuid: "c1", address: "203.0.113.5" }]);
    expect(prisma.coolifySshTarget.findMany).not.toHaveBeenCalled();
  });

  it("a probe lookup that fails leaves the ladder to the address (the match is never blocked by it)", async () => {
    const { svc, prisma } = makeWithProbes([], [row("a", { publicIp: "203.0.113.5" })]);
    prisma.coolifySshTarget.findMany.mockRejectedValueOnce(new Error("db"));
    const [v] = await svc.verdicts("u1", [{ uuid: "c1", address: "203.0.113.5" }], { localServerId: "agent" });
    expect(v.status).toBe("probable");
  });

  it("the newest probe of a server wins", async () => {
    const { svc } = makeWithProbes(
      [{ coolifyServerUuid: "c1", probe: { machineIdHash: HEX }, hostKeyFp: null }, { coolifyServerUuid: "c1", probe: { machineIdHash: "e".repeat(64) }, hostKeyFp: null }],
      [row("a")],
      { a: { machineIdHash: HEX } },
    );
    const facts = await svc.probeFacts("agent", ["c1"]);
    expect(facts.get("c1")).toEqual({ machineIdHash: HEX });
  });

  describe("identityBetween: compared directly, with no ladder candidate needed", () => {
    it("a machine id, engine id or host key that differs is a conflict even when the two servers share nothing else", async () => {
      const FP = "SHA256:" + "A".repeat(43);
      const { svc } = makeWithProbes([{ coolifyServerUuid: "c1", probe: { machineIdHash: HEX, dockerEngineId: "ENGINE-1111", sshHostKeyFp: FP }, hostKeyFp: null }], [row("a")], {
        a: { machineIdHash: "e".repeat(64), dockerEngineId: "ENGINE-1111", sshHostKeyFp: "SHA256:" + "B".repeat(43) },
      });
      const ev = await svc.identityBetween("agent", "c1", "a");
      expect(ev).toEqual(expect.arrayContaining([{ kind: "machine_id", equal: false }, { kind: "docker_engine_id", equal: true }, { kind: "ssh_host_key", equal: false }]));
    });

    it("says nothing when either side has not reported (unknown is never different)", async () => {
      const { svc } = makeWithProbes([], [row("a")], { a: { machineIdHash: HEX } });
      expect(await svc.identityBetween("agent", "c1", "a")).toEqual([]);
      const none = makeWithProbes([{ coolifyServerUuid: "c1", probe: { machineIdHash: HEX }, hostKeyFp: null }], [row("a")], {});
      expect(await none.svc.identityBetween("agent", "c1", "a")).toEqual([]);
    });

    it("an agreeing machine id is equal evidence", async () => {
      const { svc } = makeWithProbes([{ coolifyServerUuid: "c1", probe: { machineIdHash: HEX }, hostKeyFp: null }], [row("a")], { a: { machineIdHash: HEX } });
      expect(await svc.identityBetween("agent", "c1", "a")).toEqual([{ kind: "machine_id", equal: true }]);
    });
  });
});

describe("probeIdentity: only a fact with the shape of one is kept", () => {
  const HEX = "0123456789abcdef".repeat(4);
  const FP = "SHA256:" + "A".repeat(43);
  it("keeps a hashed machine id, an engine id and a host key fingerprint", () => {
    expect(probeIdentity({ machineIdHash: HEX, dockerEngineId: "ENGINE-1234", sshHostKeyFp: FP, uid: 0, arch: "x86_64" }, null)).toEqual({ machineIdHash: HEX, dockerEngineId: "ENGINE-1234", sshHostKeyFp: FP });
  });
  it("falls back to the stored host key column, and drops malformed values (no raw machine id, no free text)", () => {
    expect(probeIdentity({}, FP)).toEqual({ sshHostKeyFp: FP });
    expect(probeIdentity({ machineIdHash: "0123456789abcdef", dockerEngineId: "bad id; rm", sshHostKeyFp: "nope" }, "also nope")).toBeNull();
    expect(probeIdentity({ machineIdHash: HEX.toUpperCase() }, null)).toBeNull();
  });
  it("copes with a probe that is not an object", () => {
    for (const bad of [null, undefined, "x", 5, [1, 2]]) expect(probeIdentity(bad, null)).toBeNull();
  });
});

