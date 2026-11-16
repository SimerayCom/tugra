import {
  isCloudflareEdgeIp,
  isTrustedProxyPeer,
  parseCfConnectingIp,
  resolveClientIp,
  sanitizeForwardedChain,
  type ClientIpPolicy,
} from "./client-ip";
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES, CLOUDFLARE_IPS_FETCHED_AT } from "./cloudflare-ips";

const CF_EDGE = "104.16.1.1"; // inside 104.16.0.0/13
const CF_EDGE6 = "2606:4700:10::1";
const CLIENT = "203.0.113.7";
const base: ClientIpPolicy = { trustProxy: true, strict: false, trustedCidrs: [] };
const cf: ClientIpPolicy = { ...base, cloudflare: true };

describe("vendored Cloudflare ranges", () => {
  it("are valid, dated and non-trivial", () => {
    expect(CLOUDFLARE_IPV4_RANGES.length).toBeGreaterThanOrEqual(10);
    expect(CLOUDFLARE_IPV6_RANGES.length).toBeGreaterThanOrEqual(5);
    expect(CLOUDFLARE_IPS_FETCHED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const r of [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]) {
      expect(r).toMatch(/\/\d+$/);
      expect(r).not.toMatch(/\/0$/);
    }
  });
  it("classifies edge addresses and rejects everything else", () => {
    expect(isCloudflareEdgeIp(CF_EDGE)).toBe(true);
    expect(isCloudflareEdgeIp("173.245.48.9")).toBe(true);
    expect(isCloudflareEdgeIp("131.0.72.1")).toBe(true);
    expect(isCloudflareEdgeIp(CF_EDGE6)).toBe(true);
    expect(isCloudflareEdgeIp("::ffff:104.16.1.1")).toBe(true); // mapped form is judged as its IPv4
    expect(isCloudflareEdgeIp("104.15.255.255")).toBe(false); // one below 104.16.0.0/13
    expect(isCloudflareEdgeIp("104.24.0.1")).toBe(true); // 104.24.0.0/14
    expect(isCloudflareEdgeIp("104.28.0.1")).toBe(false);
    expect(isCloudflareEdgeIp(CLIENT)).toBe(false);
    expect(isCloudflareEdgeIp("10.0.0.1")).toBe(false);
    expect(isCloudflareEdgeIp("not-an-ip")).toBe(false);
    expect(isCloudflareEdgeIp("2606:4701::1")).toBe(false); // outside 2606:4700::/32
  });
  it("honours operator-added extra ranges additively", () => {
    expect(isCloudflareEdgeIp("198.51.100.4")).toBe(false);
    expect(isCloudflareEdgeIp("198.51.100.4", ["198.51.100.0/24"])).toBe(true);
    expect(isCloudflareEdgeIp(CF_EDGE, ["198.51.100.0/24"])).toBe(true);
  });
});

describe("parseCfConnectingIp (strict, fail closed)", () => {
  it("accepts exactly one bare public IP", () => {
    expect(parseCfConnectingIp(CLIENT)).toBe(CLIENT);
    expect(parseCfConnectingIp(" 2001:db8::1 ")).toBe("2001:db8::1");
    expect(parseCfConnectingIp("::ffff:203.0.113.7")).toBe(CLIENT);
  });
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["list", "203.0.113.7, 198.51.100.1"],
    ["repeated header lines", ["203.0.113.7", "198.51.100.1"]],
    ["with port", "203.0.113.7:443"],
    ["bracketed v6", "[2001:db8::1]"],
    ["hostname", "evil.example"],
    ["free text", "unknown"],
    ["loopback", "127.0.0.1"],
    ["private", "10.0.0.5"],
    ["link-local", "169.254.169.254"],
    ["ula", "fd00::1"],
    ["unspecified", "0.0.0.0"],
    ["injection", "1.2.3.4\r\nX-Evil: 1"],
  ])("rejects %s", (_n, v) => {
    expect(parseCfConnectingIp(v as string | string[] | undefined)).toBeNull();
  });
});

