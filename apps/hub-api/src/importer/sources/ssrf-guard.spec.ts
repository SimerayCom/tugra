import { isBlockedIp, assertAllowedUrl } from "./ssrf-guard";

describe("isBlockedIp", () => {
  it("blocks loopback, link-local (incl. cloud metadata), and unspecified", () => {
    for (const ip of ["127.0.0.1", "127.255.1.1", "169.254.169.254", "169.254.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00:ec2::254"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("blocks every embedded-IPv4 form of a blocked address (dotted, hex-mapped, compat, NAT64)", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true); // dotted v4-mapped
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true); // hex v4-mapped (how WHATWG URL normalises it)
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true); // hex v4-mapped 169.254.169.254
    expect(isBlockedIp("::127.0.0.1")).toBe(true); // v4-compatible
    expect(isBlockedIp("64:ff9b::7f00:1")).toBe(true); // NAT64 → 127.0.0.1
    expect(isBlockedIp("[::1]")).toBe(true); // bracketed literal
  });
  it("allows public and private (self-hosted) addresses", () => {
    for (const ip of ["1.1.1.1", "203.0.113.5", "10.0.0.5", "172.16.3.4", "192.168.1.10", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
  it("fails closed on a non-IP string", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("assertAllowedUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(assertAllowedUrl("https://coolify.example.com").protocol).toBe("https:");
    expect(assertAllowedUrl("http://10.0.0.5:8000").protocol).toBe("http:");
  });
  it("rejects non-http(s) schemes", () => {
    for (const u of ["file:///etc/passwd", "gopher://x", "ftp://x", "ssh://x"]) expect(() => assertAllowedUrl(u)).toThrow(/http/);
  });
  it("rejects credentials embedded in the URL", () => {
    expect(() => assertAllowedUrl("https://user:pass@coolify.example.com")).toThrow(/credentials/);
  });
  it("rejects an unparseable URL", () => {
    expect(() => assertAllowedUrl("not a url")).toThrow(/invalid URL/);
  });
  it("rejects IP-literal hosts that normalise to a blocked address (the Node lookup-skip bypass)", () => {
    for (const u of ["http://169.254.169.254/", "http://127.0.0.1:5432/", "http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://[::1]/", "http://[::ffff:7f00:1]/"]) {
      expect(() => assertAllowedUrl(u)).toThrow(/blocked/);
    }
  });
  it("still allows a normal public/private host literal", () => {
    expect(assertAllowedUrl("http://10.0.0.5:8000").hostname).toBe("10.0.0.5");
    expect(assertAllowedUrl("https://coolify.example.com").hostname).toBe("coolify.example.com");
  });
});
