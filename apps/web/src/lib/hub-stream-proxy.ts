// A STREAMING reverse proxy to the hub for the few routes that move large bodies (file uploads, and the agent
// transfer URLs when an agent reaches the hub through this origin).
//
// Why not the `/api/v1/*` rewrite? Next's rewrite proxy clones every request body so a middleware could re-read it,
// and that clone is capped by `experimental.middlewareClientMaxBodySize` (default 10 MiB): a larger PUT is silently
// TRUNCATED at the cap while its Content-Length still promises the full size, so the hub waits forever. Raising the
// cap is not a fix either — the clone is an unbounded in-memory buffer, so a 1 GiB upload would be held in RAM. A route
// handler instead pipes the incoming stream straight into `fetch` (undici applies real backpressure), so memory stays
// flat regardless of size. Responses stream the same way. These handlers sit in the file system, so they win over the
// rewrite, which next.config.mjs keeps only as the `fallback` for every other /api/v1 route.

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
    if (!drop.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

/**
 * Stream `req` to `${hub}${hubPath}` (query string preserved) and stream the response back. The request body is
 * never buffered; a hub or network failure is a 502 (never a hung request).
 */
export async function proxyToHub(req: Request, hubPath: string): Promise<Response> {
  const url = new URL(req.url);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: forwardableHeaders(req.headers),
    redirect: "manual",
    signal: req.signal,
    ...(hasBody ? { body: req.body, duplex: "half" as const } : {}),
  };
  let upstream: Response;
  try {
    upstream = await fetch(`${hubInternalUrl()}${hubPath}${url.search}`, init);
  } catch (err) {
    // Server-side only (never the response): the cause helps an operator tell "hub down" from "bad config".
    console.error("hub stream proxy: request to the hub failed:", err instanceof Error ? `${err.name}: ${err.message}${err.cause ? ` (${String(err.cause)})` : ""}` : String(err));
    return new Response(JSON.stringify({ statusCode: 502, error: "Bad Gateway", message: "the hub is unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  // fetch already decoded any content-encoding, so the encoding/length headers no longer describe the stream.
  const headers = forwardableHeaders(upstream.headers, upstream.headers.has("content-encoding") ? ["content-encoding", "content-length"] : []);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
