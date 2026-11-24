// Pure helpers for the per-token usage history: what to record about an API call. Nothing here ever sees
// or stores the token itself — only the source address, the client's user agent and a short action label.

export const MAX_USES_PER_TOKEN = 50;
/** Identical consecutive calls (same ip + agent + action) inside this window collapse into one row. */
export const COALESCE_WINDOW_MS = 60_000;

const MAX_ACTION = 120;
const MAX_AGENT = 200;
const MAX_IP = 64;

export interface UseInfo {
  ip: string | null;
  userAgent: string | null;
  action: string | null;
}

interface ReqLike {
  method?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  route?: { path?: unknown };
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Strip control characters and cap the length (header/body values are attacker-controlled text). */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function mcpAction(body: unknown): string {
  const first = (m: unknown): string | null => {
    if (!m || typeof m !== "object") return null;
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    if (msg.method === "tools/call" && typeof msg.params?.name === "string") return `mcp:${msg.params.name}`;
    if (typeof msg.method === "string") return `mcp:${msg.method}`;
    return null;
  };
  if (Array.isArray(body)) {
    const labels = new Set(body.map(first).filter((x): x is string => !!x));
    if (labels.size === 1) return [...labels][0];
    return labels.size > 1 ? "mcp:batch" : "mcp";
  }
  return first(body) ?? "mcp";
}

/** A short label for the call: `mcp:<tool>` for the MCP endpoint, else `<METHOD> <route template>` (the
 *  template, not the concrete URL, so ids and query strings never land in the history). */
export function describeApiCall(req: ReqLike): string | null {
  const method = String(req.method ?? "GET").toUpperCase();
  const tpl = typeof req.route?.path === "string" ? req.route.path : null;
  const path = tpl ?? (req.path ?? req.originalUrl ?? req.url ?? "").split("?")[0];
  if (!path) return null;
  if (method === "POST" && /(^|\/)mcp\/?$/.test(path)) return cleanText(mcpAction(req.body), MAX_ACTION);
  return cleanText(`${method} ${path}`, MAX_ACTION);
}

export function describeApiUse(req: ReqLike, ip: string | null): UseInfo {
  const ua = req.headers?.["user-agent"];
  return {
    ip: cleanText(ip, MAX_IP),
    userAgent: cleanText(Array.isArray(ua) ? ua[0] : ua, MAX_AGENT),
    action: describeApiCall(req),
  };
}
