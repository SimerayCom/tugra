"use client";

import dynamic from "next/dynamic";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Spinner } from "./ui";
import type { TerminalTarget } from "../lib/ws";

const TerminalView = dynamic(() => import("./terminal"), {
  ssr: false,
  loading: () => <Spinner />,
});

export function TerminalModal({
  target,
  title,
  onClose,
}: {
  target: TerminalTarget;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal
      onClose={onClose}
      zIndex={9000}
      closeOnEsc={false}
      trapTab={false}
      backdropStyle={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
      cardStyle={{ width: 880, maxWidth: "94vw", height: 540, maxHeight: "82vh", background: "#0b0b0c", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--c-bd)" }}>
        <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{title}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", fontSize: 12, cursor: "pointer", padding: "2px 10px", fontFamily: "inherit" }}
        >
          {t("terminal.close")}
        </button>
      </div>
      <div style={{ flex: 1, padding: 8, minHeight: 0 }}>
        <TerminalView target={target} onClose={onClose} />
      </div>
    </Modal>
  );
}
