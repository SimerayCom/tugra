"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/provider";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import { XTERM_THEME } from "../lib/terminal-theme";
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
  const termRef = useRef<Terminal | null>(null);
  const tkey = "app" in target ? `app:${target.app}` : "database" in target ? `database:${target.database}` : `server:${target.server}`;
  const serverId = "server" in target ? target.server : null;
  // The hub refused the shell because the terminal capability is off on this server: offer to turn it on in place.
  const [capOff, setCapOff] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const grantTerminal = async () => {
    if (!serverId) return;
    setGranting(true);
    setGrantError(null);
    try {
      const { results } = await api.bulkSetServerCapabilities([serverId], ["terminal"], []);
      const r = results.find((x) => x.id === serverId);
      if (!r || !r.ok) throw new Error(t(r && !r.ok && r.error === "forbidden" ? "terminal.enableForbidden" : "terminal.enableFailed"));
      setCapOff(false);
      setConfirming(false);
      setAttempt((n) => n + 1); // reconnect with the capability granted
    } catch (e) {
      setGrantError(e instanceof Error ? e.message : t("terminal.enableFailed"));
    } finally {
      setGranting(false);
    }
  };

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
      scrollOnUserInput: true, // typing always jumps back to the live prompt
      // Full 16-colour ANSI theme (lib/terminal-theme) so `ls --color`, prompts and TUIs render like a
      // real terminal; cursor in Tugra gold, surfaces matched to the dark panel.
      theme: XTERM_THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.scrollToBottom();

    // xterm only follows new output while the viewport is already at the bottom. The first fit() runs before
    // the dynamic-import layout is settled, and a resize can leave the viewport mid-buffer — so new output
    // (and the reconnect/exit banners) stop auto-scrolling. Re-pin to the bottom whenever we were already
    // following, so a live shell keeps tracking its output.
    const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY;
    const stick = () => term.scrollToBottom();

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
            stick(); // a fresh/reconnected shell starts pinned to the live prompt
          } else if (s === "denied") {
            // Surface the hub's actual reason (most often: terminal capability off) with an actionable hint.
            const reason = info?.reason?.trim();
            const text = !reason
              ? tRef.current("terminal.closed")
              : /capability not granted/i.test(reason)
                ? (setCapOff(serverId !== null), tRef.current("terminal.capabilityHint"))
                : tRef.current("terminal.closedReason", { reason });
            term.write(`\r\n${text}\r\n`);
          } else if (s === "closed" && !exited) {
            // Reached on a clean 1000 (no exit event) or after retries are exhausted.
            term.write(`\r\n${tRef.current("terminal.closed")}\r\n`);
          }
        },
        // The hub kills the PTY when the socket drops, so a reconnect is a NEW shell — say so.
        onReconnect: () => { term.write(`\r\n\x1b[2m${tRef.current("terminal.reconnected")}\x1b[0m\r\n`); stick(); },
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
          const wasBottom = atBottom();
          fit.fit();
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            conn.send(encodeResize(term.cols, term.rows));
          }
          if (wasBottom) stick(); // a reflow must not strand us above the live output
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
      termRef.current = null;
    };
    // Reconnect only when the target or font size changes, not on unrelated parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, unavailableReason, fontSize, attempt]);

  if (unavailableReason) {
    return (
      <div role="status" style={{ padding: 16, fontSize: 13, color: "var(--c-tx2)" }}>
        {unavailableReason}
      </div>
    );
  }
  // Clicking anywhere in the terminal re-focuses it, so keystrokes always reach the shell (not a toolbar
  // button that happened to hold focus).
  const bar = capOff && serverId && (
    <div role="alert" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", borderBottom: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", fontSize: 13 }}>
      <span style={{ flex: "1 1 220px" }}>{confirming ? t("terminal.enableConfirm") : t("terminal.enableTitle")}</span>
      {confirming ? (
        <>
          <button type="button" className="tg-btn" disabled={granting} onClick={() => void grantTerminal()} style={barBtn(true)}>{granting ? "…" : t("terminal.enableYes")}</button>
          <button type="button" className="tg-btn" disabled={granting} onClick={() => setConfirming(false)} style={barBtn(false)}>{t("terminal.enableCancel")}</button>
        </>
      ) : (
        <button type="button" className="tg-btn" onClick={() => setConfirming(true)} style={barBtn(true)}>{t("terminal.enableAction")}</button>
      )}
      {grantError && <span style={{ flexBasis: "100%", color: "var(--c-r)" }}>{grantError}</span>}
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      {bar}
      <div ref={ref} onMouseDown={() => termRef.current?.focus()} style={{ flex: 1, minHeight: 0, width: "100%" }} />
    </div>
  );
}

function barBtn(primary: boolean): React.CSSProperties {
  return {
    minHeight: 36,
    padding: "6px 14px",
    borderRadius: 8,
    border: primary ? "none" : "1px solid var(--c-bd)",
    background: primary ? "var(--c-a)" : "transparent",
    color: primary ? "#0d0d11" : "var(--c-tx)",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
