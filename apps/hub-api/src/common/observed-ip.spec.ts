import { observedIp, isIpv6, isLoopbackIp, isPublicIp, bestReportedIp, reconcileReportedIp } from "./observed-ip";

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
});

describe("bestReportedIp", () => {
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
});

describe("reconcileReportedIp", () => {
  it("keeps a good observed egress IP (no change)", () => {
    expect(reconcileReportedIp({ publicIp: "203.0.113.7", ipSource: "observed" }, ["10.0.0.5"])).toBeNull();
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
