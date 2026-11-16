// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clientIpPolicyFromEnv, guardForwardedHeaders } from "../../server/forwarded-guard.mjs";

type Headers = Record<string, string | string[] | undefined>;
const req = (peer: string | undefined, headers: Headers) => ({ headers: { ...headers }, socket: { remoteAddress: peer } });
const trusted = clientIpPolicyFromEnv({ HUB_TRUSTED_PROXY: "true" });

describe("clientIpPolicyFromEnv", () => {
  it("is off by default and parses the hub's variables", () => {
    expect(clientIpPolicyFromEnv({})).toEqual({ trustProxy: false, strict: false, trustedCidrs: [] });
    expect(clientIpPolicyFromEnv({ HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_STRICT: "true", HUB_TRUSTED_PROXY_CIDRS: "172.18.0.0/16, bad, 2001:db8::/32" })).toEqual({
      trustProxy: true,
      strict: true,
      trustedCidrs: ["172.18.0.0/16", "2001:db8::/32"],
    });
    expect(clientIpPolicyFromEnv({ HUB_TRUSTED_PROXY: "yes" }).trustProxy).toBe(false);
  });
});

describe("guardForwardedHeaders (web hop in front of the hub)", () => {
  it("behind the reverse proxy: keeps only the entry the proxy observed, drops a client-planted leftmost chain", () => {
    const r = req("172.18.0.5", { "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("a direct hit from a public address cannot forge its IP: the chain is replaced by the socket address", () => {
    const r = req("198.51.100.9", { "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "7.7.7.7", "x-real-ip": "5.5.5.5", forwarded: "for=9.9.9.9" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers).toEqual({ "x-forwarded-for": "198.51.100.9" });
  });

  it("an IPv4-mapped IPv6 socket address is folded to its IPv4", () => {
    const r = req("::ffff:198.51.100.9", { "x-forwarded-for": "6.6.6.6" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  it("forwards CF-Connecting-IP only when the trusted proxy chain delivered it; the hub verifies the Cloudflare hop", () => {
    const r = req("172.18.0.5", { "x-forwarded-for": "104.16.1.1", "cf-connecting-ip": "203.0.113.7" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers["x-forwarded-for"]).toBe("104.16.1.1");
    expect(r.headers["cf-connecting-ip"]).toBe("203.0.113.7");
  });

  it("drops X-Real-IP and Forwarded even from a trusted peer", () => {
    const r = req("172.18.0.5", { "x-forwarded-for": "203.0.113.7", "x-real-ip": "5.5.5.5", forwarded: "for=9.9.9.9" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers["x-real-ip"]).toBeUndefined();
    expect(r.headers.forwarded).toBeUndefined();
  });

  it("a trusted peer without a chain is attributed to itself (never to an invented client)", () => {
    const r = req("172.18.0.5", { "cf-connecting-ip": "7.7.7.7" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers).toEqual({ "x-forwarded-for": "172.18.0.5" });
  });

  it("a malformed chain from a trusted peer becomes 'unknown' (the hub then refuses it)", () => {
    const r = req("172.18.0.5", { "x-forwarded-for": "6.6.6.6, not-an-ip" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers["x-forwarded-for"]).toBe("unknown");
  });

  it("repeated X-Forwarded-For header lines are treated as one chain, rightmost wins", () => {
    const r = req("172.18.0.5", { "x-forwarded-for": ["6.6.6.6", "203.0.113.7"] });
    guardForwardedHeaders(r, trusted);
    expect(r.headers["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("no proxy declared: every request is attributed to its socket address", () => {
    const r = req("172.18.0.5", { "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "7.7.7.7" });
    guardForwardedHeaders(r, clientIpPolicyFromEnv({}));
    expect(r.headers).toEqual({ "x-forwarded-for": "172.18.0.5" });
  });

  it("strict mode: a private peer that is not listed cannot speak for a client; a listed one can", () => {
    const strict = clientIpPolicyFromEnv({ HUB_TRUSTED_PROXY: "true", HUB_TRUSTED_PROXY_STRICT: "true", HUB_TRUSTED_PROXY_CIDRS: "172.18.0.0/16" });
    const lan = req("10.9.9.9", { "x-forwarded-for": "6.6.6.6" });
    guardForwardedHeaders(lan, strict);
    expect(lan.headers["x-forwarded-for"]).toBe("10.9.9.9");
    const proxy = req("172.18.0.5", { "x-forwarded-for": "203.0.113.7" });
    guardForwardedHeaders(proxy, strict);
    expect(proxy.headers["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("fails closed on a missing socket address", () => {
    const r = req(undefined, { "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "7.7.7.7" });
    guardForwardedHeaders(r, trusted);
    expect(r.headers).toEqual({ "x-forwarded-for": "unknown" });
  });
});
