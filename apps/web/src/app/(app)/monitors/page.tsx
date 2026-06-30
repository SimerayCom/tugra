"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api } from "../../../lib/api";
import { scopeByTeam } from "../../../lib/team-scope";
import { writableIds } from "../../../lib/fleet";
import { monitorColor } from "../../../lib/monitors";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { Field, Select, TextInput } from "../../../components/form";
import { MonitorFavicon } from "../../../components/monitor-favicon";
import { MonitorChannelsBulkModal } from "../../../components/monitor-channels-bulk-modal";

const formGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  alignItems: "end",
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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showChannels, setShowChannels] = useState(false);
  const writable = writableIds(monitors, selected);
  const skipped = selected.size - writable.length;
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });

  const [name, setName] = useState("");
  const [type, setType] = useState<"HTTP" | "TCP" | "METRIC">("HTTP");
  const [target, setTarget] = useState("");
  const [serverId, setServerId] = useState("");
  const [metric, setMetric] = useState<"DISK" | "CPU" | "MEM">("DISK");
  const [thresholdPct, setThresholdPct] = useState("80");
  const [teamId, setTeamId] = useState("");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const teamChannels = scopeByTeam(channels, teamId);
  useEffect(() => { setChannelIds([]); }, [teamId]); // channels are team-scoped
  const toggleChannel = (cid: string) =>
    setChannelIds((cur) => (cur.includes(cid) ? cur.filter((x) => x !== cid) : [...cur, cid]));
  const [intervalSec, setIntervalSec] = useState("30");
  const [retries, setRetries] = useState("1");
  const [timeoutMs, setTimeoutMs] = useState("10000");

  const tuning = {
    intervalSec: Math.max(10, Number(intervalSec) || 30),
    retries: Math.max(0, Number(retries) || 0),
    timeoutMs: Math.max(1000, Number(timeoutMs) || 10000),
  };
  const noServer = type === "METRIC" && servers.length === 0;

  const create = useMutation({
    mutationFn: () =>
      api.createMonitor(
        type === "METRIC"
          ? {
              name,
              type,
              serverId,
              metric,
              thresholdPct: Number(thresholdPct) || 80,
              teamId,
              channelIds,
              ...tuning,
            }
          : { name, type, target, teamId, channelIds, ...tuning },
      ),
    onSuccess: () => {
      setName("");
      setTarget("");
      setChannelIds([]);
      qc.invalidateQueries({ queryKey: ["monitors"] });
    },
  });

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("monitors.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("monitors.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div style={formGrid}>
            <Field label={t("monitors.name")} htmlFor="mon-name">
              <TextInput id="mon-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label={t("monitors.typeLabel")}>
              <Select
                value={type}
                onChange={(v) => setType(v as "HTTP" | "TCP" | "METRIC")}
                options={[
                  { value: "HTTP", label: "HTTP" },
                  { value: "TCP", label: "TCP" },
                  { value: "METRIC", label: t("monitors.metric") },
                ]}
              />
            </Field>
            {type === "METRIC" ? (
              <>
                <Field label={t("monitors.server")}>
                  <Select value={serverId} onChange={setServerId} required placeholder={t("monitors.server")}
                    options={servers.map((s) => ({ value: s.id, label: s.name }))} />
                </Field>
                <Field label={t("monitors.metric")}>
                  <Select value={metric} onChange={(v) => setMetric(v as "DISK" | "CPU" | "MEM")}
                    options={[
                      { value: "DISK", label: t("monitors.disk") },
                      { value: "CPU", label: "CPU" },
                      { value: "MEM", label: t("monitors.mem") },
                    ]} />
                </Field>
                <Field label={t("monitors.threshold")}>
                  <TextInput type="number" value={thresholdPct} onChange={(e) => setThresholdPct(e.target.value)} />
                </Field>
              </>
            ) : (
              <Field label={type === "HTTP" ? t("monitors.targetHttp") : t("monitors.targetTcp")} style={{ gridColumn: "span 2" }}>
                <TextInput value={target} onChange={(e) => setTarget(e.target.value)} required
                  placeholder={type === "HTTP" ? "https://example.com" : "host:port"} />
              </Field>
            )}
            <Field label={t("common.team")}>
              <Select value={teamId} onChange={setTeamId} autoSelectFirst required placeholder={t("common.pickTeam")}
                options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
            </Field>
            <Field label={t("monitors.intervalSec")} hint={t("monitors.intervalHint")}>
              <TextInput type="number" min={10} value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} />
            </Field>
            <Field label={t("monitors.retries")}>
              <TextInput type="number" min={0} value={retries} onChange={(e) => setRetries(e.target.value)} />
            </Field>
            <Field label={t("monitors.timeoutMs")}>
              <TextInput type="number" min={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("monitors.channels")}</div>
            {teamChannels.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {teamChannels.map((c) => (
                  <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={channelIds.includes(c.id)} onChange={() => toggleChannel(c.id)} />
                    {c.name}
                  </label>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>
                {t("monitors.channelsEmpty")} <Link href="/notifications" style={{ color: "var(--c-a)" }}>{t("monitors.createChannel")}</Link>
              </div>
            )}
          </div>
          <div style={{ marginTop: 14 }}>
            <Btn type="submit" disabled={create.isPending || noServer}>
              {create.isPending ? "…" : t("monitors.add")}
            </Btn>
          </div>
        </form>
        {noServer && (
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10 }}>
            {t("monitors.needServer")} <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("monitors.addServer")}</Link>
          </div>
        )}
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {monitors.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)" }}>
              <input
                type="checkbox"
                disabled={!m.canWrite}
                checked={selected.has(m.id)}
                onChange={() => toggleSel(m.id)}
                title={m.canWrite ? "" : t("servers.readonly")}
                style={{ flexShrink: 0 }}
              />
              <Link href={`/monitors/${m.id}`} style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, textDecoration: "none", color: "var(--c-tx)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: monitorColor(m.status), flexShrink: 0 }} />
                <MonitorFavicon type={m.type} target={m.target} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    {m.name}
                    {m.auto && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--c-tx3)", border: "1px solid var(--c-bd)", borderRadius: 4, padding: "0 5px" }}>{t("monitors.autoBadge")}</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{m.type} · {m.target}</div>
                </div>
                <span style={{ fontSize: 12, color: monitorColor(m.status), fontWeight: 600 }}>{m.status}</span>
              </Link>
            </div>
          ))}
          {monitors.length === 0 && (
            <EmptyState icon={Activity} title={t("monitors.emptyTitle")}>{t("monitors.empty")}</EmptyState>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div style={{ position: "sticky", bottom: 16, marginTop: 16, display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "var(--c-sb)", border: "1px solid var(--c-a)", borderRadius: "var(--r2)", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t("servers.selected", { n: writable.length })}
            {skipped > 0 && <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}> {t("servers.skipped", { n: skipped })}</span>}
          </span>
          <div style={{ flex: 1 }} />
          <Btn onClick={() => setShowChannels(true)} disabled={writable.length === 0}>{t("bulk.applyChannels")}</Btn>
        </div>
      )}
      {showChannels && (
        <MonitorChannelsBulkModal monitors={monitors} selectedIds={[...selected]} onClose={() => setShowChannels(false)} />
      )}
    </div>
  );
}
