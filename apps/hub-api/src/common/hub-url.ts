// The hub's public URL resolution, shared by the agent installer (servers.service.ts) and the importer
// one-click migrator (importer). Single source of truth so the trailing-slash strip + http→ws mapping can
// never drift between the two curl bootstraps.

/** Just the headers a public-URL derivation needs — avoids importing Express's Request type. */
export interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}

/** First comma-element of a (possibly multi-proxy) forwarded header, trimmed. */
function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  return s || undefined;
}

/** Best-effort public base URL of this hub from the request (proxy-aware). */
export function publicUrlFrom(req: ReqLike): string | undefined {
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? firstHeader(req.headers.host);
  if (!host) return undefined;
  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}`;
}

/**
 * The hub's public HTTP(S) base URL (no trailing slash). Prefers the configured HUB_PUBLIC_URL, else the
 * request's public host, else localhost. The curl bootstraps fetch their installer from here. NOTE: a
 * BLANK HUB_PUBLIC_URL (the shipped .env.example default / an unset docker-compose var forwarded as "")
 * must fall through to the request host, not win as an empty base — hence `|| `, not `??`.
 */
export function hubBaseUrl(publicUrl?: string): string {
  const port = process.env.HUB_PORT ?? "3000";
  const base = process.env.HUB_PUBLIC_URL?.trim() || publicUrl || `http://localhost:${port}`;
  return base.replace(/\/+$/, "");
}

/** The ws(s) URL the agent should dial — the HTTP base mapped http→ws / https→wss, plus `/agent`. */
export function agentWsUrl(publicUrl?: string): string {
  return `${hubBaseUrl(publicUrl).replace(/^http/i, "ws")}/agent`;
}
