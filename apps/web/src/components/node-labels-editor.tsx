"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

const field: React.CSSProperties = {
  padding: "5px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
};

/** Per-node docker label editor. Feeds the placement picker's label rules. Chips remove a label;
 *  the key+value form adds one. Both invalidate the shared ["swarm", clusterId] query. */
export function NodeLabelsEditor({ clusterId, nodeId, labels }: { clusterId: string; nodeId: string; labels: Record<string, string> }) {
  const t = useT();
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const mut = useMutation({
    mutationFn: (body: { add: Record<string, string>; remove: string[] }) => api.setNodeLabels(clusterId, nodeId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swarm", clusterId] }),
  });
  const entries = Object.entries(labels);

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", flexBasis: "100%", marginTop: 4 }}>
      {entries.map(([k, v]) => (
        <span key={k} style={{ ...field, display: "inline-flex", gap: 6, alignItems: "center" }}>
          {k}={v}
          <button type="button" aria-label={t("clusters.nodeLabelRemove")} onClick={() => mut.mutate({ add: {}, remove: [k] })} style={{ cursor: "pointer", background: "none", border: "none", color: "var(--c-r)", padding: 0 }}>×</button>
        </span>
      ))}
      <input style={{ ...field, width: 90 }} placeholder={t("clusters.nodeLabelKey")} value={key} onChange={(e) => setKey(e.target.value)} />
      <input style={{ ...field, width: 90 }} placeholder={t("clusters.nodeLabelValue")} value={value} onChange={(e) => setValue(e.target.value)} />
      <Btn
        variant="ghost"
        style={{ fontSize: 11, padding: "4px 8px" }}
        disabled={mut.isPending || !key.trim() || !value.trim()}
        onClick={() => mut.mutate({ add: { [key.trim()]: value.trim() }, remove: [] }, { onSuccess: () => { setKey(""); setValue(""); } })}
      >
        {t("clusters.nodeLabelAdd")}
      </Btn>
      {mut.isError && <span style={{ fontSize: 11, color: "var(--c-r)" }}>{mut.error instanceof Error ? mut.error.message : t("clusters.nodeLabelFailed")}</span>}
    </div>
  );
}
