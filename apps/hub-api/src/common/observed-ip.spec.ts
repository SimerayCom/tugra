import {
  observedIp,
  isIpv6,
  isLoopbackIp,
  isPublicIp,
  bestReportedIp,
  reconcileReportedIp,
  isSsrfSafeIp,
  isAlwaysBlockedIp,
  isPrivateNetworkIp,
  observedPublicIpFromUrl,
} from "./observed-ip";

describe("observedPublicIpFromUrl", () => {
  it("returns a public IPv4 host (port stripped)", () => {
    expect(observedPublicIpFromUrl("http://203.0.113.9:3001")).toBe("203.0.113.9");
    expect(observedPublicIpFromUrl("https://8.8.8.8")).toBe("8.8.8.8");
  });
  it("returns a public IPv6 host (brackets stripped)", () => {
    expect(observedPublicIpFromUrl("http://[2001:db8::1]:3001")).toBe("2001:db8::1");
  });
  it("is null for a DNS name, a private/loopback/link-local IP, or a bad/empty input", () => {
    expect(observedPublicIpFromUrl("https://panel.example.com")).toBeNull();
    expect(observedPublicIpFromUrl("http://127.0.0.1:3001")).toBeNull();
    expect(observedPublicIpFromUrl("http://192.168.1.10:3001")).toBeNull();
    expect(observedPublicIpFromUrl("http://169.254.169.254")).toBeNull(); // link-local / metadata
    expect(observedPublicIpFromUrl("not a url")).toBeNull();
    expect(observedPublicIpFromUrl(undefined)).toBeNull();
    expect(observedPublicIpFromUrl("")).toBeNull();
  });
});

describe("observedIp", () => {
  it("uses the raw TCP peer address by default", () => {
    expect(observedIp("203.0.113.7", "10.0.0.1", false)).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For unless a trusted proxy is configured", () => {
    // trustProxy=false: the forwarded header is not trusted (spoofable).
    expect(observedIp("198.51.100.9", "1.2.3.4", false)).toBe("198.51.100.9");
  });

  it("takes the rightmost (proxy-appended) X-Forwarded-For entry when trusted", () => {
    // Leftmost entries are client-supplied/spoofable; the trusted proxy appends
    // the peer it actually saw as the last entry.
    expect(observedIp("10.0.0.1", "203.0.113.7, 198.51.100.9", true)).toBe("198.51.100.9");
    expect(observedIp("10.0.0.1", "198.51.100.9", true)).toBe("198.51.100.9"); // single hop
  });

  it("normalizes IPv4-mapped IPv6", () => {
    expect(observedIp("::ffff:192.0.2.5", null, false)).toBe("192.0.2.5");
  });

  it("preserves a real IPv6 address", () => {
    expect(observedIp("2001:db8::1", null, false)).toBe("2001:db8::1");
  });

  it("returns null when nothing usable is present", () => {
    expect(observedIp(undefined, undefined, false)).toBeNull();
    expect(observedIp("", "", false)).toBeNull();
    expect(observedIp(null, "1.2.3.4", false)).toBeNull(); // xff ignored, no peer
  });

  it("falls back to the peer when trusted-proxy is on but no header present", () => {
    expect(observedIp("203.0.113.7", undefined, true)).toBe("203.0.113.7");
  });
});

describe("isIpv6", () => {
  it("classifies by the presence of a colon", () => {
    expect(isIpv6("2001:db8::1")).toBe(true);
    expect(isIpv6("::1")).toBe(true);
    expect(isIpv6("203.0.113.7")).toBe(false);
  });
});

describe("isLoopbackIp", () => {
  it("recognizes IPv4 and IPv6 loopback", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("127.5.5.5")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("203.0.113.7")).toBe(false);
    expect(isLoopbackIp("192.168.1.5")).toBe(false);
  });
});

