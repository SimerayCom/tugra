"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { bulkSummary } from "../lib/bulk";
import { useT } from "../i18n/provider";
import type { ServerView } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

/** Apply one Docker-cleanup schedule to many selected servers (fleet bulk op). */
export function CleanupBulkModal({
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
  const [enabled, setEnabled] = useState(true);
  const [intervalH, setIntervalH] = useState("24");
  const [volumes, setVolumes] = useState(false);
  const sum = bulkSummary(servers, new Set(selectedIds));

  const apply = useMutation({
    mutationFn: () => api.bulkSetCleanupConfig(selectedIds, { enabled, intervalHours: Number(intervalH) || 24, volumes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
  });
  const result = apply.data;

  return (
    <Modal
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "10vh" }}
      cardStyle={{ width: 520, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 14px" }}>{t("bulk.cleanupTitle", { n: selectedIds.length })}</h2>

      {!result ? (
        <form onSubmit={(e) => { e.preventDefault(); apply.mutate(); }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 10 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("servers.cleanupSchedule")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 10 }}>
            {t("servers.cleanupEvery")}
            <input
              type="number"
              min={1}
              value={intervalH}
              onChange={(e) => setIntervalH(e.target.value)}
              style={{ width: 90, padding: "6px 8px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13 }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginBottom: 14 }}>
            <input type="checkbox" checked={volumes} onChange={(e) => setVolumes(e.target.checked)} />
            {t("servers.cleanupVolumes")}
          </label>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
            {t("bulk.summary", { writable: sum.writable, skipped: sum.skipped })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
            <Btn type="submit" disabled={apply.isPending || sum.writable === 0}>{apply.isPending ? "…" : t("bulk.applyCleanup")}</Btn>
          </div>
          {apply.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(apply.error as Error).message}</div>}
        </form>
      ) : (
        <div>
          <div style={{ fontSize: 13, marginBottom: 14 }}>{t("bulk.cleanupResult", { applied: result.applied.length, skipped: result.skipped.length })}</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("bulk.close")}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
