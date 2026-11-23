"use client";

import { useT } from "../i18n/provider";
import { installTransport } from "../lib/server-install";

/**
 * One line under an agent install command saying how the agent will reach the hub: a plain (unencrypted) ws:// address is
 * warned about; a pinned wss:// IP address is explained (no domain needed, still encrypted). A normal wss:// address
 * needs no note.
 */
export function InstallTransportNote({ command }: { command: string | null }) {
  const t = useT();
  const kind = installTransport(command);
  if (kind !== "plain" && kind !== "pinned") return null;
  const plain = kind === "plain";
  return (
    <div
      role={plain ? "alert" : "note"}
      style={{
        marginTop: 10,
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--c-tx2)",
        background: "var(--c-el)",
        border: `1px solid ${plain ? "var(--c-am)" : "var(--c-bd)"}`,
        borderRadius: "var(--r1)",
        padding: "8px 10px",
      }}
    >
      {plain ? t("servers.installPlainWarning") : t("servers.installPinnedNote")}
    </div>
  );
}
