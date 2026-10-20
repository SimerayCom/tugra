"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import type { Placement, PlacementConstraint } from "../lib/types";

const field: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
};

const MAX_RULES = 10;

/**
 * Live-node-sourced Swarm placement rule builder. Every value in every dropdown comes from the
 * cluster's live `docker node` data (hostnames, roles, label keys/values) — never a free-text box — so an
 * operator can't pin to a node or label that doesn't exist. Renders inside the Cluster deploy card.
 */
export function PlacementPicker({ appId, clusterId, initial, canWrite }: { appId: string; clusterId: string; initial: Placement; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: swarm } = useQuery({ queryKey: ["swarm", clusterId], queryFn: () => api.getSwarmStatus(clusterId) });
  const live = swarm?.live ?? [];
  const hostnames = live.map((n) => n.hostname).filter(Boolean);
  const labelKeys = [...new Set(live.flatMap((n) => Object.keys(n.labels)))];
  const valuesFor = (key: string) => [...new Set(live.map((n) => n.labels[key]).filter(Boolean))];

  const [constraints, setConstraints] = useState<PlacementConstraint[]>(initial.constraints);
  const [spreadLabelKey, setSpreadLabelKey] = useState<string | null>(initial.spreadLabelKey);
  // Reset in-progress edits when the app switches clusters (placement references a specific cluster's nodes).
  // Keyed on clusterId only — NOT on `initial` — so a save→refetch on the SAME cluster doesn't clobber edits.
  useEffect(() => {
    setConstraints(initial.constraints);
    setSpreadLabelKey(initial.spreadLabelKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);
  // Order-insensitive dirty check: a JSONB round-trip can reorder each constraint's keys, so compare with
  // per-constraint key-sorted canonical forms (array order is stable and IS significant).
  const canon = (cs: PlacementConstraint[], s: string | null) =>
    JSON.stringify([cs.map((c) => JSON.stringify(Object.keys(c).sort().map((k) => [k, (c as Record<string, unknown>)[k]]))), s]);
  const dirty = canon(constraints, spreadLabelKey) !== canon(initial.constraints, initial.spreadLabelKey);

  const save = useMutation({
    mutationFn: () => api.setAppPlacement(appId, { constraints, spreadLabelKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", appId] }),
  });

  const addRule = () => {
    const rule: PlacementConstraint = hostnames.length
      ? { type: "hostname", op: "eq", value: hostnames[0] }
      : { type: "role", op: "eq", value: "worker" };
    setConstraints((c) => [...c, rule]);
  };
  const update = (i: number, rule: PlacementConstraint) => setConstraints((c) => c.map((x, j) => (j === i ? rule : x)));
  const removeRule = (i: number) => setConstraints((c) => c.filter((_, j) => j !== i));

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx)", fontWeight: 600, marginBottom: 2 }}>{t("apps.placementTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 10px" }}>{t("apps.placementDesc")}</p>

      {live.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.placementNoLiveNodes")}</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {constraints.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  aria-label={t("apps.placementRuleType")}
                  style={{ ...field, flex: "0 1 120px" }}
                  value={c.type === "nodeId" ? "hostname" : c.type}
                  disabled={!canWrite}
                  onChange={(e) => {
                    const type = e.target.value as "hostname" | "role" | "label";
                    if (type === "hostname") update(i, { type: "hostname", op: c.op, value: hostnames[0] ?? "" });
                    else if (type === "role") update(i, { type: "role", op: c.op, value: "worker" });
                    else update(i, { type: "label", op: c.op, key: labelKeys[0] ?? "", value: valuesFor(labelKeys[0] ?? "")[0] ?? "" });
                  }}
                >
                  <option value="hostname">{t("apps.placementRuleNode")}</option>
                  <option value="role">{t("apps.placementRuleRole")}</option>
                  <option value="label">{t("apps.placementRuleLabel")}</option>
                </select>
                <select aria-label={t("apps.placementOp")} style={{ ...field, flex: "0 1 90px" }} value={c.op} disabled={!canWrite} onChange={(e) => update(i, { ...c, op: e.target.value as "eq" | "ne" })}>
                  <option value="eq">{t("apps.placementOpIs")}</option>
                  <option value="ne">{t("apps.placementOpIsNot")}</option>
                </select>
                {(c.type === "hostname" || c.type === "nodeId") && (
                  <select aria-label={t("apps.placementRuleNode")} style={{ ...field, flex: "1 1 140px" }} value={c.value} disabled={!canWrite} onChange={(e) => update(i, { type: "hostname", op: c.op, value: e.target.value })}>
                    {/* Show the true stored value even when its node is no longer live, instead of silently
                        defaulting the controlled select to the first live option (which would misrepresent the pin). */}
                    {!hostnames.includes(c.value) && (
                      <option value={c.value} disabled>{(live.find((n) => n.id === c.value)?.hostname ?? c.value)} ({t("apps.placementNotLive")})</option>
                    )}
                    {hostnames.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                )}
                {c.type === "role" && (
                  <select aria-label={t("apps.placementRuleRole")} style={{ ...field, flex: "1 1 140px" }} value={c.value} disabled={!canWrite} onChange={(e) => update(i, { type: "role", op: c.op, value: e.target.value as "manager" | "worker" })}>
                    <option value="manager">{t("apps.placementRoleManager")}</option>
                    <option value="worker">{t("apps.placementRoleWorker")}</option>
                  </select>
                )}
                {c.type === "label" && (
                  labelKeys.length === 0 ? (
                    <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.placementNoLabels")}</span>
                  ) : (
                    <>
                      <select aria-label={t("apps.placementRuleLabel")} style={{ ...field, flex: "1 1 100px" }} value={c.key} disabled={!canWrite} onChange={(e) => update(i, { type: "label", op: c.op, key: e.target.value, value: valuesFor(e.target.value)[0] ?? "" })}>
                        {labelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <select aria-label={t("apps.placementLabelValue")} style={{ ...field, flex: "1 1 100px" }} value={c.value} disabled={!canWrite} onChange={(e) => update(i, { ...c, value: e.target.value })}>
                        {valuesFor(c.key).map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </>
                  )
                )}
                {canWrite && (
                  <button type="button" aria-label={t("apps.placementRemoveRule")} onClick={() => removeRule(i)} style={{ ...field, cursor: "pointer", width: 30 }}>×</button>
                )}
              </div>
            ))}
          </div>

          {canWrite && constraints.length < MAX_RULES && (
            <button type="button" onClick={addRule} style={{ ...field, cursor: "pointer", marginTop: 8 }}>{t("apps.placementAddRule")}</button>
          )}

          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.placementSpreadLabel")}</span>
            <select aria-label={t("apps.placementSpreadLabel")} style={{ ...field, flex: "1 1 140px" }} value={spreadLabelKey ?? ""} disabled={!canWrite} onChange={(e) => setSpreadLabelKey(e.target.value || null)}>
              <option value="">{t("apps.placementSpreadNone")}</option>
              {labelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>

          {canWrite && (
            <div style={{ marginTop: 12 }}>
              <Btn onClick={() => save.mutate()} disabled={save.isPending || !dirty}>{t("apps.placementSave")}</Btn>
              {save.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 6 }}>{save.error instanceof Error ? save.error.message : t("apps.placementSaveFailed")}</div>}
              {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 6 }}>{t("apps.placementSaved")}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
