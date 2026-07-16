import { ipMatchesAllowlist, isValidIpOrCidr, ipToBig } from "./ip-allowlist";

describe("ipToBig", () => {
  it("parses IPv4 and IPv6 into family-tagged bigints", () => {
    expect(ipToBig("1.2.3.4")).toEqual({ version: 4, bits: 0x01020304n });
    expect(ipToBig("::1")).toEqual({ version: 6, bits: 1n });
    expect(ipToBig("2001:db8::1")).toEqual({ version: 6, bits: 0x20010db8000000000000000000000001n });
  });
  it("folds IPv4-mapped IPv6 to IPv4", () => {
    expect(ipToBig("::ffff:1.2.3.4")).toEqual({ version: 4, bits: 0x01020304n });
  });
  it("rejects garbage", () => {
    for (const bad of ["", "nope", "1.2.3", "1.2.3.256", "::gg", "999.1.1.1"]) expect(ipToBig(bad)).toBeNull();
  });
});

describe("isValidIpOrCidr", () => {
  it("accepts single IPs and CIDRs in range", () => {
    for (const ok of ["1.2.3.4", "10.0.0.0/8", "192.168.1.0/24", "::1", "2001:db8::/32", "0.0.0.0/0", "1.2.3.4/32"]) {
      expect(isValidIpOrCidr(ok)).toBe(true);
    }
  });
  it("rejects malformed entries and out-of-range prefixes", () => {
    for (const bad of ["", "  ", "1.2.3.4/33", "::1/129", "1.2.3.4/", "10.0.0.0/-1", "abc/24", "1.2.3.256", "10/8"]) {
      expect(isValidIpOrCidr(bad)).toBe(false);
    }
  });
});

describe("ipMatchesAllowlist — single IPs", () => {
  it("matches an exact IPv4/IPv6 and rejects others", () => {
    expect(ipMatchesAllowlist("1.2.3.4", ["1.2.3.4"])).toBe(true);
    expect(ipMatchesAllowlist("1.2.3.5", ["1.2.3.4"])).toBe(false);
    expect(ipMatchesAllowlist("::1", ["::1"])).toBe(true);
    // a mapped client matches a plain-IPv4 entry (same space)
    expect(ipMatchesAllowlist("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
  });
  it("never cross-matches families", () => {
    expect(ipMatchesAllowlist("::1", ["1.2.3.4"])).toBe(false);
    expect(ipMatchesAllowlist("1.2.3.4", ["::1"])).toBe(false);
  });
});

describe("ipMatchesAllowlist — CIDR ranges", () => {
  it("matches IPv4 CIDRs by prefix", () => {
    expect(ipMatchesAllowlist("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("192.168.1.50", ["192.168.1.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("192.168.2.50", ["192.168.1.0/24"])).toBe(false);
  });
  it("honours /32 (exact) and /0 (match-all) boundaries", () => {
    expect(ipMatchesAllowlist("8.8.8.8", ["8.8.8.8/32"])).toBe(true);
    expect(ipMatchesAllowlist("8.8.8.9", ["8.8.8.8/32"])).toBe(false);
    expect(ipMatchesAllowlist("203.0.113.7", ["0.0.0.0/0"])).toBe(true);
  });
  it("matches IPv6 CIDRs by prefix", () => {
    expect(ipMatchesAllowlist("2001:db8::abcd", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipMatchesAllowlist("::1", ["::/0"])).toBe(true);
  });
  it("does not cross-match a v4 client against a v6 CIDR (and vice-versa)", () => {
    expect(ipMatchesAllowlist("10.0.0.1", ["2001:db8::/32"])).toBe(false);
    expect(ipMatchesAllowlist("2001:db8::1", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("ipMatchesAllowlist — robustness (no accidental match-all)", () => {
  it("skips malformed entries without matching or throwing", () => {
    expect(ipMatchesAllowlist("1.2.3.4", ["garbage", "", "  ", "1.2.3.4/99", "not/an/ip"])).toBe(false);
    // a valid entry alongside malformed ones still matches
    expect(ipMatchesAllowlist("1.2.3.4", ["garbage", "1.2.3.4"])).toBe(true);
  });
  it("returns false for an empty allowlist or an unparseable client IP", () => {
    expect(ipMatchesAllowlist("1.2.3.4", [])).toBe(false);
    expect(ipMatchesAllowlist("not-an-ip", ["0.0.0.0/0"])).toBe(false);
  });
});
