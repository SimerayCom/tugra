"use client";

import { useEffect, useRef } from "react";
import { useT } from "../i18n/provider";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import {
  connectTerminalWithRetry,
  decodeOutput,
  encodeInput,
  encodeResize,
  type TerminalStatus,
  type TerminalTarget,
} from "../lib/ws";

/** Interactive xterm.js terminal wired to the hub's /terminal WebSocket (auto-reconnecting). */
export default function TerminalView({
  target,
  onClose,
  onStatus,
  fontSize = 14,
  unavailableReason,
}: {
  target: TerminalTarget;
  onClose?: () => void;
  /** Connection-state callback so a page toolbar can show a status badge. */
  onStatus?: (s: TerminalStatus) => void;
  fontSize?: number;
  /** When set, show this message instead of connecting (resource/server not running). */
  unavailableReason?: string;
}) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const ref = useRef<HTMLDivElement>(null);
  const tkey = "app" in target ? `app:${target.app}` : "database" in target ? `database:${target.database}` : `server:${target.server}`;

  useEffect(() => {
    const host = ref.current;
    if (!host || unavailableReason) return;
    const term = new Terminal({
      fontSize,
      lineHeight: 1.2,
      // A concrete monospace stack — xterm's DOM renderer still needs real faces, not just a CSS var.
      fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      // Full 16-colour ANSI theme so `ls --color`, prompts and TUIs render like a real terminal; cursor in
      // Tugra gold, surfaces matched to the dark panel.
      theme: {
        background: "#0b0b0c",
        foreground: "#e4e4e7",
        cursor: "#d4af6a",
        cursorAccent: "#0b0b0c",
        selectionBackground: "#33343b",
        black: "#2b2b2b", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4e7",
        brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
        brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let exited = false;
    const conn = connectTerminalWithRetry(
      target,
      {
        onEvent: (e) => {
          if (e.type === "term_output") {
            term.write(decodeOutput(e.data));
          } else {
            exited = true;
            term.write(`\r\n[process exited ${e.exitCode}]\r\n`);
            onClose?.();
          }
        },
        onStatus: (s, info) => {
          onStatus?.(s);
          if (s === "open") {
            conn.send(encodeResize(term.cols, term.rows));
          } else if (s === "denied") {
            // Surface the hub's actual reason (most often: terminal capability off) with an actionable hint.
            const reason = info?.reason?.trim();
            const text = !reason
              ? tRef.current("terminal.closed")
              : /capability not granted/i.test(reason)
                ? tRef.current("terminal.capabilityHint")
                : tRef.current("terminal.closedReason", { reason });
            term.write(`\r\n${text}\r\n`);
          } else if (s === "closed" && !exited) {
            // Reached on a clean 1000 (no exit event) or after retries are exhausted.
            term.write(`\r\n${tRef.current("terminal.closed")}\r\n`);
          }
        },
        // The hub kills the PTY when the socket drops, so a reconnect is a NEW shell — say so.
        onReconnect: () => term.write(`\r\n\x1b[2m${tRef.current("terminal.reconnected")}\x1b[0m\r\n`),
      },
      { fetchTicket: () => api.terminalTicket().then((r) => r.ticket) },
    );

    const dataSub = term.onData((d) => conn.send(encodeInput(d)));
    let rt: ReturnType<typeof setTimeout> | undefined;
    let lastCols = term.cols;
    let lastRows = term.rows;
    const ro = new ResizeObserver(() => {
      if (rt) clearTimeout(rt);
      // Debounce + skip tiny/zero sizes (layout mid-transition); only tell the agent on a real change.
      rt = setTimeout(() => {
        try {
          if (host.clientWidth < 24 || host.clientHeight < 24) return;
          fit.fit();
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            conn.send(encodeResize(term.cols, term.rows));
          }
        } catch {
          /* element detaching */
        }
      }, 50);
    });
    ro.observe(host);
    term.focus();

    return () => {
      if (rt) clearTimeout(rt);
      ro.disconnect();
      dataSub.dispose();
      conn.close();
      term.dispose();
    };
    // Reconnect only when the target or font size changes, not on unrelated parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, unavailableReason, fontSize]);

  if (unavailableReason) {
    return (
      <div role="status" style={{ padding: 16, fontSize: 13, color: "var(--c-tx2)" }}>
        {unavailableReason}
      </div>
    );
  }
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}
