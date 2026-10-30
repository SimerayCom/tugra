"use client";

import { useEffect, useRef } from "react";
import { useT } from "../i18n/provider";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import {
  connectTerminal,
  decodeOutput,
  encodeInput,
  encodeResize,
  type TerminalTarget,
} from "../lib/ws";

/** Interactive xterm.js terminal wired to the hub's /terminal WebSocket. */
export default function TerminalView({
  target,
  onClose,
  unavailableReason,
}: {
  target: TerminalTarget;
  onClose?: () => void;
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
      fontSize: 14,
      lineHeight: 1.2,
      // A real monospace stack (xterm renders to a canvas, so it needs concrete faces, not just a CSS var).
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

    const conn = connectTerminal(
      target,
      {
        onOpen: () => conn.send(encodeResize(term.cols, term.rows)),
        onEvent: (e) => {
          if (e.type === "term_output") {
            term.write(decodeOutput(e.data));
          } else {
            term.write(`\r\n[process exited ${e.exitCode}]\r\n`);
            onClose?.();
          }
        },
        onClose: (info) => {
          // Surface the hub's close reason instead of a bare "connection closed". The most common cause
          // is the server's "terminal" capability being off (least-privilege default) — give an actionable
          // hint for that; otherwise echo the reason the hub sent, falling back to the generic message.
          const reason = info?.reason?.trim();
          const text = !reason
            ? tRef.current("terminal.closed")
            : /capability not granted/i.test(reason)
              ? tRef.current("terminal.capabilityHint")
              : tRef.current("terminal.closedReason", { reason });
          term.write(`\r\n${text}\r\n`);
        },
      },
      { fetchTicket: () => api.terminalTicket().then((r) => r.ticket) },
    );

    const dataSub = term.onData((d) => conn.send(encodeInput(d)));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        conn.send(encodeResize(term.cols, term.rows));
      } catch {
        /* element detaching */
      }
    });
    ro.observe(host);
    term.focus();

    return () => {
      ro.disconnect();
      dataSub.dispose();
      conn.close();
      term.dispose();
    };
    // Reconnect only when the target changes, not on unrelated parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, unavailableReason]);

  if (unavailableReason) {
    return (
      <div role="status" style={{ padding: 16, fontSize: 13, color: "var(--c-tx2)" }}>
        {unavailableReason}
      </div>
    );
  }
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}
