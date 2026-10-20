"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { bulkSummary } from "../lib/bulk";
import { useT } from "../i18n/provider";
import type { FleetPatchCheckRow, ServerView } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

/**
 * Check + apply OS package updates across many selected servers at once (fleet op). Step 1 "Check"
 * previews pending updates per server; step 2 "Apply" upgrades them. Each server is role-gated in its
 * own team on the server side — non-writable ones are skipped, not errored. Reboots are never automatic.
 */
export function PatchBulkModal({
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

  const check = useMutation({ mutationFn: () => api.bulkCheckUpdates(selectedIds) });
  const apply = useMutation({
    mutationFn: () => api.bulkUpgradeAll(selectedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
  });

  const checkLabel = (r: FleetPatchCheckRow): string => {
    if (!r.online) return t("bulk.offline");
    if (r.error || r.updates?.checkFailed) return t("bulk.checkError");
    const base = r.updates?.count ? t("bulk.updatesAvailable", { n: r.updates.count }) : t("bulk.upToDate");
    return r.updates?.rebootRequired ? `${base} · ${t("bulk.rebootRequired")}` : base;
  };

  const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--c-bd)" };

  return (
    <Modal
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "10vh" }}
      cardStyle={{ width: 540, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("bulk.patchTitle", { n: selectedIds.length })}</h2>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 14px" }}>{t("bulk.patchHint")}</p>

      {!apply.data ? (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>
            {t("bulk.summary", { writable: sum.writable, skipped: sum.skipped })}
          </div>

          {check.data && (
            <div style={{ marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
              {check.data.results.map((r) => (
                <div key={r.serverId} style={rowStyle}>
                  <span style={{ fontWeight: 600 }}>{nameOf(r.serverId)}</span>
                  <span style={{ color: !r.online || r.error || r.updates?.checkFailed ? "var(--c-am)" : r.updates?.count ? "var(--c-a)" : "var(--c-tx3)" }}>{checkLabel(r)}</span>
                </div>
              ))}
              {check.data.skipped.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 8 }}>{t("bulk.skippedN", { n: check.data.skipped.length })}</div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn variant="ghost" type="button" onClick={() => check.mutate()} disabled={check.isPending || sum.writable === 0}>
              {check.isPending ? "…" : t("bulk.checkUpdates")}
            </Btn>
            <Btn type="button" onClick={() => apply.mutate()} disabled={apply.isPending || sum.writable === 0}>
              {apply.isPending ? t("bulk.applying") : t("bulk.applyUpdates")}
            </Btn>
          </div>
          {(check.isError || apply.isError) && (
            <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
              {((check.error || apply.error) as Error)?.message}
            </div>
          )}
        </>
      ) : (
        <div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {t("bulk.patchResult", {
              applied: apply.data.results.filter((r) => r.exitCode === 0).length,
              skipped: apply.data.skipped.length,
            })}
          </div>
          <div style={{ marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
            {apply.data.results.map((r) => (
              <div key={r.serverId} style={rowStyle}>
                <span style={{ fontWeight: 600 }}>{nameOf(r.serverId)}</span>
                <span style={{ color: !r.online || r.error ? "var(--c-am)" : r.exitCode === 0 ? "var(--c-g)" : "var(--c-r)" }}>
                  {!r.online ? t("bulk.offline") : r.error ? t("bulk.checkError") : r.exitCode === 0 ? t("bulk.applied") : t("bulk.failed")}
                </span>
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
