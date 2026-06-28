"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { scopeByTeam } from "../../../../lib/team-scope";
import { monitorColor, uptimeText } from "../../../../lib/monitors";
import type { Monitor } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { Field, TextInput } from "../../../../components/form";
import { MonitorFavicon } from "../../../../components/monitor-favicon";

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

  if (isLoading || !m) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.uptime"), href: "/monitors" }, { label: m.name }]}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <MonitorFavicon type={m.type} target={m.target} size={20} /> {m.name}
          </span>
        }
        status={{ label: m.status, color: monitorColor(m.status) }}
        actions={
          m.canWrite ? (
            <Btn variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? "…" : t("monitors.checkNow")}
            </Btn>
          ) : undefined
        }
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>{m.type} · {m.target}</p>
      </PageHeader>

      <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <Card style={{ padding: 16, flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.uptime24h")}</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{uptime ? uptimeText(uptime.percent) : "—"}</div>
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

      {m.canWrite && <MonitorSettings monitor={m} />}
    </div>
  );
}

function MonitorSettings({ monitor }: { monitor: Monitor }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });
  const teamChannels = scopeByTeam(channels, monitor.teamId);

  const [intervalSec, setIntervalSec] = useState(String(monitor.intervalSec));
  const [retries, setRetries] = useState(String(monitor.retries));
  const [timeoutMs, setTimeoutMs] = useState(String(monitor.timeoutMs));
  const [enabled, setEnabled] = useState(monitor.enabled);
  const [channelIds, setChannelIds] = useState<string[]>(monitor.channelIds);

  const save = useMutation({
    mutationFn: () =>
      api.updateMonitor(monitor.id, {
        intervalSec: Math.max(10, Number(intervalSec) || 30),
        retries: Math.max(0, Number(retries) || 0),
        timeoutMs: Math.max(1000, Number(timeoutMs) || 10000),
        enabled,
        channelIds,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monitor", monitor.id] }),
  });
  const toggleChannel = (cid: string) =>
    setChannelIds((cur) => (cur.includes(cid) ? cur.filter((x) => x !== cid) : [...cur, cid]));

  return (
    <Card style={{ padding: 16, marginTop: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("monitors.settings")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        <Field label={t("monitors.intervalSec")}>
          <TextInput type="number" min={10} value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} />
        </Field>
        <Field label={t("monitors.retries")}>
          <TextInput type="number" min={0} value={retries} onChange={(e) => setRetries(e.target.value)} />
        </Field>
        <Field label={t("monitors.timeoutMs")}>
          <TextInput type="number" min={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
        </Field>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "12px 0" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("monitors.enabled")}
      </label>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("monitors.channels")}</span>
          <Link href="/notifications" style={{ fontSize: 11, color: "var(--c-lapis)" }}>{t("monitors.manageChannels")}</Link>
        </div>
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
      <Btn onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "…" : t("monitors.save")}</Btn>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(save.error as Error).message}</div>}
    </Card>
  );
}
