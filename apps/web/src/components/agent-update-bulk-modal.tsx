"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { bulkSummary } from "../lib/bulk";
import { useT } from "../i18n/provider";
import type { AgentUpdateItem, ServerView } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

/**
 * Update the Tugra agent across many selected servers at once (fleet op). The hub signs a digest-pinned
 * update per server from its ed25519-verified release manifest — the request never names a version/image.
 * Non-writable servers are skipped (not errored); already-current and offline ones report their own status.
 */
export function AgentUpdateBulkModal({
  servers,
  selectedIds,
  onClose,
}: {
  servers: ServerView[];
  selectedIds: string[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const sum = bulkSummary(servers, new Set(selectedIds));
  const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? id;

  const apply = useMutation({
    mutationFn: () => api.bulkUpdateAgent(selectedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
  });

  const rowLabel = (r: AgentUpdateItem): string => {
    if (r.status === "sent") return t("bulk.agentSent");
    if (r.status === "offline") return t("bulk.offline");
    const reasons: Record<string, string> = {
      "already-current": "bulk.agentCurrent",
      "no-digest-for-arch": "bulk.agentNoDigest",
      "capability-not-granted": "bulk.agentCapability",
      "not-permitted": "bulk.agentNotPermitted",
    };
    return t(reasons[r.reason ?? ""] ?? "bulk.agentSkipped");
  };
  const rowColor = (r: AgentUpdateItem) => (r.status === "sent" ? "var(--c-g)" : "var(--c-am)");

  const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--c-bd)" };

  return (
    <Modal
      ariaLabel={t("bulk.agentUpdateTitle", { n: selectedIds.length })}
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "10vh" }}
      cardStyle={{ width: 540, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("bulk.agentUpdateTitle", { n: selectedIds.length })}</h2>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("bulk.agentUpdateHint")}</p>

      {!apply.data ? (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>
            {t("bulk.summary", { writable: sum.writable, skipped: sum.skipped })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn type="button" onClick={() => apply.mutate()} disabled={apply.isPending || sum.writable === 0}>
              {apply.isPending ? t("bulk.applying") : t("bulk.applyAgentUpdate")}
            </Btn>
          </div>
          {apply.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(apply.error as Error)?.message}</div>}
        </>
      ) : apply.data.status !== "ok" ? (
        <div>
          <div style={{ fontSize: 13, color: "var(--c-r)", marginBottom: 12 }}>
            {apply.data.status === "unconfigured" ? t("bulk.agentUnconfigured") : t("bulk.agentError")}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("bulk.close")}</Btn>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {t("bulk.agentUpdateResult", { sent: apply.data.sent, offline: apply.data.offline, skipped: apply.data.skipped })}
          </div>
          <div style={{ marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
            {apply.data.results.map((r) => (
              <div key={r.serverId} style={rowStyle}>
                <span style={{ fontWeight: 600 }}>{nameOf(r.serverId)}</span>
                <span style={{ color: rowColor(r) }}>{rowLabel(r)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("bulk.close")}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
