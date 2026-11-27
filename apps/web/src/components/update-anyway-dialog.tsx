"use client";

import { useT } from "../i18n/provider";
import type { InFlightItem } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";
import { InFlightList } from "./in-flight-list";

/**
 * "Update anyway?": shown when the hub or an agent update is held because work is running. Says in plain words what is running and that a
 * run cut off by the update may need to be resumed or rolled back; "Update anyway" sends `force: true`, "Wait" leaves everything alone.
 */
export function UpdateAnywayDialog({
  items,
  scope = "hub",
  loading = false,
  error,
  onConfirm,
  onCancel,
}: {
  items: readonly InFlightItem[];
  scope?: "hub" | "agent";
  loading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const title = t("inFlight.updateAnywayTitle");
  return (
    <Modal onClose={loading ? () => undefined : onCancel} ariaLabel={title} zIndex={70} width={480}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>{title}</h2>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 8px", lineHeight: 1.5 }}>{t(scope === "agent" ? "inFlight.updateAnywayAgentBody" : "inFlight.updateAnywayBody")}</p>
      <InFlightList items={items} testId="update-anyway-list" />
      {error && (
        <p role="alert" style={{ fontSize: 12, color: "var(--c-r)", margin: "10px 0 0", overflowWrap: "anywhere" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 16 }}>
        <Btn variant="ghost" onClick={onCancel} disabled={loading}>
          {t("inFlight.wait")}
        </Btn>
        <Btn variant="danger" onClick={onConfirm} loading={loading}>
          {t("inFlight.updateAnyway")}
        </Btn>
      </div>
    </Modal>
  );
}
