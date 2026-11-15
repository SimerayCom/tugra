import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { forwardableHeaders, hubInternalUrl, hubProxyTimeoutMs, HUB_PROXY_DEFAULT_TIMEOUT_MS, proxyToHub } from "./hub-stream-proxy";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HUB_INTERNAL_URL;
  delete process.env.HUB_PROXY_TIMEOUT_MS;
});
beforeEach(() => {
  delete process.env.HUB_INTERNAL_URL;
  delete process.env.HUB_PROXY_TIMEOUT_MS;
});

/** A real local "hub": the proxy is exercised over a socket, exactly as in production. */
async function withHub<T>(handler: http.RequestListener, run: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HUB_INTERNAL_URL = base;
  try {
    return await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

async function readBody(r: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

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

describe("hubProxyTimeoutMs", () => {
  it("defaults to 11 minutes (above the hub's 10-minute apply budget and fetch's 300 s ceiling) and honours HUB_PROXY_TIMEOUT_MS", () => {
    expect(HUB_PROXY_DEFAULT_TIMEOUT_MS).toBe(660_000);
    expect(hubProxyTimeoutMs()).toBeGreaterThan(600_000);
    process.env.HUB_PROXY_TIMEOUT_MS = "1234";
    expect(hubProxyTimeoutMs()).toBe(1234);
    process.env.HUB_PROXY_TIMEOUT_MS = "nope";
    expect(hubProxyTimeoutMs()).toBe(HUB_PROXY_DEFAULT_TIMEOUT_MS);
  });
});

describe("proxyToHub", () => {
  it("streams a PUT body to the hub with the query string and forwarded headers, and relays the response", async () => {
    const seen: { url?: string; method?: string; cookie?: string; host?: string; body?: string } = {};
    await withHub(
      async (req, res) => {
        seen.url = req.url;
        seen.method = req.method;
        seen.cookie = req.headers.cookie;
        seen.host = req.headers.host;
        seen.body = await readBody(req);
        res.writeHead(201, { "content-type": "application/json", etag: '"e"' });
        res.end("ok");
      },
      async (base) => {
        const body = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("abc")); c.close(); } });
        const req = new Request("http://web/api/v1/apps/a1/files/content?volume=data&path=x%2Fy", { method: "PUT", body, headers: { cookie: "tg_access=a", "content-length": "3", host: "web" }, duplex: "half" } as RequestInit);
        const res = await proxyToHub(req, "/api/v1/apps/a1/files/content");
        expect(res.status).toBe(201);
        expect(res.headers.get("etag")).toBe('"e"');
        expect(await res.text()).toBe("ok");
        expect(seen.host).toBe(new URL(base).host); // the hub's own host, not the web's
      },
    );
    expect(seen).toMatchObject({ url: "/api/v1/apps/a1/files/content?volume=data&path=x%2Fy", method: "PUT", cookie: "tg_access=a", body: "abc" });
  });

  it("streams a large body without holding it in memory as one buffer (chunked in, chunked out)", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const total = 16 * chunk.length;
    let got = 0;
    await withHub(
      async (req, res) => {
        for await (const c of req) got += (c as Buffer).length;
        res.writeHead(200);
        res.end(String(got));
      },
      async () => {
        let sent = 0;
        const body = new ReadableStream({ pull: (c) => { if (sent >= total) return c.close(); sent += chunk.length; c.enqueue(chunk); } });
        const res = await proxyToHub(new Request("http://web/x", { method: "PUT", body, headers: { "content-length": String(total) }, duplex: "half" } as RequestInit), "/api/v1/x");
        expect(await res.text()).toBe(String(total));
      },
    );
    expect(got).toBe(total);
  });

  it("sends no body for GET and streams the download back untouched", async () => {
    await withHub(
      (req, res) => {
        expect(req.method).toBe("GET");
        expect(req.headers["content-length"]).toBeUndefined();
        res.writeHead(200, { "content-disposition": "attachment", "content-length": "9", "x-content-type-options": "nosniff" });
        res.end("filebytes");
      },
      async () => {
        const res = await proxyToHub(new Request("http://web/api/v1/apps/a1/files/content?volume=d&path=f"), "/api/v1/apps/a1/files/content");
        expect(res.headers.get("content-disposition")).toBe("attachment");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await res.text()).toBe("filebytes");
      },
    );
  });

  it("passes a hub error status and body through (typed errors reach the UI), and keeps every set-cookie", async () => {
    await withHub(
      (_req, res) => {
        res.writeHead(409, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
        res.end(JSON.stringify({ statusCode: 409, code: "exists", message: "m" }));
      },
      async () => {
        const res = await proxyToHub(new Request("http://web/x", { method: "PUT", body: "x" }), "/api/v1/x");
        expect(res.status).toBe(409);
        expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
        expect((await res.json()).code).toBe("exists");
      },
    );
  });

  it("answers a bodyless status (204) with no body", async () => {
    await withHub(
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      async () => {
        const res = await proxyToHub(new Request("http://web/x", { method: "DELETE" }), "/api/v1/x");
        expect(res.status).toBe(204);
        expect(res.body).toBeNull();
      },
    );
  });

  it("waits for a slow hub past the idle gap of a short timeout as long as bytes keep flowing, and is not capped at 300 s", async () => {
    process.env.HUB_PROXY_TIMEOUT_MS = "400";
    await withHub(
      (_req, res) => {
        setTimeout(() => res.writeHead(200).end("late"), 150); // headers only after 150 ms (the real case: minutes)
      },
      async () => {
        const res = await proxyToHub(new Request("http://web/x"), "/api/v1/x");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("late");
      },
    );
  });

  it("answers 504 when the hub stays silent for the whole idle timeout", async () => {
    process.env.HUB_PROXY_TIMEOUT_MS = "100";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withHub(
      () => undefined, // never answers
      async () => {
        const res = await proxyToHub(new Request("http://web/x"), "/api/v1/x");
        expect(res.status).toBe(504);
        expect((await res.json()).message).toMatch(/did not answer in time/);
      },
    );
  });

  it("answers 502 (never a hung request) when the hub is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.HUB_INTERNAL_URL = "http://127.0.0.1:1";
    const res = await proxyToHub(new Request("http://web/x", { method: "PUT", body: "x" }), "/api/v1/x");
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/hub is unreachable/);
  });

  it("tears the hub request down when the browser goes away", async () => {
    let hubClosed!: () => void;
    const closed = new Promise<void>((r) => (hubClosed = r));
    await withHub(
      (req) => {
        req.on("close", hubClosed);
      },
      async () => {
        const ac = new AbortController();
        const p = proxyToHub(new Request("http://web/x", { signal: ac.signal }), "/api/v1/x");
        setTimeout(() => ac.abort(), 50);
        await p;
        await closed;
      },
    );
  });
});
