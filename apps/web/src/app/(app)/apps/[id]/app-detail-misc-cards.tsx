"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, ExternalLink, History, Pencil, Play, Trash2, X } from "lucide-react";
import { AppLogo } from "../../../../components/app-logo";
import { useConfirm } from "../../../../components/confirm";
import { IconBtn } from "../../../../components/icon-btn";
import { Modal } from "../../../../components/modal";
import { useToast } from "../../../../components/toast";
import { Badge, Btn, Card, SectionCard, Spinner } from "../../../../components/ui";
import { useUnsavedChanges } from "../../../../hooks/useUnsavedChanges";
import { useT } from "../../../../i18n/provider";
import { api, appIconUrl } from "../../../../lib/api";
import { appColor, appSourceSummary, deploymentColor } from "../../../../lib/apps";
import { relativeTime } from "../../../../lib/fleet";
import { cropToPngBase64 } from "../../../../lib/icon";
import { TERMINAL_PRE_STYLE } from "../../../../lib/terminal-theme";
import { type Application, type Deployment, type ScheduledTask } from "../../../../lib/types";
import { envField, taskRunColor } from "./app-detail-shared";

/** At-a-glance summary for a non-compose app's Overview tab: the live URL plus a compact stat grid
 *  (status, source, exposure, placement, resources, port, environment, last deployment). Replaces the
 *  earlier single-line placeholder so the first tab actually tells you what the app is and how it ran. */