describe("isPublicIp", () => {
  it("accepts globally-routable IPv4 and IPv6", () => {
    expect(isPublicIp("203.0.113.7")).toBe(true);
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2001:db8::1")).toBe(true);
  });
  it("rejects loopback, RFC1918, CGNAT and link-local IPv4", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.5", "172.16.0.1", "172.31.255.1", "100.64.0.1", "100.127.0.1", "169.254.1.1"]) {
      expect(isPublicIp(ip)).toBe(false);
    }
  });
  it("rejects loopback, link-local (full fe80::/10) and ULA IPv6, and the unspecified addresses", () => {
    for (const ip of ["::1", "fe80::1", "fe90::1", "fea0::1", "febf::1", "fc00::1", "fd12:3456::1", "::", "0.0.0.0"]) {
      expect(isPublicIp(ip)).toBe(false);
    }
  });
  it("judges an IPv4-mapped IPv6 as its IPv4 (SSRF guard — mapped private/link-local rejected)", () => {
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicIp("::ffff:192.168.1.5")).toBe(false);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true); // mapped public IPv4 is fine
  });
  it("treats public-adjacent IPv4 (100.128+, 172.32) as public", () => {
    expect(isPublicIp("100.128.0.1")).toBe(true); // just outside CGNAT
    expect(isPublicIp("172.32.0.1")).toBe(true); // just outside RFC1918
  });
  it("rejects a malformed / non-IP string (not just out-of-range) so it is never trusted as an address", () => {
    for (const bad of ["", "not-an-ip", "203.0.113.7\n      - EXTRA=pwned", "203.0.113.7 8080", "203.0.113.256", "1.2.3", "::ffff:garbage", "http://203.0.113.7"]) {
      expect(isPublicIp(bad)).toBe(false);
    }
  });
});

describe("SSRF address policy (isSsrfSafeIp / isAlwaysBlockedIp / isPrivateNetworkIp)", () => {
  const ALWAYS_BLOCKED = [
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "0.1.2.3", // 0.0.0.0/8
    "255.255.255.255", // broadcast
    "169.254.169.254", // cloud metadata
    "169.254.1.1", // link-local
    "::ffff:169.254.169.254", // mapped metadata
    "224.0.0.1", // multicast
    "239.255.255.250", // multicast (SSDP)
    "64:ff9b::1", // NAT64
    "::7f00:1", // IPv4-compatible loopback
    "::ffff:7f00:1", // hex form of a mapped address
    "fd00:ec2::254", // AWS IPv6 instance metadata (ULA carve-out)
    "fd00:0ec2:0:0:0:0:0:254", // ...same, expanded/zero-padded notation
    "fe80::1", // IPv6 link-local
    "ff02::1", // IPv6 multicast
    "::", // unspecified
    "not-an-ip", // fail closed
  ];
  const PRIVATE = ["10.0.0.5", "192.168.1.5", "172.16.0.1", "100.64.0.1", "fd12:3456::1", "fc00::1"];
  const PUBLIC = ["8.8.8.8", "203.0.113.7", "2001:db8::1", "::ffff:8.8.8.8"];

  it("always blocks metadata/loopback/link-local/multicast/broadcast/nat64 regardless of policy", () => {
    for (const ip of ALWAYS_BLOCKED) {
      expect(isAlwaysBlockedIp(ip)).toBe(true);
      expect(isSsrfSafeIp(ip, false)).toBe(false);
      expect(isSsrfSafeIp(ip, true)).toBe(false); // allowPrivate does NOT unblock these
    }
  });

  it("blocks private/CGNAT/ULA by default, allows them only when allowPrivate is set", () => {
    for (const ip of PRIVATE) {
      expect(isPrivateNetworkIp(ip)).toBe(true);
      expect(isAlwaysBlockedIp(ip)).toBe(false);
      expect(isSsrfSafeIp(ip, false)).toBe(false);
      expect(isSsrfSafeIp(ip, true)).toBe(true);
    }
  });

  it("accepts globally-routable addresses under both policies", () => {
    for (const ip of PUBLIC) {
      expect(isSsrfSafeIp(ip, false)).toBe(true);
      expect(isSsrfSafeIp(ip, true)).toBe(true);
    }
  });
});

describe("bestReportedIp", () => {
  it("ignores a malformed (non-IP) reported candidate", () => {
    expect(bestReportedIp(["not-an-ip", "203.0.113.7\nx", "8.8.8.8"])).toBe("8.8.8.8");
    expect(bestReportedIp(["garbage"])).toBeNull();
  });

  it("prefers a public IPv4 over a private one", () => {
    expect(bestReportedIp(["10.0.0.5", "203.0.113.7"])).toBe("203.0.113.7");
  });
  it("falls back to a private IPv4 when no public one exists", () => {
    expect(bestReportedIp(["192.168.1.5", "2001:db8::1"])).toBe("192.168.1.5");
  });
  it("takes an IPv6 only when no IPv4 candidate exists", () => {
    expect(bestReportedIp(["2001:db8::1"])).toBe("2001:db8::1");
  });
  it("normalizes an IPv4-mapped IPv6 to its IPv4 (not misfiled as IPv6)", () => {
    expect(bestReportedIp(["::ffff:203.0.113.7"])).toBe("203.0.113.7");
  });
  it("skips loopback and returns null for an empty/loopback-only set", () => {
    expect(bestReportedIp(["127.0.0.1", "::1"])).toBeNull();
    expect(bestReportedIp([])).toBeNull();
  });
  it("prefers a real LAN IPv4 over a docker-bridge 172.x, regardless of order (home-box reachability)", () => {
    expect(bestReportedIp(["172.17.0.1", "192.168.1.50"])).toBe("192.168.1.50");
    expect(bestReportedIp(["192.168.1.50", "172.17.0.1"])).toBe("192.168.1.50");
    expect(bestReportedIp(["172.18.0.1", "10.0.0.5"])).toBe("10.0.0.5");
  });
  it("still uses a docker-bridge 172.x when it is the only candidate", () => {
    expect(bestReportedIp(["172.17.0.1"])).toBe("172.17.0.1");
  });
  it("a public IPv4 still beats everything, incl. a real LAN IP", () => {
    expect(bestReportedIp(["192.168.1.50", "172.17.0.1", "203.0.113.7"])).toBe("203.0.113.7");
  });
});

