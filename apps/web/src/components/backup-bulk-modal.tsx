"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { bulkSummary } from "../lib/bulk";
import { useT } from "../i18n/provider";
import type { Database } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

const numField: React.CSSProperties = {
  width: 90, padding: "6px 8px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13,
};

/** Apply one backup schedule to many selected databases (fleet bulk op). */
export function BackupBulkModal({
  databases,
  selectedIds,
  onClose,
}: {
  databases: Database[];
  selectedIds: string[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [intervalH, setIntervalH] = useState("24");
  const [retention, setRetention] = useState("7");
  const sum = bulkSummary(databases, new Set(selectedIds));

  const apply = useMutation({
    mutationFn: () => api.bulkSetBackupConfig(selectedIds, {
      enabled,
      intervalHours: Number(intervalH) || 24,
      retention: Number(retention) || 7,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["databases"] }),
  });
  const result = apply.data;

  return (
    <Modal
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "10vh" }}
      cardStyle={{ width: 520, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 14px" }}>{t("bulk.backupTitle", { n: selectedIds.length })}</h2>

      {!result ? (
        <form onSubmit={(e) => { e.preventDefault(); apply.mutate(); }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 10 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("databases.schedule")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 10 }}>
            {t("databases.every")}
            <input type="number" min={1} value={intervalH} onChange={(e) => setIntervalH(e.target.value)} style={numField} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 14 }}>
            {t("databases.keep")}
            <input type="number" min={1} value={retention} onChange={(e) => setRetention(e.target.value)} style={numField} />
          </label>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
            {t("bulk.summary", { writable: sum.writable, skipped: sum.skipped })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn type="submit" disabled={apply.isPending || sum.writable === 0}>{apply.isPending ? "…" : t("bulk.applyBackup")}</Btn>
          </div>
          {apply.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(apply.error as Error).message}</div>}
        </form>
      ) : (
        <div>
          <div style={{ fontSize: 13, marginBottom: 14 }}>{t("bulk.backupResult", { applied: result.applied.length, skipped: result.skipped.length })}</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("bulk.close")}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