export function AppOverview({ app, deployments }: { app: Application; deployments: Deployment[] }) {
  const t = useT();
  const last = deployments[0] ?? null;
  const resourceParts: string[] = [];
  if (app.memoryMb) resourceParts.push(`${app.memoryMb} MB`);
  if (app.cpus) resourceParts.push(`${app.cpus} CPU`);
  const stats: { label: string; node: ReactNode }[] = [
    { label: t("apps.status"), node: <span style={{ color: appColor(app.status), fontWeight: 600 }}>{app.status}</span> },
    { label: t("apps.source"), node: <span className="mono">{appSourceSummary(app) || "—"}</span> },
    { label: t("apps.exposeTitle"), node: t(`apps.exposeMode_${app.exposeMode}`) },
    { label: t("apps.placementTitle"), node: app.clusterId ? t("apps.ovSwarm", { n: app.replicas ?? 1 }) : t("apps.ovSingleServer") },
    { label: t("apps.ovResources"), node: resourceParts.length ? resourceParts.join(" · ") : t("apps.ovNoLimit") },
    { label: t("apps.ovPort"), node: app.containerPort != null ? String(app.containerPort) : "—" },
    { label: t("apps.ovEnv"), node: t("apps.ovEnvCount", { n: app.envCount }) },
    {
      label: t("apps.ovLastDeploy"),
      node: last ? (
        <span>
          <span style={{ color: deploymentColor(last.status), fontWeight: 600 }}>{last.status}</span>
          {" · "}
          {relativeTime(last.createdAt)}
        </span>
      ) : (
        t("apps.ovNever")
      ),
    },
  ];
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", paddingBottom: 14, marginBottom: 14, borderBottom: "1px solid var(--c-bd)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)" }}>{t("apps.ovLiveUrl")}</span>
        {app.url ? (
          <a href={app.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)", fontSize: 14, wordBreak: "break-all" }}>
            {app.url}<ExternalLink size={13} aria-hidden style={{ marginLeft: 4, verticalAlign: "middle" }} />
          </a>
        ) : (
          <span style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("apps.ovNotExposed")}</span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))", gap: 14 }}>
        {stats.map((s) => (
          <div key={s.label}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 }}>{s.label}</div>
            <div style={{ fontSize: 13, color: "var(--c-tx)" }}>{s.node}</div>
          </div>
        ))}
      </div>
      {app.canWrite && !last && <div style={{ marginTop: 14, fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.overviewHint")}</div>}
      {!app.canWrite && <div style={{ marginTop: 14, fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.readOnlyHint")}</div>}
    </Card>
  );
}

/** Upload / replace / remove the app's custom icon. Crops client-side to a 128px square PNG (falling back to
 *  smaller sides if the encoded image would exceed the server's 64KB budget) before sending. Writer-only. */
export function AppIconCard({ app, onChanged }: { app: Application; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const hasIcon = !!app.iconUpdatedAt;

  const save = useMutation({
    mutationFn: (data: string) => api.setAppIcon(app.id, data),
    onSuccess: () => { onChanged(); toast(t("apps.iconUploaded"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("apps.actionFailed"), "error"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAppIcon(app.id),
    onSuccess: () => { onChanged(); toast(t("apps.iconRemoved"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("apps.actionFailed"), "error"),
  });

  const onPick = async (file: File) => {
    setProcessing(true);
    try {
      // Try 128px, then shrink if the PNG would blow the 64KB server cap (base64 ≈ 4/3 of the byte size).
      let data = "";
      for (const side of [128, 96, 64]) {
        data = await cropToPngBase64(file, side);
        if (data.length * 0.75 <= 64 * 1024) break;
      }
      if (data.length * 0.75 > 64 * 1024) { toast(t("apps.iconTooLarge"), "error"); return; }
      save.mutate(data);
    } catch {
      toast(t("apps.iconReadFailed"), "error");
    } finally {
      setProcessing(false);
    }
  };

  const busy = processing || save.isPending || remove.isPending;
  return (
    <SectionCard title={t("apps.iconTitle")} desc={t("apps.iconHint")}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ width: 56, height: 56, borderRadius: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <AppLogo iconUrl={appIconUrl(app.id, app.iconUpdatedAt)} templateSlug={app.templateSlug} templateLogo={app.templateLogo} source={app.source} name={app.name} size={36} />
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="ghost" icon={CloudUpload} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "…" : hasIcon ? t("apps.iconReplace") : t("apps.iconUpload")}
          </Btn>
          {hasIcon && (
            <Btn variant="ghost" icon={Trash2} onClick={() => remove.mutate()} disabled={busy}>{t("apps.iconRemove")}</Btn>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (f) void onPick(f);
        }}
      />
    </SectionCard>
  );
}

export function ContainerPickerModal({ id, onClose, onPick }: { id: string; onClose: () => void; onPick: (name: string) => void }) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({ queryKey: ["appContainers", id], queryFn: () => api.listAppContainers(id) });
  const containers = data?.containers ?? [];
  return (
    <Modal onClose={onClose} width={480} ariaLabel={t("apps.selectContainer")}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{t("apps.selectContainer")}</div>
      {isLoading ? (
        <Spinner />
      ) : isError || containers.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("apps.noContainers")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {containers.map((c) => (
            <button
              key={c.name}
              onClick={() => onPick(c.name)}
              style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", cursor: "pointer", fontFamily: "inherit" }}
            >
              <span className="mono" style={{ fontSize: 12, flex: 1 }}>{c.name}</span>
              <span style={{ fontSize: 11, color: c.state === "running" ? "var(--c-g)" : "var(--c-tx3)" }}>{c.state}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Read-only summary for a COMPOSE-from-git app: where the stack is cloned from. The compose file lives in
 *  the repo (not stored here), so there is no in-place editor — it is cloned, validated and run on deploy. */
export function GitComposeSourceCard({ app }: { app: Application }) {
  const t = useT();
  const rows: { label: string; value: string }[] = [
    { label: t("apps.gitUrl"), value: app.gitUrl ?? "—" },
    { label: t("apps.branch"), value: app.gitBranch ?? "main" },
    { label: t("apps.composePath"), value: app.composePath ?? "docker-compose.yml" },
  ];
  return (
    <SectionCard title={t("apps.composeFromGit")}>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", gap: 12, fontSize: 13 }}>
            <span style={{ color: "var(--c-tx3)", minWidth: 120 }}>{r.label}</span>
            <span className="mono" style={{ color: "var(--c-tx)", wordBreak: "break-all" }}>{r.value}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 10 }}>{t("apps.composePathHint")}</div>
    </SectionCard>
  );
}

/** Edit a COMPOSE app's docker-compose.yml in place (writer only). Validation (safe compose) runs on
 *  save; changes apply on the next deploy, so Save persists and "Save & deploy" chains the deploy. */
export function ComposeEditorCard({ id, composeFile, canWrite, onDeploy }: { id: string; composeFile: string; canWrite: boolean; onDeploy: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(composeFile);
  // Re-seed if the saved file changes under us (another tab, a deploy that rewrote it).
  useEffect(() => { setText(composeFile); }, [composeFile]);
  const dirty = text !== composeFile;
  const save = useMutation({
    mutationFn: () => api.setAppComposeFile(id, text),
    onSuccess: () => { toast(t("apps.composeSaved"), "success"); return qc.invalidateQueries({ queryKey: ["app", id] }); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  useUnsavedChanges(canWrite && dirty && !save.isPending);

  if (!canWrite) {
    return (
      <SectionCard title={t("apps.compose")}>
        <pre className="mono" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto" }}>{composeFile}</pre>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t("apps.compose")} right={dirty && <span style={{ fontSize: 11, color: "var(--c-am)" }}>{t("apps.composeUnsaved")}</span>}>
      <textarea
        className="mono"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        aria-label={t("apps.compose")}
        style={{ width: "100%", minHeight: 300, maxHeight: 520, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
      />
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("apps.composeHint")}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <Btn variant="ghost" onClick={() => setText(composeFile)} disabled={!dirty || save.isPending}>{t("apps.composeReset")}</Btn>
        <Btn variant="ghost" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending ? "…" : t("apps.composeSave")}</Btn>
        <Btn onClick={() => { save.mutateAsync().then(() => onDeploy()).catch(() => {}); }} disabled={save.isPending}>{t("apps.composeSaveDeploy")}</Btn>
      </div>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 6 }}>{(save.error as Error).message}</div>}
    </SectionCard>
  );
}

export function TaskRunHistory({ appId, taskId }: { appId: string; taskId: string }) {
  const t = useT();
  const { data: runs = [], isLoading, isError } = useQuery({
    queryKey: ["appTaskRuns", appId, taskId],
    queryFn: () => api.listAppTaskRuns(appId, taskId),
  });
  if (isLoading) return <div style={{ paddingLeft: 24 }}><Spinner /></div>;
  if (isError) return <div style={{ paddingLeft: 24, fontSize: 12, color: "var(--c-r)" }}>{t("apps.taskRunsError")}</div>;
  if (!runs.length) return <div style={{ paddingLeft: 24, fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.taskRunsEmpty")}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 24 }}>
      {runs.map((r) => (
        <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 4, borderLeft: "2px solid var(--c-bd)", paddingLeft: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 11 }}>
            <span style={{ color: taskRunColor(r.status), fontWeight: 600 }}>{t(`apps.taskStatus_${r.status}`)}</span>
            <Badge tone="muted">{r.trigger === "manual" ? t("apps.taskTriggerManual") : t("apps.taskTriggerSchedule")}</Badge>
            {r.exitCode != null && <span className="mono" style={{ color: "var(--c-tx3)" }}>{t("apps.taskExitCode")}: {r.exitCode}</span>}
            <span style={{ color: "var(--c-tx3)" }} title={new Date(r.startedAt).toLocaleString()}>{relativeTime(r.startedAt)}</span>
            {r.durationMs != null && <span style={{ color: "var(--c-tx3)" }}>{Math.round(r.durationMs / 100) / 10}s</span>}
          </div>
          {r.error && <span style={{ fontSize: 11, color: "var(--c-r)" }}>{r.error}</span>}
          {r.output && <pre className="mono" style={{ ...TERMINAL_PRE_STYLE, maxHeight: 180, fontSize: 11, margin: 0 }}>{r.output}</pre>}
        </div>
      ))}
    </div>
  );
}

export function TaskRow({ appId, task }: { appId: string; task: ScheduledTask }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["appTasks", appId] });
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [name, setName] = useState(task.name);
  const [schedule, setSchedule] = useState(task.schedule);
  const [command, setCommand] = useState(task.command);
  const [timeoutStr, setTimeoutStr] = useState(task.timeoutSec != null ? String(task.timeoutSec) : "");
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.updateAppTask(appId, task.id, { enabled }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => api.deleteAppTask(appId, task.id), onSuccess: invalidate });
  const run = useMutation({
    mutationFn: () => api.runAppTask(appId, task.id),
    onSuccess: () => {
      toast(t("apps.taskRunStarted"), "success");
      invalidate();
      // the run finishes asynchronously; give it a moment, then refresh the history so the new row appears.
      setTimeout(() => qc.invalidateQueries({ queryKey: ["appTaskRuns", appId, task.id] }), 1500);
    },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("apps.actionFailed"), "error"),
  });
  const edit = useMutation({
    mutationFn: () => api.updateAppTask(appId, task.id, { name, schedule, command, timeoutSec: timeoutStr.trim() ? Number(timeoutStr) : null }),
    onSuccess: () => { setEditing(false); invalidate(); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("apps.actionFailed"), "error"),
  });
  const startEdit = () => { setName(task.name); setSchedule(task.schedule); setCommand(task.command); setTimeoutStr(task.timeoutSec != null ? String(task.timeoutSec) : ""); setEditing(true); };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input style={{ ...envField, width: 140 }} placeholder={t("apps.taskName")} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("apps.taskName")} />
        <input style={{ ...envField, width: 130 }} placeholder={t("apps.taskSchedule")} value={schedule} onChange={(e) => setSchedule(e.target.value)} aria-label={t("apps.taskSchedule")} />
        <input style={{ ...envField, flex: 1, minWidth: 160 }} placeholder={t("apps.taskCommand")} value={command} onChange={(e) => setCommand(e.target.value)} aria-label={t("apps.taskCommand")} />
        <input style={{ ...envField, width: 110 }} type="number" min={1} max={3600} placeholder={t("apps.taskTimeout")} title={t("apps.taskTimeoutHint")} value={timeoutStr} onChange={(e) => setTimeoutStr(e.target.value)} aria-label={t("apps.taskTimeout")} />
        <Btn onClick={() => edit.mutate()} disabled={edit.isPending || !name.trim() || !schedule.trim() || !command.trim()}>{t("common.save")}</Btn>
        <Btn variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Btn>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" aria-label={t("apps.taskEnabled")} checked={task.enabled} onChange={(e) => toggle.mutate(e.target.checked)} />
        <span style={{ fontSize: 13, width: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{task.name}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", width: 110 }}>{task.schedule}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{task.command}</span>
        {task.timeoutSec != null && <span style={{ fontSize: 11, color: "var(--c-tx3)" }} title={t("apps.taskTimeoutHint")}>{t("apps.taskTimeoutShort", { n: task.timeoutSec })}</span>}
        {task.lastRunAt && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.taskLastRun")}: {new Date(task.lastRunAt).toLocaleString()}</span>}
        <IconBtn label={t("apps.taskRunNow")} onClick={() => run.mutate()} disabled={run.isPending}><Play size={14} /></IconBtn>
        <IconBtn label={t("apps.taskHistory")} onClick={() => setShowHistory((v) => !v)}><History size={14} /></IconBtn>
        <IconBtn label={t("common.edit")} onClick={startEdit}><Pencil size={14} /></IconBtn>
        <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(); }}><X size={14} /></IconBtn>
      </div>
      {showHistory && <TaskRunHistory appId={appId} taskId={task.id} />}
    </div>
  );
}

export function ScheduledTasksCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery({ queryKey: ["appTasks", id], queryFn: () => api.listAppTasks(id) });
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [command, setCommand] = useState("");
  const [timeoutStr, setTimeoutStr] = useState("");
  const add = useMutation({
    mutationFn: () => api.createAppTask(id, { name, schedule, command, timeoutSec: timeoutStr.trim() ? Number(timeoutStr) : null }),
    onSuccess: () => { setName(""); setSchedule(""); setCommand(""); setTimeoutStr(""); qc.invalidateQueries({ queryKey: ["appTasks", id] }); },
  });

  return (
    <SectionCard title={t("apps.tasks")} desc={t("apps.tasksDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {tasks.map((tk) => <TaskRow key={tk.id} appId={id} task={tk} />)}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...envField, width: 140 }} placeholder={t("apps.taskName")} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("apps.taskName")} />
        <input style={{ ...envField, width: 130 }} placeholder={t("apps.taskSchedule")} value={schedule} onChange={(e) => setSchedule(e.target.value)} aria-label={t("apps.taskSchedule")} />
        <input style={{ ...envField, flex: 1, minWidth: 160 }} placeholder={t("apps.taskCommand")} value={command} onChange={(e) => setCommand(e.target.value)} aria-label={t("apps.taskCommand")} />
        <input style={{ ...envField, width: 110 }} type="number" min={1} max={3600} placeholder={t("apps.taskTimeout")} title={t("apps.taskTimeoutHint")} value={timeoutStr} onChange={(e) => setTimeoutStr(e.target.value)} aria-label={t("apps.taskTimeout")} />
        <Btn onClick={() => add.mutate()} disabled={add.isPending || !name || !schedule || !command}>{t("apps.addTask")}</Btn>
      </div>
      {add.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(add.error as Error).message}</div>}
    </SectionCard>
  );
}

export function PreviewCard({ id, previewEnabled, domain, excludeKeys, limit }: { id: string; previewEnabled: boolean; domain: string | null; excludeKeys: string[]; limit: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [exclude, setExclude] = useState(excludeKeys.join("\n"));
  const [lim, setLim] = useState(limit != null ? String(limit) : "");
  useEffect(() => { setExclude(excludeKeys.join("\n")); setLim(limit != null ? String(limit) : ""); }, [excludeKeys, limit]);
  const parseExclude = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const excludeDirty = parseExclude(exclude).join("\n") !== excludeKeys.join("\n") || (lim.trim() ? Number(lim) : null) !== limit;
  const { data: previews = [] } = useQuery({
    queryKey: ["appPreviews", id],
    queryFn: () => api.getAppPreviews(id),
    enabled: previewEnabled,
  });
  const invalidate = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["appPreviews", id] }), qc.invalidateQueries({ queryKey: ["app", id] })]);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setPreviewEnabled(id, enabled),
    onSuccess: invalidate,
  });
  const saveExclude = useMutation({
    mutationFn: () => api.setPreviewEnabled(id, previewEnabled, parseExclude(exclude), lim.trim() ? Number(lim) : null),
    onSuccess: invalidate,
    meta: { successMessage: t("apps.saved") },
  });
  useUnsavedChanges(excludeDirty && !saveExclude.isPending);
  const del = useMutation({
    mutationFn: (previewId: string) => api.deletePreview(id, previewId),
    onSuccess: invalidate,
  });

  return (
    <SectionCard title={t("apps.preview")} desc={t("apps.previewDesc")}>
      {!domain ? (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.previewNeedsDomain")}</div>
      ) : (
        <>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={previewEnabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            {t("apps.previewEnable")}
          </label>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 12px" }}>
            {t("apps.previewWildcardHint", { domain })}
          </p>
          {previewEnabled && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.previewExcludeEnv")}</div>
              <textarea
                className="mono"
                value={exclude}
                spellCheck={false}
                onChange={(e) => setExclude(e.target.value)}
                placeholder={"DATABASE_URL\nSTRIPE_SECRET_KEY"}
                aria-label={t("apps.previewExcludeEnv")}
                style={{ width: "100%", minHeight: 64, maxHeight: 160, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>
                {t("apps.previewLimit")}
                <input style={{ ...envField, width: 100 }} type="number" value={lim} onChange={(e) => setLim(e.target.value)} placeholder="∞" aria-label={t("apps.previewLimit")} />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <p style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1, margin: 0 }}>{t("apps.previewExcludeEnvHint")} {t("apps.previewLimitHint")}</p>
                <Btn variant="ghost" onClick={() => saveExclude.mutate()} disabled={saveExclude.isPending || !excludeDirty}>{t("apps.save")}</Btn>
              </div>
            </div>
          )}
          {previewEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {previews.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.previewNone")}</div>
              )}
              {previews.map((p) => (
                <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "6px 10px" }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>PR #{p.prNumber}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{p.gitBranch}</span>
                  <span style={{ flex: 1 }} />
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--c-lapis)" }}>
                      {p.url} {t("apps.open")}
                    </a>
                  )}
                  <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(p.id); }}><X size={14} /></IconBtn>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {toggle.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(toggle.error as Error).message}</div>}
    </SectionCard>
  );
}

export function AppDescriptionCard({ id, description }: { id: string; description: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [desc, setDesc] = useState(description ?? "");
  useEffect(() => { setDesc(description ?? ""); }, [description]);
  const dirty = desc.trim() !== (description ?? "");
  const save = useMutation({
    mutationFn: () => api.setAppDescription(id, desc.trim() || null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  useUnsavedChanges(dirty && !save.isPending);
  return (
    <SectionCard title={t("apps.description")} desc={t("apps.descriptionHint")}>
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder={t("apps.descriptionPlaceholder")}
        aria-label={t("apps.description")}
        maxLength={2000}
        spellCheck={false}
        style={{ width: "100%", minHeight: 56, maxHeight: 160, resize: "vertical", fontSize: 13, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
      />
      <div style={{ marginTop: 8 }}>
        <Btn onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{t("apps.save")}</Btn>
      </div>
    </SectionCard>
  );
}
