import { defaultTeamFor, sameHost, sshHint, uniqueNames } from "./coolify-install-plan";

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
  const s = { publicIp: "198.51.100.7", publicIpv6: null, hostname: "Edge.Example.com", reportedIps: ["10.0.0.5"] };
  it("matches on address or hostname, ignoring case", () => {
    expect(sameHost("198.51.100.7", s)).toBe(true);
    expect(sameHost("edge.example.com", s)).toBe(true);
    expect(sameHost("10.0.0.5", s)).toBe(true);
    expect(sameHost("198.51.100.8", s)).toBe(false);
    expect(sameHost("", s)).toBe(false);
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
