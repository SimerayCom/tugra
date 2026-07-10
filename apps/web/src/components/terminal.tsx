"use client";

import { useEffect, useRef } from "react";
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
}: {
  target: TerminalTarget;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tkey = "app" in target ? `app:${target.app}` : "database" in target ? `database:${target.database}` : `server:${target.server}`;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
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
        onClose: () => term.write("\r\n[disconnected]\r\n"),
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
  }, [tkey]);

  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}