describe("isTrustedProxyPeer", () => {
  it("trusts private/loopback peers by default, never a public one", () => {
    expect(isTrustedProxyPeer("172.18.0.5", base)).toBe(true);
    expect(isTrustedProxyPeer("127.0.0.1", base)).toBe(true);
    expect(isTrustedProxyPeer("::ffff:10.0.0.2", base)).toBe(true);
    expect(isTrustedProxyPeer(CLIENT, base)).toBe(false);
    expect(isTrustedProxyPeer(CF_EDGE, base)).toBe(false);
    expect(isTrustedProxyPeer(undefined, base)).toBe(false);
    expect(isTrustedProxyPeer("garbage", base)).toBe(false);
  });
  it("trusts listed public peers; strict trusts ONLY listed peers", () => {
    const listed = { ...base, trustedCidrs: ["198.51.100.0/24"] };
    expect(isTrustedProxyPeer("198.51.100.9", listed)).toBe(true);
    expect(isTrustedProxyPeer("172.18.0.5", listed)).toBe(true);
    expect(isTrustedProxyPeer("172.18.0.5", { ...listed, strict: true })).toBe(false);
    expect(isTrustedProxyPeer("198.51.100.9", { ...listed, strict: true })).toBe(true);
    expect(isTrustedProxyPeer("172.18.0.5", { ...base, strict: true })).toBe(false);
  });
});

describe("resolveClientIp", () => {
  it("uses the raw peer when no proxy is declared, ignoring every header", () => {
    const off = { ...base, trustProxy: false, cloudflare: true };
    expect(resolveClientIp(CLIENT, "6.6.6.6", "7.7.7.7", off)).toBe(CLIENT);
    expect(resolveClientIp("::ffff:203.0.113.7", "6.6.6.6", undefined, off)).toBe(CLIENT);
  });
  it("takes the rightmost X-Forwarded-For entry from a trusted peer (leftmost is client-supplied)", () => {
    expect(resolveClientIp("172.18.0.5", `6.6.6.6, ${CLIENT}`, undefined, base)).toBe(CLIENT);
  });
  it("ignores X-Forwarded-For from a public (untrusted) peer", () => {
    expect(resolveClientIp(CLIENT, "6.6.6.6", undefined, base)).toBe(CLIENT);
  });
  it("fails closed on a malformed rightmost entry", () => {
    expect(resolveClientIp("172.18.0.5", "6.6.6.6, unknown", undefined, base)).toBeNull();
  });

  describe("cloudflare mode", () => {
    it("uses CF-Connecting-IP when the observed hop is a Cloudflare edge", () => {
      expect(resolveClientIp("172.18.0.5", CF_EDGE, CLIENT, cf)).toBe(CLIENT);
      expect(resolveClientIp("172.18.0.5", CF_EDGE6, "2001:db8::9", cf)).toBe("2001:db8::9");
    });
    it("ignores a forged CF-Connecting-IP when the observed hop is NOT a Cloudflare edge", () => {
      // attacker reaches the origin without going through Cloudflare
      expect(resolveClientIp("172.18.0.5", "198.51.100.77", "1.1.1.1", cf)).toBe("198.51.100.77");
    });
    it("a client-supplied leftmost X-Forwarded-For can never impersonate a Cloudflare edge", () => {
      expect(resolveClientIp("172.18.0.5", `${CF_EDGE}, 198.51.100.77`, "1.1.1.1", cf)).toBe("198.51.100.77");
    });
    it("fails closed (null, never the edge address) when the header is missing or malformed behind a Cloudflare edge", () => {
      expect(resolveClientIp("172.18.0.5", CF_EDGE, undefined, cf)).toBeNull();
      expect(resolveClientIp("172.18.0.5", CF_EDGE, "1.1.1.1, 2.2.2.2", cf)).toBeNull();
      expect(resolveClientIp("172.18.0.5", CF_EDGE, ["1.1.1.1", "2.2.2.2"], cf)).toBeNull();
      expect(resolveClientIp("172.18.0.5", CF_EDGE, "10.0.0.1", cf)).toBeNull();
    });
    it("ignores CF-Connecting-IP entirely when the TCP peer is not a trusted proxy (direct public hit)", () => {
      // peer claims to be Cloudflare-range but is a public address that is not a listed proxy
      expect(resolveClientIp(CF_EDGE, CF_EDGE, "1.1.1.1", cf)).toBe(CF_EDGE);
      expect(resolveClientIp(CLIENT, CF_EDGE, "1.1.1.1", cf)).toBe(CLIENT);
    });
    it("strict mode still requires the peer to be a listed proxy", () => {
      const strict: ClientIpPolicy = { ...cf, strict: true, trustedCidrs: ["172.18.0.0/16"] };
      expect(resolveClientIp("172.18.0.5", CF_EDGE, CLIENT, strict)).toBe(CLIENT);
      expect(resolveClientIp("10.9.9.9", CF_EDGE, CLIENT, strict)).toBe("10.9.9.9");
    });
    it("is inert when cloudflare mode is off", () => {
      expect(resolveClientIp("172.18.0.5", CF_EDGE, CLIENT, base)).toBe(CF_EDGE);
    });
    it("extra ranges extend the edge set", () => {
      const extra = { ...cf, cloudflareExtraCidrs: ["198.51.100.0/24"] };
      expect(resolveClientIp("172.18.0.5", "198.51.100.4", CLIENT, extra)).toBe(CLIENT);
    });
  });
});

