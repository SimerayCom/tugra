import { HOST_EVIDENCE_STRENGTH } from "@tugra/shared";
import { identityEvidence, matchHosts, verdictHasIdentity, type CoolifyHostInput, type TugraHostInput } from "./host-match";

const tugra = (id: string, over: Partial<TugraHostInput> = {}): TugraHostInput => ({ serverId: id, name: `name-${id}`, teamId: "t1", publicIp: null, publicIpv6: null, hostname: null, reportedIps: [], canManage: true, ...over });
const cool = (uuid: string, address: string | null, over: Partial<CoolifyHostInput> = {}): CoolifyHostInput => ({ uuid, address, ...over });
const one = (c: CoolifyHostInput, s: TugraHostInput[], opts = {}) => matchHosts([c], s, opts)[0];

describe("matchHosts: the evidence ladder", () => {
  describe("E1 identity confirms alone", () => {
    it("an equal machine id AND an equal engine id are certain, even with no address in common", () => {
      const v = one(cool("c1", "198.51.100.9", { facts: { machineIdHash: "aa", dockerEngineId: "e1" } }), [tugra("a", { publicIp: "203.0.113.1", facts: { machineIdHash: "AA", dockerEngineId: "E1" } }), tugra("b", { facts: { machineIdHash: "bb" } })]);
      expect(v).toMatchObject({ status: "certain", tugraServerId: "a" });
      expect(v.candidates).toEqual([expect.objectContaining({ serverId: "a", evidence: [{ kind: "machine_id", equal: true }, { kind: "docker_engine_id", equal: true }] })]);
    });

    it("the host key confirms alone", () => {
      const f = { sshHostKeyFp: "fp1" };
      const v = one(cool("c1", null, { facts: f }), [tugra("a", { facts: f })]);
      expect(v.status).toBe("certain");
      expect(v.candidates[0].evidence).toContainEqual({ kind: "ssh_host_key", equal: true });
    });

    it("a LONE machine id or engine id (a cloned VM keeps both) is probable, never certain", () => {
      for (const f of [{ machineIdHash: "m1" }, { dockerEngineId: "e1" }]) {
        const v = one(cool("c1", "198.51.100.9", { facts: f }), [tugra("clone", { publicIp: "203.0.113.1", facts: f })]);
        expect(v).toMatchObject({ status: "probable", tugraServerId: "clone" });
        expect(verdictHasIdentity(v)).toBe(true);
      }
    });

    it("a lone machine id plus a unique address is certain; plus an address of ANOTHER server is not", () => {
      const f = { machineIdHash: "m1" };
      expect(one(cool("c1", "203.0.113.1", { facts: f }), [tugra("a", { publicIp: "203.0.113.1", facts: f })])).toMatchObject({ status: "certain", tugraServerId: "a" });
      const v = one(cool("c1", "203.0.113.1", { facts: f }), [tugra("twin", { publicIp: "203.0.113.50", facts: f }), tugra("addr", { publicIp: "203.0.113.1" })]);
      expect(v.status).toBe("ambiguous");
      expect(v.tugraServerId).toBeNull();
    });

    it("two clone twins with the same lone machine id are ambiguous, never picked", () => {
      const f = { machineIdHash: "m1" };
      expect(one(cool("c1", null, { facts: f }), [tugra("a", { facts: f }), tugra("b", { facts: f })])).toMatchObject({ status: "ambiguous", tugraServerId: null });
    });

    it("a lone machine id with a differing engine id is a conflict: no match", () => {
      const v = one(cool("c1", null, { facts: { machineIdHash: "m1", dockerEngineId: "e1" } }), [tugra("a", { facts: { machineIdHash: "m1", dockerEngineId: "e2" } })]);
      expect(v).toMatchObject({ status: "none", tugraServerId: null });
    });

    it("E1 beats an address that points at another server", () => {
      const facts = { machineIdHash: "m", dockerEngineId: "e" };
      const v = one(cool("c1", "203.0.113.1", { facts }), [tugra("addr", { publicIp: "203.0.113.1" }), tugra("same", { publicIp: "203.0.113.99", facts })]);
      expect(v).toMatchObject({ status: "certain", tugraServerId: "same" });
    });

    it("two servers with the same identity are ambiguous, never picked", () => {
      const facts = { dockerEngineId: "eng" };
      expect(one(cool("c1", null, { facts }), [tugra("a", { facts }), tugra("b", { facts })])).toMatchObject({ status: "ambiguous", tugraServerId: null });
    });

    it("an identity CONFLICT vetoes the address: same address, different machine is a stale reuse and never matches", () => {
      const v = one(cool("c1", "203.0.113.1", { facts: { machineIdHash: "x" } }), [tugra("a", { publicIp: "203.0.113.1", facts: { machineIdHash: "y" } })]);
      expect(v.status).toBe("none");
      expect(v.tugraServerId).toBeNull();
      expect(v.candidates[0].evidence).toEqual(expect.arrayContaining([{ kind: "machine_id", equal: false }, { kind: "ip", equal: true }]));
    });

    it("a fact only one side reports says nothing (it is neither equal nor a conflict)", () => {
      expect(identityEvidence({ machineIdHash: "m" }, {})).toEqual([]);
      expect(identityEvidence(undefined, { machineIdHash: "m" })).toEqual([]);
      expect(identityEvidence({ machineIdHash: "m", dockerEngineId: "a" }, { machineIdHash: "m", dockerEngineId: "b" })).toEqual([{ kind: "machine_id", equal: true }, { kind: "docker_engine_id", equal: false }]);
    });
  });

  describe("E2 address makes it probable, never certain", () => {
    it("a public address on exactly one server is probable", () => {
      const v = one(cool("c1", "203.0.113.5"), [tugra("a", { publicIp: "203.0.113.5" }), tugra("b", { publicIp: "203.0.113.6" })]);
      expect(v).toMatchObject({ status: "probable", tugraServerId: "a" });
      expect(v.candidates[0].evidence).toEqual([{ kind: "ip", equal: true }]);
    });

    it("matches through any address the agent reports, not only the public one", () => {
      expect(one(cool("c1", "203.0.113.5"), [tugra("a", { reportedIps: ["203.0.113.5", "10.0.0.2"] })]).status).toBe("probable");
    });

    it("IPv6 in any spelling is the same address, and IPv4-mapped IPv6 is the IPv4 address", () => {
      expect(one(cool("c1", "2001:0DB8:0:0:0:0:0:1"), [tugra("a", { publicIpv6: "2001:db8::1" })]).status).toBe("probable");
      expect(one(cool("c1", "[2001:db8::1]"), [tugra("a", { publicIpv6: "2001:db8:0:0:0:0:0:1" })]).status).toBe("probable");
      expect(one(cool("c1", "::ffff:203.0.113.5"), [tugra("a", { publicIp: "203.0.113.5" })]).status).toBe("probable");
      expect(one(cool("c1", "203.0.113.5"), [tugra("a", { reportedIps: ["::ffff:203.0.113.5"] })]).status).toBe("probable");
    });

    it("the same /64 is NOT the same machine", () => {
      expect(one(cool("c1", "2001:db8:0:1::5"), [tugra("a", { publicIpv6: "2001:db8:0:1::6" })]).status).toBe("none");
    });

    it("an address reported by two servers is ambiguous (two teams that each added the machine)", () => {
      const v = one(cool("c1", "203.0.113.5"), [tugra("a", { publicIp: "203.0.113.5", teamId: "t1" }), tugra("b", { publicIp: "203.0.113.5", teamId: "t2" })]);
      expect(v).toMatchObject({ status: "ambiguous", tugraServerId: null });
      expect(v.candidates.map((c) => c.serverId)).toEqual(["a", "b"]);
    });

    it("one NAT address with two SSH ports is two Coolify rows on one address: neither is probable", () => {
      const verdicts = matchHosts([cool("c1", "203.0.113.5", { }), cool("c2", "203.0.113.5")], [tugra("a", { publicIp: "203.0.113.5" })]);
      expect(verdicts.map((v) => v.status)).toEqual(["ambiguous", "ambiguous"]);
      expect(verdicts.every((v) => v.tugraServerId === null)).toBe(true);
    });

    it("...unless identity separates them", () => {
      const verdicts = matchHosts(
        [cool("c1", "203.0.113.5", { facts: { machineIdHash: "m1", dockerEngineId: "e1" } }), cool("c2", "203.0.113.5", { facts: { machineIdHash: "m2", dockerEngineId: "e2" } })],
        [tugra("a", { publicIp: "203.0.113.5", facts: { machineIdHash: "m1", dockerEngineId: "e1" } }), tugra("b", { publicIp: "203.0.113.5", facts: { machineIdHash: "m2", dockerEngineId: "e2" } })],
      );
      expect(verdicts.map((v) => [v.status, v.tugraServerId])).toEqual([["certain", "a"], ["certain", "b"]]);
    });

    it("a private address counts only when one Tugra server and one Coolify row carry it", () => {
      expect(one(cool("c1", "10.0.0.5"), [tugra("a", { reportedIps: ["10.0.0.5"] })]).status).toBe("probable");
      // the same private range on two servers (two networks): ambiguous
      expect(one(cool("c1", "10.0.0.5"), [tugra("a", { reportedIps: ["10.0.0.5"] }), tugra("b", { reportedIps: ["10.0.0.5"] })]).status).toBe("ambiguous");
      // the same private address on two Coolify rows: neither is probable
      expect(matchHosts([cool("c1", "192.168.1.9"), cool("c2", "192.168.1.9")], [tugra("a", { reportedIps: ["192.168.1.9"] })]).map((v) => v.status)).toEqual(["ambiguous", "ambiguous"]);
      expect(one(cool("c1", "fd00::5"), [tugra("a", { reportedIps: ["fd00::5"] })]).status).toBe("probable");
    });

    it("a CGNAT / Tailscale address alone is not enough: it needs an equal host name, and still one Tugra server", () => {
      expect(one(cool("c1", "100.100.1.1"), [tugra("a", { reportedIps: ["100.100.1.1"] })]).status).toBe("ambiguous");
      expect(one(cool("c1", "100.100.1.1", { extraAddresses: ["web-1.example.com"] }), [tugra("a", { reportedIps: ["100.100.1.1"], hostname: "web-1.example.com" })]).status).toBe("probable");
      // the same 100.x on two servers, even with a host name: ambiguous
      expect(one(cool("c1", "100.100.1.1", { extraAddresses: ["web-1"] }), [tugra("a", { reportedIps: ["100.100.1.1"], hostname: "web-1" }), tugra("b", { reportedIps: ["100.100.1.1"] })]).status).toBe("ambiguous");
    });

    it("an IPv4 and an IPv6 address that point at different servers are ambiguous", () => {
      const v = one(cool("c1", "203.0.113.5", { extraAddresses: ["2001:db8::9"] }), [tugra("a", { publicIp: "203.0.113.5" }), tugra("b", { publicIpv6: "2001:db8::9" })]);
      expect(v).toMatchObject({ status: "ambiguous", tugraServerId: null });
    });

    it("the same server on both families is one candidate, probable", () => {
      const v = one(cool("c1", "203.0.113.5", { extraAddresses: ["2001:db8::9"] }), [tugra("a", { publicIp: "203.0.113.5", publicIpv6: "2001:db8::9" })]);
      expect(v).toMatchObject({ status: "probable", tugraServerId: "a" });
      expect(v.candidates[0].evidence.filter((e) => e.kind === "ip")).toHaveLength(1);
    });
  });

  describe("E3 a host name never decides", () => {
    it("an equal host name (any case, trailing dot) is a candidate and ambiguous, never probable", () => {
      const v = one(cool("c1", "Web-1.Example.COM."), [tugra("a", { hostname: "web-1.example.com" })]);
      expect(v).toMatchObject({ status: "ambiguous", tugraServerId: null });
      expect(v.candidates[0].evidence).toEqual([{ kind: "hostname", equal: true }]);
    });

    it("an address match wins over a server that only shares the name", () => {
      const v = one(cool("c1", "203.0.113.5", { extraAddresses: ["web"] }), [tugra("addr", { publicIp: "203.0.113.5" }), tugra("name", { hostname: "web" })]);
      expect(v).toMatchObject({ status: "probable", tugraServerId: "addr" });
    });

    it("nothing in common is none", () => {
      expect(one(cool("c1", "203.0.113.5"), [tugra("a", { publicIp: "203.0.113.6", hostname: "other" })])).toMatchObject({ status: "none", tugraServerId: null, candidates: [] });
      expect(one(cool("c1", null), [tugra("a", { publicIp: "203.0.113.6" })]).status).toBe("none");
    });
  });

  describe("who can be matched", () => {
    it("a server the caller cannot manage is never proposed, never linked, and not even shown", () => {
      const v = one(cool("c1", "203.0.113.5", { facts: { machineIdHash: "m" } }), [tugra("viewer", { publicIp: "203.0.113.5", facts: { machineIdHash: "m" }, canManage: false })]);
      expect(v).toEqual({ coolifyServerUuid: "c1", status: "none", tugraServerId: null, candidates: [] });
    });

    it("but it still counts as a second reporter of the address (so the manageable one is not probable)", () => {
      const v = one(cool("c1", "203.0.113.5"), [tugra("mine", { publicIp: "203.0.113.5" }), tugra("theirs", { publicIp: "203.0.113.5", teamId: "t2", canManage: false })]);
      expect(v.status).toBe("ambiguous");
      expect(v.candidates.map((c) => c.serverId)).toEqual(["mine"]);
    });
  });

  describe("the Coolify host itself", () => {
    it("is the machine the reading agent runs on: certain from the agent session, with no self-comparison as evidence", () => {
      // no probe facts for the Coolify host: the verdict still rests on the session, and carries no invented evidence
      const noProbe = one(cool("c0", "host.docker.internal", { isLocal: true }), [tugra("agent", { facts: { machineIdHash: "m" } })], { localServerId: "agent" });
      expect(noProbe).toMatchObject({ status: "certain", tugraServerId: "agent" });
      expect(noProbe.candidates[0].evidence).toEqual([]);
      const without = one(cool("c0", "host.docker.internal", { isLocal: true }), [tugra("agent")], { localServerId: "agent" });
      expect(without).toMatchObject({ status: "certain", tugraServerId: "agent" });
      // a real probe that agrees is recorded as evidence
      const probed = one(cool("c0", null, { isLocal: true, facts: { machineIdHash: "m" } }), [tugra("agent", { facts: { machineIdHash: "m" } })], { localServerId: "agent" });
      expect(probed.candidates[0].evidence).toEqual([{ kind: "machine_id", equal: true }]);
    });

    it("never takes the session of one server for another: only the agent server is the local match", () => {
      const v = one(cool("c0", null, { isLocal: true }), [tugra("agent"), tugra("other")], { localServerId: "agent" });
      expect(v.tugraServerId).toBe("agent");
      expect(v.candidates.map((c) => c.serverId)).toEqual(["agent"]);
    });

    it("is none without a reading agent, or when that server cannot be managed", () => {
      expect(one(cool("c0", "host.docker.internal", { isLocal: true }), [tugra("agent")]).status).toBe("none");
      expect(one(cool("c0", "host.docker.internal", { isLocal: true }), [tugra("agent", { canManage: false })], { localServerId: "agent" }).status).toBe("none");
    });

    it("never matches by address or name, and never appears as a candidate of another Coolify row", () => {
      // loopback / docker aliases name no machine
      expect(one(cool("c1", "localhost"), [tugra("a", { hostname: "localhost", reportedIps: ["127.0.0.1"] })]).status).toBe("none");
      expect(one(cool("c1", "host.docker.internal"), [tugra("a", { hostname: "host.docker.internal" })]).status).toBe("none");
      expect(one(cool("c1", "127.0.0.1"), [tugra("a", { reportedIps: ["127.0.0.1"] })]).status).toBe("none");
      // the local row's own address does not make another row ambiguous
      const verdicts = matchHosts([cool("c0", "203.0.113.5", { isLocal: true }), cool("c1", "203.0.113.5")], [tugra("a", { publicIp: "203.0.113.5" })], { localServerId: "a" });
      expect(verdicts.find((v) => v.coolifyServerUuid === "c1")!.status).toBe("probable");
    });

    it("an identity conflict between the host's own facts and the agent's server is none", () => {
      expect(one(cool("c0", null, { isLocal: true, facts: { machineIdHash: "x" } }), [tugra("agent", { facts: { machineIdHash: "y" } })], { localServerId: "agent" }).status).toBe("none");
    });
  });

  describe("output", () => {
    it("is deterministic for any order of the inputs", () => {
      const hosts = [cool("c3", "203.0.113.3"), cool("c1", "203.0.113.1"), cool("c2", "10.0.0.2")];
      const servers = [tugra("s2", { publicIp: "203.0.113.3" }), tugra("s1", { publicIp: "203.0.113.1" }), tugra("s3", { reportedIps: ["10.0.0.2"] }), tugra("s4", { publicIp: "203.0.113.1", teamId: "t2" })];
      const a = matchHosts(hosts, servers);
      const b = matchHosts([...hosts].reverse(), [...servers].reverse());
      expect(b).toEqual(a);
      expect(a.map((v) => v.coolifyServerUuid)).toEqual(["c1", "c2", "c3"]);
    });

    it("carries evidence KINDS and ids only: no source address, host name or fingerprint value", () => {
      const v = one(cool("c1", "203.0.113.5", { extraAddresses: ["secret-host.example.com"], facts: { machineIdHash: "MIDVALUE", sshHostKeyFp: "FPVALUE" } }), [tugra("a", { publicIp: "203.0.113.5", hostname: "secret-host.example.com", facts: { machineIdHash: "MIDVALUE", sshHostKeyFp: "FPVALUE" } })]);
      const text = JSON.stringify(v);
      expect(text).not.toMatch(/203\.0\.113|secret-host|MIDVALUE|FPVALUE/);
    });

    it("returns nothing for no Coolify servers, and none for every server when there are no Tugra servers", () => {
      expect(matchHosts([], [tugra("a")])).toEqual([]);
      expect(matchHosts([cool("c1", "203.0.113.5")], []).map((v) => v.status)).toEqual(["none"]);
    });
  });

  describe("property: certain needs identity", () => {
    // A tiny deterministic generator over a small universe, so collisions (shared addresses, names, facts) are common.
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)];
    const addrs = ["203.0.113.1", "203.0.113.2", "10.0.0.1", "10.0.0.2", "100.64.0.9", "2001:db8::1", "2001:db8::2", "::ffff:203.0.113.1", "198.51.100.4"] as const;
    const names = ["web", "db", "edge.example.com", "localhost"] as const;
    const facts = (): CoolifyHostInput["facts"] => (rnd(3) === 0 ? { machineIdHash: pick(["m1", "m2", "m3"]) } : rnd(4) === 0 ? { dockerEngineId: pick(["e1", "e2"]) } : undefined);

    it("holds over 400 random worlds: certain implies an equal identity fact, probable implies no conflict, ids come from the inputs, and the order of the input never matters", () => {
      for (let i = 0; i < 400; i++) {
        const servers = Array.from({ length: 1 + rnd(4) }, (_, n) =>
          tugra(`s${n}`, { teamId: pick(["t1", "t2"]), publicIp: rnd(2) ? pick(addrs) : null, publicIpv6: rnd(5) === 0 ? pick(addrs) : null, hostname: rnd(3) === 0 ? pick(names) : null, reportedIps: rnd(2) ? [pick(addrs)] : [], facts: facts(), canManage: rnd(5) !== 0 }),
        );
        const hosts = Array.from({ length: 1 + rnd(4) }, (_, n) => cool(`c${n}`, rnd(6) === 0 ? pick(names) : pick(addrs), { extraAddresses: rnd(4) === 0 ? [pick(addrs)] : [], facts: facts(), isLocal: n === 0 && rnd(4) === 0 }));
        const opts = rnd(2) ? { localServerId: pick(servers).serverId } : {};
        const out = matchHosts(hosts, servers, opts);
        expect(matchHosts([...hosts].reverse(), [...servers].reverse(), opts)).toEqual(out);
        for (const v of out) {
          const host = hosts.find((h) => h.uuid === v.coolifyServerUuid)!;
          if (v.status === "certain" && !host.isLocal) {
            expect(verdictHasIdentity(v)).toBe(true);
            // a clone twin never makes a certain verdict alone: a lone machine id / engine id needs another E1 fact or a unique address
            const kinds = v.candidates.find((x) => x.serverId === v.tugraServerId)!.evidence.filter((e) => e.equal);
            const ids = kinds.filter((e) => HOST_EVIDENCE_STRENGTH[e.kind] === "identity").map((e) => e.kind);
            expect(ids.includes("ssh_host_key") || ids.length >= 2 || kinds.some((e) => e.kind === "ip")).toBe(true);
          }
          if (v.status === "certain" || v.status === "probable") {
            expect(servers.map((s) => s.serverId)).toContain(v.tugraServerId);
            expect(servers.find((s) => s.serverId === v.tugraServerId)!.canManage).toBe(true);
            const c = v.candidates.find((x) => x.serverId === v.tugraServerId)!;
            expect(c.evidence.some((e) => !e.equal)).toBe(false); // no conflict behind a match
            expect(c.evidence.some((e) => e.equal)).toBe(true);
          } else {
            expect(v.tugraServerId).toBeNull();
          }
          if (v.status === "probable" && !host.isLocal) expect(v.candidates.find((x) => x.serverId === v.tugraServerId)!.evidence.some((e) => HOST_EVIDENCE_STRENGTH[e.kind] !== "weak")).toBe(true);
          if (v.status === "none" && !host.isLocal) expect(v.tugraServerId).toBeNull();
          expect(v.candidates.every((c) => servers.find((s) => s.serverId === c.serverId)!.canManage)).toBe(true);
        }
      }
    });
  });
});

