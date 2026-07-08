import { observedIp, isIpv6 } from "./observed-ip";

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