describe("sanitizeForwardedChain (the web hop)", () => {
  it("collapses a trusted proxy's chain to the one entry it observed", () => {
    expect(sanitizeForwardedChain("172.18.0.5", `6.6.6.6, ${CLIENT}`, base)).toEqual({ forwardedFor: CLIENT, keepCfConnectingIp: true });
  });
  it("replaces a forged chain from an untrusted public peer with the socket address and drops CF-Connecting-IP", () => {
    expect(sanitizeForwardedChain(CLIENT, "6.6.6.6", base)).toEqual({ forwardedFor: CLIENT, keepCfConnectingIp: false });
  });
  it("uses the socket address when a trusted peer sent no chain", () => {
    expect(sanitizeForwardedChain("172.18.0.5", undefined, base)).toEqual({ forwardedFor: "172.18.0.5", keepCfConnectingIp: false });
  });
  it("turns a malformed chain from a trusted peer into 'unknown' (the hub then refuses it)", () => {
    expect(sanitizeForwardedChain("172.18.0.5", "6.6.6.6, bogus", base).forwardedFor).toBe("unknown");
  });
  it("ignores the chain entirely when no proxy is declared", () => {
    expect(sanitizeForwardedChain("172.18.0.5", CLIENT, { ...base, trustProxy: false })).toEqual({ forwardedFor: "172.18.0.5", keepCfConnectingIp: false });
  });
  it("strict mode: an unlisted private peer cannot speak for a client", () => {
    const strict = { ...base, strict: true, trustedCidrs: ["172.18.0.0/16"] };
    expect(sanitizeForwardedChain("10.9.9.9", "6.6.6.6", strict).forwardedFor).toBe("10.9.9.9");
    expect(sanitizeForwardedChain("172.18.0.5", "6.6.6.6", strict).forwardedFor).toBe("6.6.6.6");
  });
  it("fails closed on a missing or invalid socket address", () => {
    expect(sanitizeForwardedChain(undefined, CLIENT, base)).toEqual({ forwardedFor: "unknown", keepCfConnectingIp: false });
    expect(sanitizeForwardedChain("nope", CLIENT, base).forwardedFor).toBe("unknown");
  });
  it("round-trips with resolveClientIp: forged inputs at the web hop never reach the hub as a client IP", () => {
    // Attacker (public) hits the web port directly with forged headers.
    const c = sanitizeForwardedChain(CLIENT, `${CF_EDGE}`, cf);
    expect(resolveClientIp("172.18.0.9", c.forwardedFor, c.keepCfConnectingIp ? "1.1.1.1" : undefined, cf)).toBe(CLIENT);
  });
});
