import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { forwardableHeaders, hubInternalUrl, proxyToHub } from "./hub-stream-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HUB_INTERNAL_URL;
});
beforeEach(() => {
  delete process.env.HUB_INTERNAL_URL;
});

describe("hubInternalUrl", () => {
  it("defaults to the local hub and honours HUB_INTERNAL_URL without a trailing slash", () => {
    expect(hubInternalUrl()).toBe("http://localhost:3000");
    process.env.HUB_INTERNAL_URL = "http://hub-api:3000//";
    expect(hubInternalUrl()).toBe("http://hub-api:3000");
  });
});

describe("forwardableHeaders", () => {
  it("drops hop-by-hop headers and host, keeps cookies, csrf, content type and length", () => {
    const h = forwardableHeaders(
      new Headers({ host: "web:3001", connection: "keep-alive", "transfer-encoding": "chunked", upgrade: "x", cookie: "tg_access=a", "x-csrf-token": "t", "content-type": "application/octet-stream", "content-length": "5" }),
    );
    expect([...h.keys()].sort()).toEqual(["content-length", "content-type", "cookie", "x-csrf-token"]);
  });
});

describe("proxyToHub", () => {
  it("streams a PUT body to the hub as a half-duplex stream with the query string, without buffering it", async () => {
    process.env.HUB_INTERNAL_URL = "http://hub:3000";
    const seen: { url?: string; init?: RequestInit & { duplex?: string } } = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init as never;
      return new Response("ok", { status: 201, headers: { "content-type": "application/json", etag: '"e"' } });
    }));
    const body = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("abc")); c.close(); } });
    const req = new Request("http://web/api/v1/apps/a1/files/content?volume=data&path=x%2Fy", { method: "PUT", body, headers: { cookie: "tg_access=a", "content-length": "3", host: "web" }, duplex: "half" } as RequestInit);
    const res = await proxyToHub(req, "/api/v1/apps/a1/files/content");
    expect(seen.url).toBe("http://hub:3000/api/v1/apps/a1/files/content?volume=data&path=x%2Fy");
    expect(seen.init?.method).toBe("PUT");
    expect(seen.init?.duplex).toBe("half");
    expect(seen.init?.body).toBeInstanceOf(ReadableStream); // the stream itself, never an ArrayBuffer/Blob copy
    expect(seen.init?.redirect).toBe("manual");
    expect(new Headers(seen.init?.headers).get("cookie")).toBe("tg_access=a");
    expect(new Headers(seen.init?.headers).get("host")).toBeNull();
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"e"');
    expect(await res.text()).toBe("ok");
  });

  it("sends no body for GET and streams the response (download) back untouched", async () => {
    let init: (RequestInit & { duplex?: string }) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, i: RequestInit) => {
      init = i as never;
      return new Response("filebytes", { status: 200, headers: { "content-disposition": "attachment", "content-length": "9", "x-content-type-options": "nosniff" } });
    }));
    const res = await proxyToHub(new Request("http://web/api/v1/apps/a1/files/content?volume=d&path=f"), "/api/v1/apps/a1/files/content");
    expect(init?.body).toBeUndefined();
    expect(init?.duplex).toBeUndefined();
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("filebytes");
  });

  it("passes a hub error status and body through (typed errors reach the UI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ statusCode: 409, code: "exists", message: "m" }), { status: 409, headers: { "content-type": "application/json" } })));
    const res = await proxyToHub(new Request("http://web/x", { method: "PUT", body: "x" }), "/api/v1/x");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("exists");
  });

  it("drops encoding/length headers when fetch already decoded the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("plain", { status: 200, headers: { "content-encoding": "gzip", "content-length": "99" } })));
    const res = await proxyToHub(new Request("http://web/x"), "/api/v1/x");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).not.toBe("99");
  });

  it("answers 502 (never a hung request) when the hub is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const res = await proxyToHub(new Request("http://web/x", { method: "PUT", body: "x" }), "/api/v1/x");
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/hub is unreachable/);
  });
});
