import { API_BASE, tokens } from "./api";

/** Terminal target: an app container (optionally a specific compose service), a database container, or a server host. */
export type TerminalTarget = { app: string; container?: string } | { database: string } | { server: string };

/** A live terminal event from the hub. */
export type TerminalEvent =
  | { type: "term_output"; sessionId: string; data: string }
  | { type: "term_exit"; sessionId: string; exitCode: number };

/** http(s):// base → ws(s):// base. */
export function wsBase(apiBase: string = API_BASE): string {
  return apiBase.replace(/^http/, "ws");
}

/** Build the /terminal WebSocket URL for a target. */
export function terminalUrl(target: TerminalTarget, base: string = API_BASE): string {
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
 * Open a terminal WebSocket. The access token rides in the Sec-WebSocket-Protocol
 * header (browsers can't set Authorization on WS) as ["tugra.bearer", <token>].
 */
export function connectTerminal(
  target: TerminalTarget,
  handlers: { onEvent: (e: TerminalEvent) => void; onOpen?: () => void; onClose?: () => void },
  WS: typeof WebSocket = WebSocket,
): TerminalConn {
  const ws = new WS(terminalUrl(target), ["tugra.bearer", tokens.access() ?? ""]);
  ws.onopen = () => handlers.onOpen?.();
  ws.onclose = () => handlers.onClose?.();
  ws.onmessage = (ev: MessageEvent) => {
    try {
      handlers.onEvent(JSON.parse(String(ev.data)) as TerminalEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  return {
    send: (raw) => {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    },
    close: () => ws.close(),
  };
}
