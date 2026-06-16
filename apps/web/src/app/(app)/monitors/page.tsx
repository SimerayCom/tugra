"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { monitorColor } from "../../../lib/monitors";
import { useT } from "../../../i18n/provider";
import { Card, Spinner } from "../../../components/ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function MonitorsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: monitors = [], isLoading } = useQuery({
    queryKey: ["monitors"],
    queryFn: () => api.listMonitors(),
    refetchInterval: 10000,
  });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });

  const [name, setName] = useState("");
  const [type, setType] = useState<"HTTP" | "TCP" | "METRIC">("HTTP");
  const [target, setTarget] = useState("");
  const [serverId, setServerId] = useState("");
  const [metric, setMetric] = useState<"DISK" | "CPU" | "MEM">("DISK");
  const [thresholdPct, setThresholdPct] = useState("80");
  const [teamId, setTeamId] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createMonitor(
        type === "METRIC"
          ? {
              name,
              type,
              serverId: serverId || servers[0]?.id,
              metric,
              thresholdPct: Number(thresholdPct) || 80,
              teamId: teamId || teams[0]?.id,
            }
          : { name, type, target, teamId: teamId || teams[0]?.id },
      ),
    onSuccess: () => {
      setName("");
      setTarget("");
      qc.invalidateQueries({ queryKey: ["monitors"] });
    },
  });

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("monitors.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("monitors.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, flex: 1, minWidth: 120 }} placeholder={t("monitors.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <select style={field} value={type} onChange={(e) => setType(e.target.value as "HTTP" | "TCP" | "METRIC")}>
            <option value="HTTP">HTTP</option>
            <option value="TCP">TCP</option>
            <option value="METRIC">{t("monitors.metric")}</option>
          </select>
          {type === "METRIC" ? (
            <>
              <select style={field} value={serverId} onChange={(e) => setServerId(e.target.value)}>
                <option value="">{servers[0]?.name ?? t("monitors.server")}</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select style={field} value={metric} onChange={(e) => setMetric(e.target.value as "DISK" | "CPU" | "MEM")}>
                <option value="DISK">{t("monitors.disk")}</option>
                <option value="CPU">CPU</option>
                <option value="MEM">{t("monitors.mem")}</option>
              </select>
              <input style={{ ...field, width: 110 }} type="number" placeholder={t("monitors.threshold")} value={thresholdPct} onChange={(e) => setThresholdPct(e.target.value)} />
            </>
          ) : (
            <input style={{ ...field, flex: 2, minWidth: 180 }} placeholder={type === "HTTP" ? t("monitors.targetHttp") : t("monitors.targetTcp")} value={target} onChange={(e) => setTarget(e.target.value)} required />
          )}
          <select style={field} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{teams[0]?.name ?? t("common.pickTeam")}</option>
            {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </select>
          <button type="submit" disabled={create.isPending} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("monitors.add")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {monitors.map((m) => (
            <Link key={m.id} href={`/monitors/${m.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: monitorColor(m.status) }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{m.type} · {m.target}</div>
              </div>
              <span style={{ fontSize: 12, color: monitorColor(m.status), fontWeight: 600 }}>{m.status}</span>
            </Link>
          ))}
          {monitors.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("monitors.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
