import { defaultTeamFor, findHostMatch, isPublicAddress, normalizeAddress, sameHost, sshHint, uniqueNames } from "./coolify-install-plan";

describe("sshHint", () => {
  it("prints a plain ssh line, with the port only when it is not 22", () => {
    expect(sshHint({ ip: "203.0.113.7", port: 22, user: "root" })).toBe("ssh root@203.0.113.7");
    expect(sshHint({ ip: "203.0.113.7", port: 2222, user: "deploy" })).toBe("ssh -p 2222 deploy@203.0.113.7");
    expect(sshHint({ ip: "2001:db8::1", port: 22, user: "root" })).toBe("ssh root@[2001:db8::1]");
  });

  it("never lets a shell metacharacter into the display line", () => {
    expect(sshHint({ ip: "1.2.3.4; rm -rf /", port: 22, user: "root$(x)" })).toBe("ssh root@<host>");
    expect(sshHint({ ip: "1.2.3.4", port: 99999, user: "root" })).toBe("ssh root@1.2.3.4");
  });
});

describe("uniqueNames", () => {
  it("keeps order and makes duplicates distinct (case-insensitive)", () => {
    expect(uniqueNames(["edge", "Edge", " edge ", "", "app"])).toEqual(["edge", "Edge (2)", "edge (3)", "Server", "app"]);
  });
});

describe("sameHost", () => {
  const none = { publicIp: null, publicIpv6: null, hostname: null, reportedIps: [] as string[] };
  const s = { publicIp: "198.51.100.7", publicIpv6: null, hostname: "Edge.Example.com", reportedIps: ["10.0.0.5"] };
  it("matches on a public address or host name, ignoring case", () => {
    expect(sameHost("198.51.100.7", s)).toBe(true);
    expect(sameHost("edge.example.com", s)).toBe(true);
    expect(sameHost("EDGE.example.com.", s)).toBe(true);
    expect(sameHost("198.51.100.8", s)).toBe(false);
    expect(sameHost("", s)).toBe(false);
  });
  it("never matches on a private address two machines can share", () => {
    expect(sameHost("10.0.0.5", s)).toBe(false);
    expect(sameHost("172.17.0.1", { ...none, reportedIps: ["172.17.0.1"] })).toBe(false);
    expect(sameHost("192.168.1.10", { ...none, reportedIps: ["192.168.1.10"] })).toBe(false);
    expect(sameHost("127.0.0.1", { ...none, reportedIps: ["127.0.0.1"] })).toBe(false);
  });
  it("never matches on a Tailscale or CGNAT address", () => {
    expect(sameHost("100.101.102.103", { ...none, reportedIps: ["100.101.102.103"] })).toBe(false);
    expect(sameHost("100.64.0.1", { ...none, reportedIps: ["100.64.0.1"] })).toBe(false);
    expect(sameHost("100.63.0.1", { ...none, reportedIps: ["100.63.0.1"] })).toBe(true);
  });
  it("compares IPv6 in its expanded form and refuses unique-local and link-local ones", () => {
    const v6 = { ...none, publicIpv6: "2001:0db8::0001", reportedIps: ["fd00::1", "fe80::1"] };
    expect(sameHost("2001:db8::1", v6)).toBe(true);
    expect(sameHost("[2001:DB8:0:0:0:0:0:1]", v6)).toBe(true);
    expect(sameHost("fd00::1", v6)).toBe(false);
    expect(sameHost("fe80::1", v6)).toBe(false);
    expect(sameHost("::1", { ...none, reportedIps: ["::1"] })).toBe(false);
  });
  it("does not match a bare machine name", () => {
    expect(sameHost("ubuntu", { ...none, hostname: "ubuntu" })).toBe(false);
    expect(sameHost("localhost", { ...none, hostname: "localhost" })).toBe(false);
  });
});

describe("normalizeAddress and isPublicAddress", () => {
  it("normalises IPv6 and IPv4-mapped forms", () => {
    expect(normalizeAddress("2001:DB8::1")).toBe("2001:db8:0:0:0:0:0:1");
    expect(normalizeAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(normalizeAddress("  ")).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
  });
  it("tells public addresses from shared ones", () => {
    for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.1", "100.100.1.1", "169.254.1.1", "127.0.0.1", "0.0.0.0", "fd12::1", "fe80::2", "::1", "::ffff:10.0.0.1"]) expect(isPublicAddress(a)).toBe(false);
    for (const a of ["8.8.8.8", "172.32.0.1", "198.51.100.7", "2001:db8::1", "edge.example.com"]) expect(isPublicAddress(a)).toBe(true);
  });
});

describe("findHostMatch", () => {
  const mk = (id: string, publicIp: string | null, reportedIps: string[] = []) => ({ id, publicIp, publicIpv6: null, hostname: null, reportedIps });
  it("returns the one server at the address", () => {
    const r = findHostMatch("198.51.100.7", [mk("a", "198.51.100.7"), mk("b", "198.51.100.9")]);
    expect(r.match?.id).toBe("a");
    expect(r.ambiguous).toBe(false);
  });
  it("is ambiguous, with no match, when two servers sit at the address", () => {
    const r = findHostMatch("198.51.100.7", [mk("a", "198.51.100.7"), mk("b", null, ["198.51.100.7"])]);
    expect(r).toEqual({ match: null, ambiguous: true });
  });
  it("does not tie two machines that share a private address", () => {
    expect(findHostMatch("10.0.0.5", [mk("a", "198.51.100.7", ["10.0.0.5"]), mk("b", "203.0.113.4", ["10.0.0.5"])])).toEqual({ match: null, ambiguous: false });
  });
});

describe("defaultTeamFor", () => {
  const coolify = [{ id: "1", name: "Acme" }];
  const tugra = [{ id: "tA", name: "acme " }, { id: "tB", name: "Other" }];
  it("picks the Tugra team with the same name, else the fallback", () => {
    expect(defaultTeamFor("1", coolify, tugra, "tB")).toBe("tA");
    expect(defaultTeamFor("9", coolify, tugra, "tB")).toBe("tB");
    expect(defaultTeamFor(null, coolify, tugra, "tB")).toBe("tB");
  });
});
