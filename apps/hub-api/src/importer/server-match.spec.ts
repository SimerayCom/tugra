import { baseUrlHost, comparableAddress, isPrivateAddress, matchTugraServer, type MatchCandidate } from "./server-match";

const srv = (id: string, over: Partial<MatchCandidate> = {}): MatchCandidate => ({ id, name: `srv-${id}`, teamId: "t1", publicIp: null, publicIpv6: null, hostname: null, reportedIps: [], ...over });

describe("isPrivateAddress", () => {
  it("flags RFC 1918, CGNAT, loopback, link-local and IPv6 local ranges; public ones are not", () => {
    for (const a of ["10.0.0.4", "192.168.1.9", "172.16.0.1", "172.31.255.1", "100.64.0.1", "100.127.1.1", "127.0.0.1", "169.254.1.1", "fd00::1", "fe80::1", "::1"]) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ["203.0.113.7", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2001:db8::1", "example.com"]) expect(isPrivateAddress(a)).toBe(false);
  });
});

describe("comparableAddress", () => {
  it("drops an address that names no machine (empty, localhost, docker aliases)", () => {
    for (const a of [undefined, null, "", "  ", "localhost", "host.docker.internal", "127.0.0.1", "::1", "gateway.docker.internal"]) expect(comparableAddress(a)).toBeNull();
    expect(comparableAddress(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(comparableAddress("[2001:DB8::1]")).toBe("2001:db8::1");
  });
});

describe("matchTugraServer", () => {
  it("a public IPv4 equal to the registered public IP is a certain match", () => {
    expect(matchTugraServer("203.0.113.7", [srv("a", { publicIp: "198.51.100.1" }), srv("b", { publicIp: "203.0.113.7" })])).toEqual({ serverId: "b", name: "srv-b", teamId: "t1", via: "public-ip", confidence: "certain" });
  });
  it("matches IPv6 and an address only the agent reports", () => {
    expect(matchTugraServer("2001:db8::5", [srv("a", { publicIpv6: "2001:DB8::5" })])).toMatchObject({ serverId: "a", via: "public-ip", confidence: "certain" });
    expect(matchTugraServer("203.0.113.9", [srv("a", { reportedIps: ["10.0.0.2", "203.0.113.9"] })])).toMatchObject({ serverId: "a", via: "reported-ip", confidence: "certain" });
  });
  it("a private-range match is only probable, because private ranges collide across providers", () => {
    expect(matchTugraServer("10.0.0.5", [srv("a", { publicIp: "10.0.0.5" })])).toMatchObject({ confidence: "probable" });
    expect(matchTugraServer("100.100.1.1", [srv("a", { reportedIps: ["100.100.1.1"] })])).toMatchObject({ via: "reported-ip", confidence: "probable" });
  });
  it("a host name falls back to the registered host name and is probable", () => {
    expect(matchTugraServer("Box.Example.com", [srv("a", { hostname: "box.example.com" })])).toMatchObject({ serverId: "a", via: "hostname", confidence: "probable" });
  });
  it("no match, and nothing for an address that names no machine", () => {
    expect(matchTugraServer("203.0.113.7", [srv("a", { publicIp: "198.51.100.1" })])).toBeNull();
    expect(matchTugraServer("host.docker.internal", [srv("a", { hostname: "host.docker.internal" })])).toBeNull();
    expect(matchTugraServer(undefined, [srv("a")])).toBeNull();
  });
  it("two servers at the same rank are ambiguous (no match); a stronger rank wins over a weaker one", () => {
    expect(matchTugraServer("203.0.113.7", [srv("a", { publicIp: "203.0.113.7" }), srv("b", { publicIp: "203.0.113.7" })])).toBeNull();
    expect(matchTugraServer("203.0.113.7", [srv("a", { reportedIps: ["203.0.113.7"] }), srv("b", { publicIp: "203.0.113.7" })])).toMatchObject({ serverId: "b" });
  });
});

describe("baseUrlHost", () => {
  it("is the host of the URL, lower-cased, or null", () => {
    expect(baseUrlHost("https://Coolify.Example.com:8000/x")).toBe("coolify.example.com");
    expect(baseUrlHost("http://203.0.113.7:8000")).toBe("203.0.113.7");
    expect(baseUrlHost("not a url")).toBeNull();
    expect(baseUrlHost(undefined)).toBeNull();
  });
});
