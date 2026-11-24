"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { Btn } from "./ui";

/**
 * "3/24 agents are on an older version" with a one-click "Update all". Counts only the remote agents of teams the
 * caller manages (the hub decides; a viewer never sees it). With "Apply updates automatically" on, the hub already
 * rolls them out one by one, and the line says so; the button stays for anyone who does not want to wait.
 */
export function AgentFleetNotice() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["agentFleetStatus"],
    queryFn: () => api.getAgentFleetStatus(),
    refetchInterval: 15_000,
    retry: false,
  });
  const updateAll = useMutation({
    mutationFn: () => api.updateOutdatedAgents(),
    onSuccess: (res) => {
      if (res.status === "hub-behind") toast(t("servers.agentFleetHubBehind"), "info");
      else if (res.status === "ok" && res.sent > 0) toast(t("servers.agentFleetSent", { n: res.sent }), "success");
      else toast(t("servers.agentFleetNone"), "info");
      void qc.invalidateQueries({ queryKey: ["agentFleetStatus"] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("servers.agentFleetFailed"), "error"),
  });
  if (!data || data.outdated === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "space-between",
        padding: "10px 14px", marginBottom: 16, border: "1px solid var(--c-bd)", borderLeft: "3px solid var(--c-am)",
        borderRadius: "var(--r2, 8px)", background: "var(--c-el)",
      }}
    >
      <div style={{ minWidth: 200 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t("servers.agentFleetBehind", { n: data.outdated, total: data.total })}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t(!data.autoUpdate ? "servers.agentFleetManual" : data.hubBehind ? "servers.agentFleetWaitingHub" : "servers.agentFleetAuto")}</div>
      </div>
      <Btn variant="ghost" style={{ minHeight: 44 }} onClick={() => updateAll.mutate()} loading={updateAll.isPending} disabled={updateAll.isPending}>
        {t("servers.agentFleetUpdateAll")}
      </Btn>
    </div>
  );
}