describe("identityEvidence: a machine has several sshd host keys", () => {
  const A = "SHA256:" + "A".repeat(43);
  const B = "SHA256:" + "B".repeat(43);
  const a = "SHA256:" + "a".repeat(43);

  it("the key the Coolify host saw is the machine's when it is ANY of the keys the agent reports", () => {
    expect(identityEvidence({ sshHostKeyFp: B }, { sshHostKeyFp: A, sshHostKeyFps: [A, B] })).toEqual([{ kind: "ssh_host_key", equal: true }]);
  });

  it("a key that is none of them is a conflict", () => {
    expect(identityEvidence({ sshHostKeyFp: B }, { sshHostKeyFp: A, sshHostKeyFps: [A] })).toEqual([{ kind: "ssh_host_key", equal: false }]);
  });

  it("a fingerprint is base64: differing only in case is a different key (it is not lower-cased for the comparison)", () => {
    expect(identityEvidence({ sshHostKeyFp: A }, { sshHostKeyFp: a })).toEqual([{ kind: "ssh_host_key", equal: false }]);
    expect(identityEvidence({ sshHostKeyFp: ` ${A} ` }, { sshHostKeyFp: A })).toEqual([{ kind: "ssh_host_key", equal: true }]);
  });

  it("says nothing when one side reports no key, and the matcher then confirms by the key list alone", () => {
    expect(identityEvidence({ sshHostKeyFp: A }, {})).toEqual([]);
    expect(identityEvidence({ sshHostKeyFp: A }, { sshHostKeyFps: [] })).toEqual([]);
    const v = one(cool("c1", null, { facts: { sshHostKeyFp: B } }), [tugra("a1", { facts: { sshHostKeyFp: A, sshHostKeyFps: [A, B] } }), tugra("b1", { facts: { sshHostKeyFp: A, sshHostKeyFps: [A] } })]);
    expect(v).toMatchObject({ status: "certain", tugraServerId: "a1" });
  });
});

