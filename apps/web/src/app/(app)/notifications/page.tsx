"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Pencil, Trash2, X } from "lucide-react";
import { api } from "../../../lib/api";
import { useTeamScope } from "../../../components/team-scope";
import { scopeByTeam, defaultTeamId } from "../../../lib/team-scope";
import { IconBtn } from "../../../components/icon-btn";
import { useConfirm } from "../../../components/confirm";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { Field, Select, TextInput } from "../../../components/form";
import { DeliveryHistory } from "./delivery-history";

const TYPES = ["smtp", "webhook", "discord", "slack", "telegram", "ntfy", "gotify", "pushover", "teams", "mattermost", "lark", "resend"];

// config fields per channel type (key → i18n label key f_<key>). Webhook `headers` are handled by a
// dedicated key/value editor, not this flat list.
const FIELDS: Record<string, string[]> = {
  smtp: ["host", "port", "user", "pass", "from", "to"],
  webhook: ["url", "signingSecret"],
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken", "chatId", "messageThreadId"],
  ntfy: ["server", "topic", "priority", "accessToken"],
  gotify: ["server", "token", "priority"],
  pushover: ["token", "userKey", "priority", "retry", "expire"],
  teams: ["webhookUrl"],
  mattermost: ["webhookUrl"],
  lark: ["webhookUrl"],
  resend: ["apiKey", "from", "to"],
};
const SECRET_FIELDS = new Set(["pass", "token", "botToken", "userKey", "apiKey", "signingSecret", "accessToken"]);
// Rendered with <input type="number"> (UX only — the value is still submitted as a string; the backend's
// numCfg treats "" as undefined, so empty numeric fields are simply dropped, never coerced to 0).
const NUMBER_FIELDS = new Set(["port", "priority", "retry", "expire", "messageThreadId"]);
// Optional inline guidance under a field.
const FIELD_HINTS: Record<string, string> = {
  signingSecret: "hint_signingSecret",
  retry: "hint_retryExpire",
  expire: "hint_retryExpire",
};
// The subscribable event ids come from the backend (GET /channels/events) so the UI never drifts from
// the enum. EVENT_LABEL maps each id → an i18n key (unknown ids fall back to the raw id).
const EVENT_LABEL: Record<string, string> = {
  deploy_success: "eventDeploySuccess",
  deploy_failed: "eventDeployFailed",
  deploy_rolled_back: "eventDeployRolledBack",
  server_offline: "eventServerOffline",
  server_online: "eventServerOnline",
  swarm_degraded: "eventSwarmDegraded",
  ssl_expiring: "eventSslExpiring",
  token_expiring: "eventTokenExpiring",
  backup_failed: "eventBackupFailed",
  backup_success: "eventBackupSuccess",
  backup_restore_failed: "eventBackupRestoreFailed",
  volume_backup_success: "eventVolumeBackupSuccess",
  volume_backup_failed: "eventVolumeBackupFailed",
  scheduled_task_success: "eventScheduledTaskSuccess",
  scheduled_task_failed: "eventScheduledTaskFailed",
  docker_cleanup_success: "eventDockerCleanupSuccess",
  docker_cleanup_failed: "eventDockerCleanupFailed",
  container_crashed: "eventContainerCrashed",
  container_oom: "eventContainerOom",
};

