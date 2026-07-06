"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useTeamScope } from "../../../components/team-scope";
import { scopeByTeam, defaultTeamId } from "../../../lib/team-scope";
import { IconBtn } from "../../../components/icon-btn";
import { useConfirm } from "../../../components/confirm";
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
const EVENTS = ["deploy_success", "deploy_failed", "server_offline", "ssl_expiring", "token_expiring", "backup_failed", "backup_restore_failed"];
const EVENT_LABEL: Record<string, string> = {
  deploy_success: "eventDeploySuccess",
  deploy_failed: "eventDeployFailed",
  server_offline: "eventServerOffline",
  ssl_expiring: "eventSslExpiring",
  token_expiring: "eventTokenExpiring",
  backup_failed: "eventBackupFailed",
  backup_restore_failed: "eventBackupRestoreFailed",
};

export default function NotificationsPage() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { teamId: scope } = useTeamScope();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: channels = [], isLoading } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });

  // List follows the global scope (filter); create needs a concrete target team.
  const visible = scopeByTeam(channels, scope);
  const [createTeam, setCreateTeam] = useState("");
  // Prefer a team the user can write to as the create target, so a viewer-in-the
  // scoped-team but writer-elsewhere user still sees the create form.
  const preferred = defaultTeamId(scope, teams);
  const preferredWritable = teams.some((tm) => tm.id === preferred && tm.role !== "VIEWER");
  const target = createTeam || (preferredWritable ? preferred : teams.find((tm) => tm.role !== "VIEWER")?.id ?? preferred);
  const canCreate = teams.some((tm) => tm.id === target && tm.role !== "VIEWER");
  useEffect(() => setCreateTeam(""), [scope]);
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
        teamId: target,
        config: type === "smtp" ? { ...config, secure } : config,
        eventTypes: events,
      }),
    onSuccess: () => { setName(""); setConfig({}); setSecure(false); setCreateTeam(""); invalidate(); },
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

      {isLoading ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={Bell} title={t("notifications.emptyTitle")}>{t("notifications.noChannels")}</EmptyState></Card>
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
              {c.canWrite && (
                <>
                  <Btn variant="ghost" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                    {test.isPending ? "…" : t("notifications.test")}
                  </Btn>
                  <IconBtn label={t("notifications.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(c.id); }}><Trash2 size={15} /></IconBtn>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
      {test.isSuccess && <div style={{ fontSize: 12, color: "var(--c-g)", marginBottom: 12 }}>{t("notifications.testSent")}</div>}
      {test.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 12 }}>{t("notifications.testFailed")}: {(test.error as Error).message}</div>}

      {canCreate && (
      <Card style={{ padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>{t("notifications.create")}</div>
        <form onSubmit={(e) => { e.preventDefault(); if (name && target) create.mutate(); }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {teams.length > 1 && (
              <Field label={t("common.team")}>
                <Select value={target} onChange={setCreateTeam} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
              </Field>
            )}
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
            <Btn type="submit" disabled={create.isPending || !name || !target}>{create.isPending ? "…" : t("notifications.add")}</Btn>
          </div>
          {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
        </form>
      </Card>
      )}
    </div>
  );
}
