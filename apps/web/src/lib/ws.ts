import { hubPublicUrl } from "./api";

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

/** Build the /terminal WebSocket URL for a target. `wsBase` is idempotent on ws:// bases, so it
 *  passes through terminalBase() unchanged and still converts an explicit http(s) base. */
export function terminalUrl(target: TerminalTarget, base: string = terminalBase()): string {
  const q =
    "app" in target
      ? `app=${encodeURIComponent(target.app)}${target.container ? `&container=${encodeURIComponent(target.container)}` : ""}`
      : "database" in target
        ? `database=${encodeURIComponent(target.database)}`
        : `server=${encodeURIComponent(target.server)}`;
  return `${wsBase(base)}/terminal?${q}`;
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
  handlers: { onEvent: (e: TerminalEvent) => void; onOpen?: () => void; onClose?: () => void },
  opts: { fetchTicket?: () => Promise<string>; WS?: typeof WebSocket } = {},
): TerminalConn {
  const WS = opts.WS ?? WebSocket;
  const fetchTicket = opts.fetchTicket ?? (() => Promise.resolve("")); // "" → hub falls back to the cookie (same-origin)
  let ws: WebSocket | undefined;
  let closed = false;

  fetchTicket()
    .then((ticket) => {
      if (closed) return;
      ws = new WS(terminalUrl(target), ["tugra.bearer", ticket]);
      ws.onopen = () => handlers.onOpen?.();
      ws.onclose = () => handlers.onClose?.();
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
