import { slugify, dashedIp, magicDomain } from "./magic-domain";

describe("slugify", () => {
  it("lowercases and replaces unsafe runs with a single hyphen", () => {
    expect(slugify("My Cool App!!")).toBe("my-cool-app");
    expect(slugify("a__b  c")).toBe("a-b-c");
  });
  it("collapses consecutive hyphens and strips edge hyphens", () => {
    expect(slugify("--a--b--")).toBe("a-b");
  });
  it("caps length without leaving a trailing hyphen", () => {
    expect(slugify("abcde-fghij", 6)).toBe("abcde"); // "abcde-" → trailing hyphen trimmed
  });
  it("returns empty for a name with no slug-safe characters", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("dashedIp", () => {
  it("dashes an IPv4", () => {
    expect(dashedIp("203.0.113.7")).toBe("203-0-113-7");
  });
  it("dashes an IPv6", () => {
    expect(dashedIp("2001:db8::1")).toBe("2001-db8--1");
  });
});

describe("magicDomain", () => {
  it("builds a sslip.io host from a public IPv4 (deterministic hash)", () => {
    expect(
      magicDomain({ name: "My App", publicIp: "203.0.113.7", hash: "aabbcc" }),
    ).toBe("my-app-aabbcc.203-0-113-7.sslip.io");
  });

  it("uses a per-server wildcard domain when set (no IP needed)", () => {
    expect(
      magicDomain({ name: "api", publicIp: "203.0.113.7", wildcardDomain: "apps.example.com", hash: "aabbcc" }),
    ).toBe("api-aabbcc.apps.example.com");
  });

  it("honors a suffix override (nip.io)", () => {
    expect(magicDomain({ name: "api", publicIp: "203.0.113.7", suffix: "nip.io", hash: "aabbcc" })).toBe(
      "api-aabbcc.203-0-113-7.nip.io",
    );
  });

  it("falls back to the public IPv6 when there is no usable IPv4", () => {
    expect(magicDomain({ name: "api", publicIp: null, publicIpv6: "2001:db8::1", hash: "aabbcc" })).toBe(
      "api-aabbcc.2001-db8--1.sslip.io",
    );
  });

  it("returns null when there is no public IP (loopback / RFC1918 / CGNAT / link-local)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.5", "172.16.0.1", "100.64.0.1", "169.254.1.1"]) {
      expect(magicDomain({ name: "api", publicIp: ip, hash: "aabbcc" })).toBeNull();
    }
    expect(magicDomain({ name: "api", publicIp: null, publicIpv6: "fe80::1", hash: "aabbcc" })).toBeNull();
    expect(magicDomain({ name: "api", publicIp: null, publicIpv6: null, hash: "aabbcc" })).toBeNull();
  });

  it("rejects an IPv4-mapped IPv6 that wraps a private address (SSRF guard)", () => {
    expect(magicDomain({ name: "api", publicIp: null, publicIpv6: "::ffff:169.254.169.254", hash: "aabbcc" })).toBeNull();
    expect(magicDomain({ name: "api", publicIp: null, publicIpv6: "::ffff:10.0.0.1", hash: "aabbcc" })).toBeNull();
  });

  it("normalizes an IPv4-mapped public address to a clean dashed IPv4 label", () => {
    expect(magicDomain({ name: "api", publicIp: null, publicIpv6: "::ffff:8.8.8.8", hash: "aabbcc" })).toBe(
      "api-aabbcc.8-8-8-8.sslip.io",
    );
  });

  it("keeps the DNS label (slug+hash) within 63 chars", () => {
    const long = "a".repeat(80);
    const out = magicDomain({ name: long, publicIp: "203.0.113.7", hash: "aabbcc" })!;
    expect(out.split(".")[0].length).toBeLessThanOrEqual(63);
  });

  it("uses the 'app' fallback slug when the name has no safe characters", () => {
    expect(magicDomain({ name: "!!!", publicIp: "203.0.113.7", hash: "aabbcc" })).toBe(
      "app-aabbcc.203-0-113-7.sslip.io",
    );
  });

  it("reuses an explicit label instead of deriving slug+hash (regeneration keeps the URL stable)", () => {
    // Same label, IP changes → only the IP part moves.
    expect(magicDomain({ name: "ignored", label: "web-a1b2c3", publicIp: "198.51.100.9" })).toBe(
      "web-a1b2c3.198-51-100-9.sslip.io",
    );
    // Same label, moved under a wildcard domain.
    expect(magicDomain({ name: "ignored", label: "web-a1b2c3", publicIp: "198.51.100.9", wildcardDomain: "apps.example.com" })).toBe(
      "web-a1b2c3.apps.example.com",
    );
  });

  it("produces a random 6-hex-char hash when none is injected", () => {
    const out = magicDomain({ name: "api", publicIp: "203.0.113.7" })!;
    expect(out).toMatch(/^api-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);
  });
});
