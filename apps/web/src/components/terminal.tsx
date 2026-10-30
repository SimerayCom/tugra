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
      fontSize: 13,
      fontFamily: "var(--font-geist-mono, ui-monospace, monospace)",
      cursorBlink: true,
      theme: { background: "#0b0b0c" },
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