describe("reconcileReportedIp", () => {
  it("keeps a good observed egress IP (no change)", () => {
    expect(reconcileReportedIp({ publicIp: "203.0.113.7", ipSource: "observed" }, ["10.0.0.5"])).toBeNull();
  });
  it("repairs a local server's docker-bridge observed IP from a reported public IP", () => {
    // A single-box agent's in-container source IP (172.18.x) was wrongly recorded as the public IP; it is
    // never reachable, so for the LOCAL server a reported real address must replace it.
    expect(reconcileReportedIp({ publicIp: "172.18.0.7", ipSource: "observed" }, ["203.0.113.7"], true)).toEqual({
      publicIp: "203.0.113.7",
      ipSource: "reported",
    });
  });
  it("repairs a local docker-bridge IP from a real LAN interface over another bridge IP", () => {
    expect(
      reconcileReportedIp({ publicIp: "172.18.0.7", ipSource: "observed" }, ["172.17.0.1", "192.168.1.5"], true),
    ).toEqual({ publicIp: "192.168.1.5", ipSource: "reported" });
  });
  it("never (re)stores a docker-bridge address for a local server that reports only bridges", () => {
    // A containerized agent whose only interface is the bridge must not land back on 172.x via the last-resort
    // fallback — leave publicIp unset so the install-time manual pin / UI is the only source.
    expect(reconcileReportedIp({ publicIp: "172.18.0.7", ipSource: "observed" }, ["172.17.0.1"], true)).toBeNull();
    expect(reconcileReportedIp({ publicIp: null, ipSource: "observed" }, ["172.18.0.9"], true)).toBeNull();
  });
  it("keeps a remote server's observed 172.x (same-VPC/LAN is reachable there — not docker-bridge filtered)", () => {
    // isLocal defaults false: a remote agent connecting over a 172.16/12 VPC keeps its reachable address.
    expect(reconcileReportedIp({ publicIp: "172.31.5.9", ipSource: "observed" }, ["10.0.0.5"])).toBeNull();
  });
  it("adopts a reported IP when the observed one is loopback", () => {
    expect(reconcileReportedIp({ publicIp: "127.0.0.1", ipSource: "observed" }, ["192.168.1.5"])).toEqual({
      publicIp: "192.168.1.5",
      ipSource: "reported",
    });
  });
  it("adopts a reported IP when there is no observed IP yet", () => {
    expect(reconcileReportedIp({ publicIp: null, ipSource: "observed" }, ["203.0.113.7"])).toEqual({
      publicIp: "203.0.113.7",
      ipSource: "reported",
    });
  });
  it("routes an IPv6-only reported candidate to publicIpv6, not the IPv4 column", () => {
    expect(reconcileReportedIp({ publicIp: null, ipSource: "observed" }, ["2001:db8::1"])).toEqual({
      publicIpv6: "2001:db8::1",
    });
  });
  it("never overrides a manual pin", () => {
    expect(reconcileReportedIp({ publicIp: "127.0.0.1", ipSource: "manual" }, ["203.0.113.7"])).toBeNull();
  });
  it("refreshes a previously-reported IP when the interface IP changes", () => {
    expect(reconcileReportedIp({ publicIp: "192.168.1.5", ipSource: "reported" }, ["192.168.1.9"])).toEqual({
      publicIp: "192.168.1.9",
      ipSource: "reported",
    });
  });
  it("is a no-op when the reported IP is unchanged", () => {
    expect(reconcileReportedIp({ publicIp: "192.168.1.5", ipSource: "reported" }, ["192.168.1.5"])).toBeNull();
  });
  it("returns null when there is no usable reported candidate", () => {
    expect(reconcileReportedIp({ publicIp: null, ipSource: "observed" }, ["127.0.0.1"])).toBeNull();
  });
});
