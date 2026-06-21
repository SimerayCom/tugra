"use client";

import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { monitorColor, uptimeText } from "../../../../lib/monitors";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner } from "../../../../components/ui";

export default function MonitorDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();

  const { data: m, isLoading } = useQuery({
    queryKey: ["monitor", id],
    queryFn: () => api.getMonitor(id),
    refetchInterval: 5000,
  });
  const { data: beats = [] } = useQuery({
    queryKey: ["heartbeats", id],
    queryFn: () => api.getHeartbeats(id, 60),
    refetchInterval: 5000,
  });
  const { data: uptime } = useQuery({
    queryKey: ["uptime", id],
    queryFn: () => api.getUptime(id),
    refetchInterval: 30000,
  });

  const check = useMutation({
    mutationFn: () => api.checkMonitor(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["heartbeats", id] });
      qc.invalidateQueries({ queryKey: ["monitor", id] });
    },
  });

  if (isLoading || !m) return <div style={{ padding: 28 }}><Spinner /></div>;

  return (
    <div style={{ padding: 28 }}>
      <BackLink href="/monitors" label={t("common.backTo", { target: t("nav.uptime") })} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: monitorColor(m.status) }} />
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{m.name}</h1>
      </div>
      <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: "0 0 18px" }}>{m.type} · {m.target}</p>

      <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <Card style={{ padding: 16, flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.status")}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: monitorColor(m.status) }}>{m.status}</div>
        </Card>
        <Card style={{ padding: 16, flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.uptime24h")}</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{uptime ? uptimeText(uptime.percent) : "—"}</div>
        </Card>
        <Card style={{ padding: 16, display: "flex", alignItems: "center" }}>
          {m.canWrite && (
            <Btn variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? "…" : t("monitors.checkNow")}
            </Btn>
          )}
        </Card>
      </div>

      <Card style={{ padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("monitors.lastChecks")}</div>
        <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 40, marginBottom: 14 }}>
          {beats.map((b, i) => (
            <span key={i} title={`${b.status} · ${b.ms}ms`} style={{ width: 6, height: 40, borderRadius: 2, background: monitorColor(b.status), opacity: 0.85 }} />
          ))}
          {beats.length === 0 && <span style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("monitors.noChecks")}</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[...beats].reverse().slice(0, 8).map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 10, fontSize: 12 }}>
              <span style={{ color: monitorColor(b.status), fontWeight: 600, width: 60 }}>{b.status}</span>
              <span className="mono" style={{ color: "var(--c-tx3)", width: 60 }}>{b.ms}ms</span>
              <span style={{ color: "var(--c-tx2)" }}>{b.msg ?? ""}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
