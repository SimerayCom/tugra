"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Maximize2 } from "lucide-react";
import { useT } from "../i18n/provider";
import { Spinner } from "./ui";
import { terminalQuery, type TerminalStatus, type TerminalTarget } from "../lib/ws";

const TerminalView = dynamic(() => import("./terminal"), { ssr: false, loading: () => <Spinner /> });

const STATUS_COLOR: Record<TerminalStatus, string> = {
  open: "var(--c-g)",
  connecting: "var(--c-am)",
  reconnecting: "var(--c-am)",
  closed: "var(--c-tx3)",
  denied: "var(--c-r)",
};

/**
 * An INLINE terminal for a resource's own page (Coolify-style embedded "Terminal" tab) — not a modal.
 * Shows a live status badge and a "Full screen" link that opens the same target in the standalone /shell
 * page. The toolbar link doesn't steal focus, so keystrokes stay in the shell.
 */
export function TerminalPanel({ target, unavailableReason, height = 460 }: { target: TerminalTarget; unavailableReason?: string; height?: number }) {
  const t = useT();
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const badge = t(`terminal.status${status.charAt(0).toUpperCase()}${status.slice(1)}`);

  return (
    <div style={{ background: "#0b0b0c", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden", display: "flex", flexDirection: "column", height, marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderBottom: "1px solid var(--c-bd)" }}>
        {!unavailableReason && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: STATUS_COLOR[status] }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[status], flexShrink: 0 }} />{badge}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <a
          href={`/shell?${terminalQuery(target)}`}
          target="_blank"
          rel="noopener noreferrer"
          onMouseDown={(e) => e.preventDefault()}
          title={t("terminal.fullscreen")}
          aria-label={t("terminal.fullscreen")}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--c-tx2)", textDecoration: "none", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "3px 8px" }}
        >
          <Maximize2 size={13} aria-hidden /> {t("terminal.fullscreen")}
        </a>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: "8px 8px 8px 10px" }}>
        <TerminalView target={target} onStatus={setStatus} unavailableReason={unavailableReason} />
      </div>
    </div>
  );
}
