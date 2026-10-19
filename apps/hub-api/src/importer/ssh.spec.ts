import { assertAllowedSshTarget } from "./ssh";

describe("assertAllowedSshTarget", () => {
  it("accepts a hostname or public/private IP, defaulting the port to 22", () => {
    expect(assertAllowedSshTarget("coolify.example.com")).toEqual({ host: "coolify.example.com", port: 22 });
    expect(assertAllowedSshTarget("10.0.0.5", 2222)).toEqual({ host: "10.0.0.5", port: 2222 });
    expect(assertAllowedSshTarget("203.0.113.9")).toEqual({ host: "203.0.113.9", port: 22 });
  });

  it("refuses an IP-literal target that is loopback / link-local / metadata", () => {
    for (const h of ["127.0.0.1", "169.254.169.254", "::1", "0.0.0.0"]) {
      expect(() => assertAllowedSshTarget(h)).toThrow(/blocked/);
    }
    expect(() => assertAllowedSshTarget("[::1]", 22)).toThrow(/blocked/); // bracketed form too
  });

  it("rejects a non-host string (URL / metacharacters / empty)", () => {
    for (const h of ["", "http://x", "a b", "a;b", "$(whoami)", "x".repeat(256)]) {
      expect(() => assertAllowedSshTarget(h)).toThrow(/invalid SSH host/);
    }
  });

  it("rejects an ssh-option-shaped host (leading dash → ProxyJump/option injection)", () => {
    for (const h of ["-J127.0.0.1", "-oProxyCommand", "-v", "-4", "-"]) {
      expect(() => assertAllowedSshTarget(h)).toThrow(/invalid SSH host/);
    }
  });

  it("rejects numeric IPv4-disguise hosts that isIP does not recognise (would resolve to a blocked IP)", () => {
    for (const h of ["2130706433", "127.1", "0x7f.0.0.1", "0177.0.0.1", "0x7f000001"]) {
      expect(() => assertAllowedSshTarget(h)).toThrow(/invalid SSH host/);
    }
  });

  it("still accepts legitimate hostnames (incl. leading-0x labels and underscores)", () => {
    expect(assertAllowedSshTarget("0xygen.example.com").host).toBe("0xygen.example.com");
    expect(assertAllowedSshTarget("db_primary.internal").host).toBe("db_primary.internal");
    expect(assertAllowedSshTarget("server1").host).toBe("server1");
  });

  it("rejects an out-of-range port", () => {
    expect(() => assertAllowedSshTarget("host", 0)).toThrow(/invalid SSH port/);
    expect(() => assertAllowedSshTarget("host", 70000)).toThrow(/invalid SSH port/);
    expect(() => assertAllowedSshTarget("host", 1.5)).toThrow(/invalid SSH port/);
  });
});
