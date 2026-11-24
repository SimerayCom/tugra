import { fetchErrorCode, realTransport, samplePageAt, type FetchTarget, type PageTransport } from "./preview-fetch";

const page = (body: string, status = 200) => ({ status, contentType: "text/html", location: null, body: Buffer.from(body), truncated: false });

describe("samplePageAt", () => {
  it("reads https first and passes the pinned address through", async () => {
    const seen: FetchTarget[] = [];
    const t: PageTransport = async (x) => { seen.push(x); return page("<title>A</title>"); };
    const s = await samplePageAt("app.example.com", "/", "203.0.113.7", t);
    expect(s.status).toBe(200);
    expect(s.title).toBe("A");
    expect(seen).toEqual([{ host: "app.example.com", path: "/", ip: "203.0.113.7", scheme: "https" }]);
  });
  it("falls back to http only when https did not connect", async () => {
    const t: PageTransport = async (x) => { if (x.scheme === "https") throw new Error("connect ECONNREFUSED"); return page("ok"); };
    expect((await samplePageAt("app.example.com", "/", undefined, t)).status).toBe(200);
  });
  it("never retries over http after a blocked address, and returns a fixed code, not the message", async () => {
    const calls: string[] = [];
    const t: PageTransport = async (x) => { calls.push(x.scheme); throw new Error("SSRF guard: app.example.com resolves to blocked address 127.0.0.1"); };
    const s = await samplePageAt("app.example.com", "/", undefined, t);
    expect(s.error).toBe("blocked-address");
    expect(JSON.stringify(s)).not.toContain("127.0.0.1");
    expect(calls).toEqual(["https"]);
  });
  it("maps a timeout and anything else to fixed codes", async () => {
    expect((await samplePageAt("a.example.com", "/", undefined, async () => { throw new Error("timeout"); })).error).toBe("timeout");
    expect(fetchErrorCode(new Error("ECONNRESET 10.0.0.1:443"))).toBe("unreachable");
  });
});

describe("realTransport guards", () => {
  it("refuses a loopback or link-local pinned address and a malformed host or path without connecting", async () => {
    await expect(realTransport({ host: "app.example.com", path: "/", ip: "127.0.0.1", scheme: "https" })).rejects.toThrow(/blocked-address/);
    await expect(realTransport({ host: "app.example.com", path: "/", ip: "169.254.169.254", scheme: "http" })).rejects.toThrow(/blocked-address/);
    await expect(realTransport({ host: "app.example.com", path: "/", ip: "not-an-ip", scheme: "http" })).rejects.toThrow(/blocked-address/);
    await expect(realTransport({ host: "bad host", path: "/", scheme: "https" })).rejects.toThrow(/invalid-target/);
    await expect(realTransport({ host: "app.example.com", path: "/a b", scheme: "https" })).rejects.toThrow(/invalid-target/);
  });
  it("refuses a literal loopback source host through the URL guard", async () => {
    await expect(realTransport({ host: "localhost", path: "/", scheme: "http" })).rejects.toThrow();
  });
});
