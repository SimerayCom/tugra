// A STREAMING reverse proxy to the hub for the few routes that move large bodies (file uploads, and the agent
// transfer URLs when an agent reaches the hub through this origin).
//
// Why not the `/api/v1/*` rewrite? Next's rewrite proxy clones every request body so a middleware could re-read it,
// and that clone is capped by `experimental.middlewareClientMaxBodySize` (default 10 MiB): a larger PUT is silently
// TRUNCATED at the cap while its Content-Length still promises the full size, so the hub waits forever. Raising the
// cap is not a fix either — the clone is an unbounded in-memory buffer, so a 1 GiB upload would be held in RAM. A route
// handler instead pipes the incoming stream straight into the hub request (real backpressure), so memory stays flat
// regardless of size. Responses stream the same way. These handlers sit in the file system, so they win over the
// rewrite, which next.config.mjs keeps only as the `fallback` for every other /api/v1 route.
//
// Why `node:http` and not `fetch`? The runtime's fetch (undici) gives up after 300 s without response headers, and a
// large upload only gets its response once the hub has staged the body AND the agent has pulled and applied it (up to
// 10 minutes). undici's Agent is not a dependency of this app and cannot be configured through the global fetch, so
// the hop uses Node's own HTTP client, which has no headers/body timeout of its own: only the explicit idle timeout
// below applies (HUB_PROXY_TIMEOUT_MS, default 11 minutes, above the 10-minute apply budget).

import http from "node:http";
import https from "node:https";
import { Readable, pipeline } from "node:stream";

const HOP_BY_HOP = new Set(["expect", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

/** The hub's address as reachable from this server (the same variable next.config.mjs reads for the rewrite). */
export function hubInternalUrl(): string {
  return (process.env.HUB_INTERNAL_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Copy headers minus the hop-by-hop ones (and `host`, which must be the hub's own). */
export function forwardableHeaders(src: Headers, extraDrop: string[] = []): Headers {
  const drop = new Set([...HOP_BY_HOP, ...extraDrop]);
  const out = new Headers();
  src.forEach((v, k) => {
    if (!drop.has(k.toLowerCase())) out.append(k, v); // append, so several Set-Cookie entries all survive
  });
  return out;
}

/** How long the hub hop may sit completely idle (no bytes either way) before it is cut. Must exceed the hub's 10-minute apply budget. */
export const HUB_PROXY_DEFAULT_TIMEOUT_MS = 11 * 60_000;

export function hubProxyTimeoutMs(): number {
  const n = Number(process.env.HUB_PROXY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HUB_PROXY_DEFAULT_TIMEOUT_MS;
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ statusCode: status, error, message }), { status, headers: { "content-type": "application/json" } });
}

/**
 * Stream `req` to `${hub}${hubPath}` (query string preserved) and stream the response back. The request body is
 * never buffered; a hub or network failure is a 502 and an idle hub a 504 (never a hung request).
 */
export function proxyToHub(req: Request, hubPath: string): Promise<Response> {
  const search = new URL(req.url).search;
  const target = new URL(`${hubInternalUrl()}${hubPath}${search}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const headers: Record<string, string> = {};
  forwardableHeaders(req.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const timeoutMs = hubProxyTimeoutMs();

  return new Promise<Response>((resolve) => {
    let settled = false;
    const lib = target.protocol === "https:" ? https : http;
    const upstream = lib.request(target, { method: req.method, headers }, (inc) => {
      settled = true;
      const out = new Headers();
      for (const [k, v] of Object.entries(inc.headers)) {
        if (Array.isArray(v)) for (const x of v) out.append(k, x);
        else if (v !== undefined) out.set(k, v);
      }
      const status = inc.statusCode ?? 502;
      const noBody = req.method === "HEAD" || status === 204 || status === 205 || status === 304;
      if (noBody) inc.resume();
      resolve(
        new Response(noBody ? null : (Readable.toWeb(inc) as unknown as ReadableStream), {
          status,
          statusText: inc.statusMessage,
          headers: forwardableHeaders(out),
        }),
      );
    });
    upstream.setTimeout(timeoutMs, () => upstream.destroy(Object.assign(new Error(`no activity from the hub for ${timeoutMs} ms`), { code: "HUB_PROXY_TIMEOUT" })));
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return; // after the response started, the body stream carries the failure
      settled = true;
      // Server-side only (never the response): the cause helps an operator tell "hub down" from "bad config".
      console.error("hub stream proxy: request to the hub failed:", `${err.name}: ${err.message}${err.code ? ` (${err.code})` : ""}`);
      resolve(err.code === "HUB_PROXY_TIMEOUT" ? jsonError(504, "Gateway Timeout", "the hub did not answer in time") : jsonError(502, "Bad Gateway", "the hub is unreachable"));
    });
    const abort = (): void => {
      upstream.destroy();
    };
    if (req.signal.aborted) abort();
    else req.signal.addEventListener("abort", abort, { once: true });
    if (hasBody) {
      pipeline(Readable.fromWeb(req.body as never), upstream, (err) => {
        if (err) upstream.destroy(err);
      });
    } else {
      upstream.end();
    }
  });
}