export default function NotificationsPage() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { teamId: scope } = useTeamScope();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: channels = [], isLoading, isError, refetch } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });
  // Single source of truth for the event list — the backend enum, so the UI can't drift.
  const { data: eventsData } = useQuery({ queryKey: ["channelEvents"], queryFn: () => api.listChannelEvents() });
  const EVENTS = eventsData?.events ?? [];

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
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([]);
  const [events, setEvents] = useState<string[]>(["deploy_failed", "server_offline"]);

  // Assemble the opaque config bag submitted on create: smtp keeps its `secure` toggle; webhook folds the
  // key/value editor rows into a `headers` object (empty keys dropped, omitted entirely when empty).
  const buildConfig = (): Record<string, unknown> => {
    const base: Record<string, unknown> = { ...config };
    if (type === "smtp") base.secure = secure;
    if (type === "webhook") {
      const h: Record<string, string> = {};
      for (const r of headers) if (r.key.trim()) h[r.key.trim()] = r.value;
      if (Object.keys(h).length) base.headers = h;
    }
    return base;
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels"] });
  const create = useMutation({
    mutationFn: () => api.createChannel({ name, type, teamId: target, config: buildConfig(), eventTypes: events }),
    onSuccess: () => { setName(""); setConfig({}); setSecure(false); setHeaders([]); setCreateTeam(""); invalidate(); },
  });
  const test = useMutation({ mutationFn: (id: string) => api.testChannel(id) });
  const del = useMutation({ mutationFn: (id: string) => api.deleteChannel(id), onSuccess: invalidate });
  const toggle = useMutation({
    mutationFn: (c: { id: string; enabled: boolean }) => api.updateChannel(c.id, { enabled: c.enabled }),
    onSuccess: invalidate,
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [rName, setRName] = useState("");
  const renameCh = useMutation({
    mutationFn: (id: string) => api.updateChannel(id, { name: rName.trim() }),
    onSuccess: () => { setRenamingId(null); invalidate(); },
  });

  const setField = (k: string, v: string) => setConfig((c) => ({ ...c, [k]: v }));
  const setHeaderRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setHeaders((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleEvent = (e: string) => setEvents((es) => (es.includes(e) ? es.filter((x) => x !== e) : [...es, e]));

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <Bell size={20} color="var(--c-a)" /> {t("notifications.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("notifications.subtitle")}</p>

      {isError && channels.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={Bell} title={t("notifications.emptyTitle")}>{t("notifications.noChannels")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {visible.map((c) => (
            <Card key={c.id} style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {renamingId === c.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); if (rName.trim()) renameCh.mutate(c.id); }} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input value={rName} onChange={(e) => setRName(e.target.value)} autoFocus style={{ padding: "4px 8px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" }} />
                      <Btn type="submit" disabled={renameCh.isPending || !rName.trim()}>{renameCh.isPending ? "…" : t("common.save")}</Btn>
                      <Btn variant="ghost" onClick={() => setRenamingId(null)}>{t("common.cancel")}</Btn>
                    </form>
                  ) : (
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                  )}
                  <Badge tone="gold">{c.type}</Badge>
                  {c.canWrite ? (
                    <button
                      onClick={() => toggle.mutate({ id: c.id, enabled: !c.enabled })}
                      disabled={toggle.isPending}
                      title={c.enabled ? t("notifications.disable") : t("notifications.enable")}
                      style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, cursor: "pointer", border: "1px solid var(--c-bd)", background: c.enabled ? "var(--c-ad)" : "transparent", color: c.enabled ? "var(--c-g)" : "var(--c-tx3)" }}
                    >
                      {c.enabled ? t("notifications.on") : t("notifications.off")}
                    </button>
                  ) : (
                    !c.enabled && <Badge>off</Badge>
                  )}
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
                  <IconBtn label={t("notifications.editName")} onClick={() => { setRName(c.name); setRenamingId(renamingId === c.id ? null : c.id); }}><Pencil size={15} /></IconBtn>
                  <IconBtn label={t("notifications.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(c.id); }}><Trash2 size={15} /></IconBtn>
                </>
              )}
              <DeliveryHistory channelId={c.id} />
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
              <Select value={type} onChange={(v) => { setType(v); setConfig({}); setHeaders([]); setSecure(false); }} options={TYPES.map((tp) => ({ value: tp, label: tp.toUpperCase() }))} />
            </Field>
            {(FIELDS[type] ?? []).map((k) => (
              <Field key={k} label={t(`notifications.f_${k}`)} hint={FIELD_HINTS[k] ? t(`notifications.${FIELD_HINTS[k]}`) : undefined}>
                <TextInput
                  type={SECRET_FIELDS.has(k) ? "password" : NUMBER_FIELDS.has(k) ? "number" : "text"}
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

          {type === "webhook" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("notifications.headers")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {headers.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 6 }}>
                    <TextInput style={{ width: 200 }} placeholder={t("notifications.headerKey")} value={r.key} onChange={(e) => setHeaderRow(i, { key: e.target.value })} />
                    <TextInput style={{ flex: 1 }} placeholder={t("notifications.headerValue")} value={r.value} onChange={(e) => setHeaderRow(i, { value: e.target.value })} />
                    <Btn variant="ghost" aria-label={t("common.remove")} onClick={() => setHeaders((rs) => rs.filter((_, j) => j !== i))}><X size={14} /></Btn>
                  </div>
                ))}
              </div>
              <Btn variant="ghost" style={{ marginTop: 6 }} onClick={() => setHeaders((rs) => [...rs, { key: "", value: "" }])}>
                {t("notifications.addHeader")}
              </Btn>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("notifications.events")}</div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {EVENTS.map((e) => (
                <label key={e} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
                  <input type="checkbox" checked={events.includes(e)} onChange={() => toggleEvent(e)} /> {t(`notifications.${EVENT_LABEL[e] ?? e}`)}
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
