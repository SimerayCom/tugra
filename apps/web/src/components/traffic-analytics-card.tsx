"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { TrafficAnalyticsState } from "../lib/types";
import type { ToastType } from "../lib/toast-bus";
import { useT } from "../i18n/provider";
import { SectionCard } from "./ui";
import { useToast } from "./toast";

/** Per-server Traffic Analytics opt-in (the proxy writes a local JSON access log the Traffic page reads).
 *  Writers toggle it; a viewer sees the state read-only. The toast reflects how the proxy re-apply went. */
export function TrafficAnalyticsCard({ id, enabled, canWrite }: { id: string; enabled: boolean; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();

  const set = useMutation({
    mutationFn: (next: boolean) => api.setServerTrafficAnalytics(id, next),
    onSuccess: (r: TrafficAnalyticsState) => {
      const [message, type] = applyToast(r, t);
      toast(message, type);
      // Returned so the mutation stays pending until the refetch lands; otherwise the box would briefly show the stale prop.
      return Promise.all([qc.invalidateQueries({ queryKey: ["server", id] }), qc.invalidateQueries({ queryKey: ["servers"] })]);
    },
    onError: (e) => toast(`${t("traffic.toggleError")}: ${(e as Error).message}`, "error"),
  });

  // While a change is in flight show the requested value so the control feels instant.
  const checked = set.isPending ? !!set.variables : enabled;

  return (
    <SectionCard title={t("traffic.toggleTitle")} desc={t("traffic.toggleDesc")} style={{ marginTop: 20 }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)" }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!canWrite || set.isPending}
          onChange={(e) => set.mutate(e.target.checked)}
        />
        {t("traffic.toggleLabel")}
      </label>
      {!canWrite && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("traffic.toggleReadOnly")}</p>}
    </SectionCard>
  );
}

function applyToast(r: TrafficAnalyticsState, t: (k: string, v?: Record<string, string | number>) => string): [string, ToastType] {
  switch (r.apply) {
    case "applied":
      return [t(r.trafficAnalytics ? "traffic.toggleOn" : "traffic.toggleOff"), "success"];
    case "deferred":
      return [t("traffic.toggleDeferred"), "info"];
    case "failed":
      return [r.applyError ? t("traffic.toggleFailedDetail", { error: r.applyError }) : t("traffic.toggleFailed"), "error"];
    case "not-in-pool":
      return [t("traffic.toggleNotInPool"), "info"];
    case "cluster-shared":
      return [t("traffic.toggleClusterShared"), "info"];
  }
}
