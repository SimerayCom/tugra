"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { bulkSummary } from "../lib/bulk";
import { BULK_PRESETS } from "../lib/bulk-presets";
import { useT } from "../i18n/provider";
import type { BulkTaskStatus, ServerView } from "../lib/types";
import { Modal } from "./modal";
import { Btn } from "./ui";

function taskColor(s: BulkTaskStatus): string {
  if (s === "DONE") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  if (s === "RUNNING") return "var(--c-am)";
  return "var(--c-tx3)";
}

export function BulkRunModal({
  servers,
  selectedIds,
  onClose,
}: {
  servers: ServerView[];
  selectedIds: string[];
  onClose: () => void;
}) {
  const t = useT();
  const [command, setCommand] = useState("");
  const [opId, setOpId] = useState<string | null>(null);
  const sum = bulkSummary(servers, new Set(selectedIds));

  const run = useMutation({
    mutationFn: () => api.runBulk(selectedIds, command),
    onSuccess: (r) => setOpId(r.opId),
  });
  const op = useQuery({
    queryKey: ["bulk", opId],
    queryFn: () => api.getBulk(opId!),
    enabled: !!opId,
    refetchInterval: 1500,
  });

  return (
    <Modal
      ariaLabel={t("bulk.title", { n: selectedIds.length })}
      onClose={onClose}
      zIndex={9000}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "10vh" }}
      cardStyle={{ width: 600, maxWidth: "92vw", background: "var(--c-sb)", padding: 20, maxHeight: "76vh", overflowY: "auto" }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 14px" }}>{t("bulk.title", { n: selectedIds.length })}</h2>

        {!opId ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6 }}>{t("bulk.presets")}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {BULK_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setCommand(p.command)}
                  style={{ fontFamily: "inherit", fontSize: 12, cursor: "pointer", border: "1px solid var(--c-bd)", background: command === p.command ? "var(--c-ad)" : "transparent", color: command === p.command ? "var(--c-a)" : "var(--c-tx2)", borderRadius: 999, padding: "4px 11px" }}
                >
                  {t(`bulk.${p.labelKey}`)}
                </button>
              ))}
            </div>
            <input
              autoFocus
              className="mono"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("bulk.placeholder")}
              style={{ width: "100%", padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, marginBottom: 10 }}
              required
            />
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
              {t("bulk.summary", { writable: sum.writable, skipped: sum.skipped })}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="ghost" type="button" onClick={onClose}>{t("bulk.close")}</Btn>
              <Btn type="submit" disabled={run.isPending || sum.writable === 0}>{run.isPending ? "…" : t("bulk.run")}</Btn>
            </div>
          </form>
        ) : (
          <div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
              {(op.data?.tasks ?? []).map((task) => (
                <div key={task.id} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="mono" style={{ fontSize: 12, flex: 1, color: "var(--c-tx2)" }}>{task.serverId.slice(0, 10)}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: taskColor(task.status) }}>{task.status}</span>
                    {task.exitCode != null && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("bulk.exit", { code: task.exitCode })}</span>}
                  </div>
                  {task.output && (
                    <pre className="mono" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{task.output}</pre>
                  )}
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
