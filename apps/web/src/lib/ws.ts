import { ensureHubPublicUrl, hubPublicUrl } from "./api";

/** Terminal target: an app container (optionally a specific compose service), a database container, or a server host. */
export type TerminalTarget = { app: string; container?: string } | { database: string } | { server: string };

/** A live terminal event from the hub. */
export type TerminalEvent =
  | { type: "term_output"; sessionId: string; data: string }
  | { type: "term_exit"; sessionId: string; exitCode: number };

/** http(s):// base → ws(s):// base. */
export function wsBase(apiBase: string): string {
  return apiBase.replace(/^http/, "ws");
}

/**
 * WebSocket base for the terminal. Unlike HTTP/SSE (proxied same-origin via /api), a WebSocket
 * upgrade can't traverse the Next rewrite, so the terminal connects straight to the hub by default
 * (hubPublicUrl() → ws) — the short-lived ticket in the subprotocol authenticates that cross-origin
 * upgrade without a cookie, and the hub pins the Origin to the SPA. hubPublicUrl() resolves to the
 * current origin at runtime when unbaked, so a single-origin (--domain) deployment that routes /terminal
 * to the hub works out of the box. NEXT_PUBLIC_WS_URL overrides for any other topology.
 */
export function terminalBase(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  return wsBase((explicit ?? hubPublicUrl()).replace(/\/+$/, ""));
}

/** The target as a querystring (no leading `?`). Shared by the WS URL and the full-page /shell link so a
 *  "Expand" button and the page parse/produce the exact same shape. */
export function terminalQuery(target: TerminalTarget): string {
  return "app" in target
    ? `app=${encodeURIComponent(target.app)}${target.container ? `&container=${encodeURIComponent(target.container)}` : ""}`
    : "database" in target
      ? `database=${encodeURIComponent(target.database)}`
      : `server=${encodeURIComponent(target.server)}`;
}

/** Parse a TerminalTarget from URL search params (the /shell page's deep link). Null when none present. */
export function targetFromQuery(params: URLSearchParams): TerminalTarget | null {
  const app = params.get("app");
  if (app) {
    const container = params.get("container");
    return container ? { app, container } : { app };
  }
  const database = params.get("database");
  if (database) return { database };
  const server = params.get("server");
  if (server) return { server };
  return null;
}

/** Build the /terminal WebSocket URL for a target. `wsBase` is idempotent on ws:// bases, so it
 *  passes through terminalBase() unchanged and still converts an explicit http(s) base. */
export function terminalUrl(target: TerminalTarget, base: string = terminalBase()): string {
  return `${wsBase(base)}/terminal?${terminalQuery(target)}`;
}

// base64 helpers (browser): raw bytes ↔ string. utf-8 safe for input.
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeInput(data: string): string {
  return JSON.stringify({ type: "term_input", data: bytesToB64(enc.encode(data)) });
}

export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ type: "term_resize", cols, rows });
}

