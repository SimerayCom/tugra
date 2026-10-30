"use client";

import dynamic from "next/dynamic";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Spinner } from "./ui";
import { terminalQuery, type TerminalTarget } from "../lib/ws";

const TerminalView = dynamic(() => import("./terminal"), {
  ssr: false,
  loading: () => <Spinner />,
});

export function TerminalModal({
  target,
  title,
  onClose,
  unavailableReason,
}: {
  target: TerminalTarget;
  title: string;
  onClose: () => void;
  /** Caller passes this when the resource/server isn't RUNNING; shown instead of connecting. */
  unavailableReason?: string;
}) {
  const t = useT();
  return (
    <Modal
      onClose={onClose}
      ariaLabel={title}
      zIndex={9000}
      closeOnEsc={false}
      trapTab={false}
      backdropStyle={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
      cardStyle={{ width: "94vw", maxWidth: 1400, height: "88vh", background: "#0b0b0c", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 10 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--c-bd)" }}>
        <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{title}</span>
        <span style={{ flex: 1 }} />
        {!unavailableReason && (
          <button
            onClick={() => { window.open(`/shell?${terminalQuery(target)}`, "_blank", "noopener"); onClose(); }}
            style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", fontSize: 12, cursor: "pointer", padding: "2px 10px", fontFamily: "inherit", marginRight: 8 }}
          >
            {t("terminal.expand")}
          </button>
        )}
        <button
          onClick={onClose}
          style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", fontSize: 12, cursor: "pointer", padding: "2px 10px", fontFamily: "inherit" }}
        >
          {t("terminal.close")}
        </button>
      </div>
      <div style={{ flex: 1, padding: "10px 8px 10px 12px", minHeight: 0 }}>
        <TerminalView target={target} onClose={onClose} unavailableReason={unavailableReason} />
      </div>
    </Modal>
  );
}
