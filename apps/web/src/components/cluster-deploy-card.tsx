"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn, Card } from "./ui";

const field: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
};

const clampReplicas = (n: number) => Math.max(1, Math.min(100, Math.floor(n) || 1));

/**
 * Node-aware replica picker + live replica panel for deploying an app as a Docker Swarm service.
 * Beyond selecting a target cluster and replica count it shows the selected cluster's node health
 * (so the operator can size replicas), warns when replicas exceed online nodes, and — once the app
 * is actually deployed to that cluster — polls a live task table (slot/node/state) every 5s. A manager
 * that can't be reached degrades to an "unavailable" hint rather than erroring.
 */
export function ClusterDeployCard({
  id,
  teamId,
  clusterId,
  replicas,
}: {
  id: string;
  teamId: string;
  clusterId: string | null;
  replicas: number | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: clusters = [] } = useQuery({ queryKey: ["clusters"], queryFn: () => api.listClusters() });
  // Only a formed swarm (ACTIVE/DEGRADED) in this team can host swarm services.
  const swarmClusters = clusters.filter((c) => c.teamId === teamId && (c.swarmStatus === "ACTIVE" || c.swarmStatus === "DEGRADED"));
  const [cluster, setCluster] = useState(clusterId ?? "");
  const [reps, setReps] = useState(replicas ?? 1);
  const save = useMutation({
    mutationFn: () => api.setAppClusterConfig(id, { clusterId: cluster || null, replicas: cluster ? clampReplicas(reps) : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  // Node health for the SELECTED cluster (DB-cheap) — helps size replicas before saving.
  const { data: detail } = useQuery({ queryKey: ["cluster", cluster], queryFn: () => api.getCluster(cluster), enabled: !!cluster });
  const onlineNodes = detail?.health.nodes.online ?? 0;
  const totalNodes = detail?.health.nodes.total ?? 0;
  const overCapacity = !!cluster && !!detail && onlineNodes > 0 && clampReplicas(reps) > onlineNodes;

  // Live replica status — only when the app is ALREADY deployed to the currently-selected cluster (an
  // unsaved new selection has no service yet). Polls every 5s; a manager error degrades to "unavailable".
  const live = cluster !== "" && cluster === clusterId;
  const { data: status } = useQuery({
    queryKey: ["cluster-status", id],
    queryFn: () => api.getAppClusterStatus(id),
    enabled: live,
    refetchInterval: live ? 5000 : false,
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.clusterDeploy")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.clusterDeployDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          style={{ ...field, flex: "1 1 200px", minWidth: 160, maxWidth: 260 }}
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          aria-label={t("apps.clusterTarget")}
        >
          <option value="">{t("apps.clusterNone")}</option>
          {swarmClusters.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {cluster && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button type="button" aria-label={t("apps.replicasDecrease")} onClick={() => setReps((r) => clampReplicas(r - 1))} style={{ ...field, cursor: "pointer", width: 32 }}>−</button>
            <input
              type="number"
              min={1}
              max={100}
              value={reps}
              onChange={(e) => setReps(clampReplicas(parseInt(e.target.value, 10)))}
              aria-label={t("apps.replicas")}
              style={{ ...field, width: 64, textAlign: "center" }}
            />
            <button type="button" aria-label={t("apps.replicasIncrease")} onClick={() => setReps((r) => clampReplicas(r + 1))} style={{ ...field, cursor: "pointer", width: 32 }}>+</button>
          </div>
        )}
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>

      {cluster && detail && (
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: onlineNodes > 0 ? "var(--c-g)" : "var(--c-r)" }}>● {t("apps.clusterNodes", { online: onlineNodes, total: totalNodes })}</span>
          {detail.servers.length > 0 && <span>{t("apps.clusterMembers", { names: detail.servers.map((s) => s.name).join(", ") })}</span>}
        </div>
      )}
      {overCapacity && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 6 }}>{t("apps.clusterCapacityWarn", { replicas: clampReplicas(reps), online: onlineNodes })}</div>}

      {live && status && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx)", marginBottom: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{t("apps.clusterLiveTasks")}</strong>
            {status.reachable && (
              <span style={{ color: status.running >= status.desired ? "var(--c-g)" : "var(--c-am)" }}>
                {t("apps.clusterRunningOf", { running: status.running, desired: status.desired })}
              </span>
            )}
          </div>
          {!status.reachable ? (
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.clusterStatusUnavailable")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {status.tasks.map((tk, i) => {
                const failed = !tk.currentState.startsWith("Running");
                return (
                  <div key={`${tk.slot}-${i}`} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline", fontSize: 12, fontFamily: "var(--font-mono, monospace)" }}>
                    <span style={{ color: "var(--c-tx)" }}>{tk.slot}</span>
                    {tk.node && <span style={{ color: "var(--c-tx3)" }}>{t("apps.clusterTaskNode", { node: tk.node })}</span>}
                    <span style={{ color: failed ? "var(--c-r)" : "var(--c-g)" }}>{tk.currentState}{tk.error ? ` — ${tk.error}` : ""}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {cluster && cluster !== clusterId && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.clusterSaveToDeploy")}</div>}

      {cluster && <div style={{ fontSize: 11, color: "var(--c-am)", marginTop: 8 }}>{t("apps.clusterDeployNote")}</div>}
      {swarmClusters.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.clusterNoSwarms")}</div>}
      {save.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{save.error instanceof Error ? save.error.message : t("apps.clusterSaveFailed")}</div>}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}
