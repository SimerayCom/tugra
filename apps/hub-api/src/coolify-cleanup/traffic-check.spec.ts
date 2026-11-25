import { checkTraffic } from "./traffic-check";

const TARGET = { ipv4: "203.0.113.10", ipv6: "2001:db8::10" };
function deps(o: { a?: Record<string, string[]>; aaaa?: Record<string, string[]>; ssl?: (ip: string, host: string) => { ok: boolean } | Error } = {}) {
  const ssl = jest.fn(async (ip: string, host: string) => {
    const r = o.ssl ? o.ssl(ip, host) : { ok: true };
    if (r instanceof Error) throw r;
    return r as never;
  });
  return {
    dns: { resolve4: jest.fn(async (h: string) => o.a?.[h] ?? []), resolve6: jest.fn(async (h: string) => o.aaaa?.[h] ?? []) },
    net: { sslAt: ssl },
    ssl,
  };
}

describe("checkTraffic", () => {
  it("cut over: every answer is this server's address and Tugra presents a valid certificate for the name", async () => {
    const d = deps({ a: { "blog.example.com": ["203.0.113.10"] } });
    expect(await checkTraffic(["blog.example.com"], TARGET, d)).toEqual({ "blog.example.com": true });
    expect(d.ssl).toHaveBeenCalledWith("203.0.113.10", "blog.example.com"); // the handshake goes to the server's own stored address
  });

  it("still pointing at Coolify (another address), a mix of old and new, or no answer at all: not cut over, and no handshake is made", async () => {
    const d = deps({ a: { "old.example.com": ["198.51.100.7"], "mix.example.com": ["203.0.113.10", "198.51.100.7"] } });
    expect(await checkTraffic(["old.example.com", "mix.example.com", "none.example.com"], TARGET, d)).toEqual({ "old.example.com": false, "mix.example.com": false, "none.example.com": false });
    expect(d.ssl).not.toHaveBeenCalled();
  });

  it("an address in the right place but no valid certificate (default cert, expired, handshake error) is not cut over", async () => {
    const d1 = deps({ a: { "x.example.com": ["203.0.113.10"] }, ssl: () => ({ ok: false }) });
    expect(await checkTraffic(["x.example.com"], TARGET, d1)).toEqual({ "x.example.com": false });
    const d2 = deps({ a: { "x.example.com": ["203.0.113.10"] }, ssl: () => new Error("refusing to probe a non-public address") });
    expect(await checkTraffic(["x.example.com"], TARGET, d2)).toEqual({ "x.example.com": false });
  });

  it("an IPv6-only answer matching the server's IPv6 counts; a literal IP as a hostname and a server without an address never do", async () => {
    const d = deps({ aaaa: { "v6.example.com": ["2001:DB8::10"] } });
    expect(await checkTraffic(["v6.example.com"], TARGET, d)).toEqual({ "v6.example.com": true });
    expect(await checkTraffic(["203.0.113.10"], TARGET, d)).toEqual({ "203.0.113.10": false });
    expect(await checkTraffic(["v6.example.com"], { ipv4: null, ipv6: null }, d)).toEqual({ "v6.example.com": false });
  });

  it("a failing lookup is not cut over, never an exception", async () => {
    const d = deps();
    d.dns.resolve4.mockRejectedValue(new Error("SERVFAIL"));
    expect(await checkTraffic(["a.example.com"], TARGET, d)).toEqual({ "a.example.com": false });
  });

  it("more than 100 hostnames: the rest count as not cut over instead of being skipped as fine", async () => {
    const hosts = Array.from({ length: 105 }, (_, i) => `h${i}.example.com`);
    const a = Object.fromEntries(hosts.map((h) => [h, ["203.0.113.10"]]));
    const out = await checkTraffic(hosts, TARGET, deps({ a }));
    expect(Object.values(out).filter(Boolean)).toHaveLength(100);
    expect(out["h104.example.com"]).toBe(false);
  });
});
