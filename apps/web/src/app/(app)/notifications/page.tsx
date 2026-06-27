"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { visibleChannels } from "../../../lib/channels";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { Field, Select, TextInput } from "../../../components/form";

const TYPES = ["smtp", "webhook", "discord", "slack", "telegram", "ntfy", "gotify"];

// config fields per channel type (key → i18n label key f_<key>)
const FIELDS: Record<string, string[]> = {
  smtp: ["host", "port", "user", "pass", "from", "to"],
  webhook: ["url"],
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken", "chatId"],
  ntfy: ["server", "topic"],
  gotify: ["server", "token"],
};
const SECRET_FIELDS = new Set(["pass", "token", "botToken"]);
const EVENTS = ["deploy_success", "deploy_failed", "server_offline", "ssl_expiring", "token_expiring"];
const EVENT_LABEL: Record<string, string> = {
  deploy_success: "eventDeploySuccess",
  deploy_failed: "eventDeployFailed",
  server_offline: "eventServerOffline",
  ssl_expiring: "eventSslExpiring",
  token_expiring: "eventTokenExpiring",
};

export default function NotificationsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: channels = [], isLoading } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });

  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams[0]?.id || "";
  const visible = visibleChannels(channels, activeTeam);
  const [name, setName] = useState("");
  const [type, setType] = useState("smtp");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secure, setSecure] = useState(false);
  const [events, setEvents] = useState<string[]>(["deploy_failed", "server_offline"]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels"] });
  const create = useMutation({
    mutationFn: () =>
      api.createChannel({
        name,
        type,
        teamId: activeTeam,
        config: type === "smtp" ? { ...config, secure } : config,
        eventTypes: events,
      }),
    onSuccess: () => { setName(""); setConfig({}); setSecure(false); invalidate(); },
  });
  const test = useMutation({ mutationFn: (id: string) => api.testChannel(id) });
  const del = useMutation({ mutationFn: (id: string) => api.deleteChannel(id), onSuccess: invalidate });

  const setField = (k: string, v: string) => setConfig((c) => ({ ...c, [k]: v }));
  const toggleEvent = (e: string) => setEvents((es) => (es.includes(e) ? es.filter((x) => x !== e) : [...es, e]));

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <Bell size={20} color="var(--c-a)" /> {t("notifications.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("notifications.subtitle")}</p>

      {teams.length > 1 && (
        <div style={{ maxWidth: 240, marginBottom: 18 }}>
          <Select value={activeTeam} onChange={setTeamId} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <Card style={{ padding: 16, marginBottom: 20 }}><EmptyState>{t("notifications.noChannels")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {visible.map((c) => (
            <Card key={c.id} style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                  <Badge tone="gold">{c.type}</Badge>
                  {!c.enabled && <Badge>off</Badge>}
                </div>
                <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 3 }}>
                  {c.eventTypes.length ? c.eventTypes.map((e) => t(`notifications.${EVENT_LABEL[e] ?? e}`)).join(" · ") : "—"}
                </div>
              </div>
              <Btn variant="ghost" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                {test.isPending ? "…" : t("notifications.test")}
              </Btn>
              <Btn variant="ghost" onClick={() => del.mutate(c.id)} title={t("notifications.delete")}><Trash2 size={15} /></Btn>
            </Card>
          ))}
        </div>
      )}
      {test.isSuccess && <div style={{ fontSize: 12, color: "var(--c-g)", marginBottom: 12 }}>{t("notifications.testSent")}</div>}
      {test.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 12 }}>{t("notifications.testFailed")}: {(test.error as Error).message}</div>}

      <Card style={{ padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>{t("notifications.create")}</div>
        <form onSubmit={(e) => { e.preventDefault(); if (name && activeTeam) create.mutate(); }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label={t("notifications.channelName")} htmlFor="ch-name">
              <TextInput id="ch-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label={t("notifications.channelType")}>
              <Select value={type} onChange={(v) => { setType(v); setConfig({}); }} options={TYPES.map((tp) => ({ value: tp, label: tp.toUpperCase() }))} />
            </Field>
            {(FIELDS[type] ?? []).map((k) => (
              <Field key={k} label={t(`notifications.f_${k}`)}>
                <TextInput
                  type={SECRET_FIELDS.has(k) ? "password" : k === "port" ? "number" : "text"}
                  value={config[k] ?? ""}
                  onChange={(e) => setField(k, e.target.value)}
                />
              </Field>
            ))}
          </div>

          {type === "smtp" && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)", marginTop: 10 }}>
              <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} /> {t("notifications.f_secure")}
            </label>
          )}

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("notifications.events")}</div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {EVENTS.map((e) => (
                <label key={e} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
                  <input type="checkbox" checked={events.includes(e)} onChange={() => toggleEvent(e)} /> {t(`notifications.${EVENT_LABEL[e]}`)}
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <Btn type="submit" disabled={create.isPending || !name || !activeTeam}>{create.isPending ? "…" : t("notifications.add")}</Btn>
          </div>
          {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
        </form>
      </Card>
    </div>
  );
}