export function decodeOutput(b64: string): string {
  return dec.decode(b64ToBytes(b64));
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface TerminalConn {
  send(raw: string): void;
  close(): void;
}

/**
 * Open a terminal WebSocket. The access cookie is httpOnly (JS can't read it for the subprotocol),
 * so the caller supplies `fetchTicket` — a short-lived term_ticket the hub mints from the cookie
 * session — which rides in the Sec-WebSocket-Protocol header as ["tugra.bearer", <ticket>]. The
 * ticket is fetched asynchronously, so the socket opens once it resolves; sends before then no-op.
 */
export function connectTerminal(
  target: TerminalTarget,
  handlers: { onEvent: (e: TerminalEvent) => void; onOpen?: () => void; onClose?: (info?: { code: number; reason: string }) => void },
  opts: { fetchTicket?: () => Promise<string>; WS?: typeof WebSocket } = {},
): TerminalConn {
  const WS = opts.WS ?? WebSocket;
  const fetchTicket = opts.fetchTicket ?? (() => Promise.resolve("")); // "" → hub falls back to the cookie (same-origin)
  let ws: WebSocket | undefined;
  let closed = false;

  // Resolve the hub's public URL first (cached; no-op when baked) so the WS targets the hub, not the web port.
  Promise.all([fetchTicket(), ensureHubPublicUrl().catch(() => null)])
    .then(([ticket]) => {
      if (closed) return;
      ws = new WS(terminalUrl(target), ["tugra.bearer", ticket]);
      ws.onopen = () => handlers.onOpen?.();
      // Pass the close code + reason through — the hub sends an actionable reason (e.g. "terminal
      // capability not granted for this server") that the UI must surface instead of a generic "closed".
      ws.onclose = (ev: CloseEvent) => handlers.onClose?.({ code: ev.code, reason: ev.reason });
      ws.onmessage = (ev: MessageEvent) => {
        try {
          handlers.onEvent(JSON.parse(String(ev.data)) as TerminalEvent);
        } catch {
          /* ignore malformed frame */
        }
      };
    })
    .catch(() => handlers.onClose?.());

  return {
    send: (raw) => {
      if (ws && ws.readyState === ws.OPEN) ws.send(raw);
    },
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}

export type TerminalStatus = "connecting" | "open" | "reconnecting" | "closed" | "denied";

/**
 * connectTerminal + automatic reconnection. A dropped socket (idle timeout, agent blip) backs off
 * (exponential + jitter, capped 30s, up to maxAttempts) and reconnects with a FRESH ticket. A clean exit
 * (1000) or a hub refusal (1008 — auth/capability/forbidden) never retries. Because the hub kills the PTY
 * when the socket closes, a reconnect is a NEW shell — onReconnect fires so the UI can mark that.
 */
export function connectTerminalWithRetry(
  target: TerminalTarget,
  handlers: {
    onEvent: (e: TerminalEvent) => void;
    onStatus?: (s: TerminalStatus, info?: { code: number; reason: string }) => void;
    onReconnect?: () => void;
  },
  opts: { fetchTicket?: () => Promise<string>; WS?: typeof WebSocket; maxAttempts?: number; rand?: () => number } = {},
): TerminalConn {
  // No default cap: a transient drop (agent blip, hub redeploy, a server reboot) retries FOREVER with the 30s
  // backoff so the shell recovers on its own — "connections must not stay dropped". An explicit cap is kept
  // only for tests. 1000 (clean exit) and 1008 (auth/capability) never retry.
  const cap = opts.maxAttempts;
  const rand = opts.rand ?? Math.random;
  let conn: TerminalConn | undefined;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnecting = false; // true between a retryable close and the next STABLE open
  let connected = false;
  // A bare WebSocket open is NOT proof the shell is usable: the hub accepts the upgrade and only THEN may
  // close 1011 ("agent offline"/"agent disconnected"). So for an OFFLINE server the socket opens and closes
  // in well under a second. Treat a connection as STABLE — reset the backoff, announce the reconnect — only
  // after it survives this long; a connection that drops sooner counts as a failed attempt and keeps backing
  // off (otherwise an OFFLINE server would reconnect every ~1.5s forever and hammer the throttled ticket
  // endpoint). The `open` status still fires immediately so the terminal sizes/uses the socket at once.
  const STABLE_MS = 2000;

  const start = () => {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = undefined; }
    handlers.onStatus?.(attempt === 0 && !reconnecting ? "connecting" : "reconnecting");
    conn = connectTerminal(
      target,
      {
        onEvent: handlers.onEvent,
        onOpen: () => {
          connected = true;
          handlers.onStatus?.("open");
          if (stableTimer) clearTimeout(stableTimer);
          stableTimer = setTimeout(() => {
            attempt = 0; // only NOW is the backoff reset — the connection proved it stays up
            if (reconnecting) { handlers.onReconnect?.(); reconnecting = false; }
          }, STABLE_MS);
        },
        onClose: (info) => {
          connected = false;
          if (stableTimer) { clearTimeout(stableTimer); stableTimer = undefined; } // never became stable
          if (stopped) return;
          if (info?.code === 1000) return handlers.onStatus?.("closed", info); // process exited cleanly
          if (info?.code === 1008) return handlers.onStatus?.("denied", info); // auth / capability / policy — no retry
          if (cap != null && attempt >= cap) return handlers.onStatus?.("closed", info);
          reconnecting = true;
          const delay = Math.min(1000 * 2 ** attempt + rand() * 1000, 30000);
          attempt += 1;
          handlers.onStatus?.("reconnecting");
          timer = setTimeout(() => { if (!stopped) start(); }, delay);
        },
      },
      { fetchTicket: opts.fetchTicket, WS: opts.WS },
    );
  };

  // When the browser/tab comes back, fire a PENDING backoff immediately instead of waiting out its delay
  // (up to 30s) — so a laptop wake / network return reconnects the shell at once. No-op unless we're waiting.
  const retryNow = () => {
    if (stopped || connected || !timer) return;
    clearTimeout(timer);
    timer = undefined;
    attempt = 0;
    start();
  };
  const onWake = () => { if (typeof document === "undefined" || !document.hidden) retryNow(); };
  if (typeof window !== "undefined") {
    window.addEventListener("online", retryNow);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onWake);
  }

  start();

  return {
    send: (raw) => conn?.send(raw),
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stableTimer) clearTimeout(stableTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", retryNow);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onWake);
      }
      conn?.close();
    },
  };
}
