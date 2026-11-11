"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2, LayoutDashboard, ScrollText, Activity, DatabaseBackup, Settings2, Rocket, RotateCw, Play, Square, Terminal, Ellipsis, Pencil, Copy, X, Database as DatabaseIcon, CloudUpload } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, databaseIconUrl } from "../../../../lib/api";
import { cropToPngBase64 } from "../../../../lib/icon";
import { useDismiss } from "../../../../lib/use-dismiss";
import { dbColor, engineLabel, isDbTransitional } from "../../../../lib/databases";
import { backupColor, formatSize, lastErrorLine, restoreColor } from "../../../../lib/backups";
import { BackupRunModal } from "../../../../components/backup-run-modal";
import { ErrorState } from "../../../../components/error-state";
import { resourceBreadcrumb } from "../../../../lib/breadcrumb";
import { useTabState } from "../../../../hooks/useTabState";
import { CopyRow } from "../../../../components/copy-row";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, EmptyState, SectionCard, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { LiveLogsCard } from "../../../../components/live-logs-card";
import { AppMetricsCard } from "../../../../components/app-metrics-card";
import { Tabs } from "../../../../components/tabs-nav";
import { EnvironmentCard } from "../../../../components/environment-card";
import { EnvCard } from "../../../../components/env-card";
import { TagsCard } from "../../../../components/tags";
import { RenameModal } from "../../../../components/rename-modal";
import { TerminalPanel } from "../../../../components/terminal-panel";
import { useConfirm } from "../../../../components/confirm";
import { useToast } from "../../../../components/toast";
import { Modal } from "../../../../components/modal";
import { Select } from "../../../../components/form";
import { compatibleRestoreTargets } from "../../../../lib/restore";

export default function DatabaseDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();

  const { data: db, isLoading, isError, refetch } = useQuery({
    queryKey: ["database", id],
    queryFn: () => api.getDatabase(id),
    // Poll fast while the database is on its way to RUNNING so the UI feels live.
    refetchInterval: (q) => (q.state.data && isDbTransitional(q.state.data.status) ? 1500 : 5000),
  });

  const { data: backups = [] } = useQuery({
    queryKey: ["backups", id],
    queryFn: () => api.listBackups(id),
    refetchInterval: 5000,
  });
  const { data: destinations = [] } = useQuery({
    queryKey: ["destinations"],
    queryFn: () => api.listDestinations(),
  });
  const { data: restores = [] } = useQuery({
    queryKey: ["restores", id],
    queryFn: () => api.listRestores(id),
    enabled: !!db?.canWrite, // writer-only endpoint (errorTail may hold output)
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["database", id] });
  const invalidateBackups = () => qc.invalidateQueries({ queryKey: ["backups", id] });
  const invalidateRestores = () => qc.invalidateQueries({ queryKey: ["restores", id] });
  const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : t("databases.actionFailed"));
  const provision = useMutation({ mutationFn: () => api.provisionDatabase(id), onSuccess: invalidate, onError: (e) => toast(errMsg(e), "error") });
  const stop = useMutation({ mutationFn: () => api.stopDatabase(id), onSuccess: invalidate, onError: (e) => toast(errMsg(e), "error") });
  const [renameOpen, setRenameOpen] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) => api.renameDatabase(id, name),
    onSuccess: () => { setRenameOpen(false); invalidate(); },
    onError: (e) => toast(errMsg(e), "error"),
  });
  // Read at mutate() time via a stable ref so the keep-volume choice survives the async confirm handler.
  const keepVolume = useRef(false);
  const del = useMutation({
    mutationFn: () => api.deleteDatabase(id, keepVolume.current),
    onSuccess: () => router.replace("/databases"),
    onError: (e) => toast(errMsg(e), "error"),
  });
  // Shared by the header "…" menu and the Settings > Danger-zone card, so the typed-name guard and
  // the keep-volume opt-in live in one place.
  const confirmAndDelete = async () => {
    if (!db || del.isPending) return; // guard both entry points (header "…" menu + Settings Danger-zone card) against a double-fire
    keepVolume.current = false;
    if (await confirm({ title: t("databases.delete"), body: t("databases.deleteConfirm"), danger: true, confirmText: db.name, checkbox: { label: t("databases.keepVolume"), ref: keepVolume } })) del.mutate();
  };
  const backupNow = useMutation({ mutationFn: () => api.backupNow(id), onSuccess: invalidateBackups, onError: (e) => toast(errMsg(e), "error") });
  const [cloneOpen, setCloneOpen] = useState(false);
  const clone = useMutation({
    mutationFn: (name: string) => api.cloneDatabase(id, { name }),
    onSuccess: (res) => {
      setCloneOpen(false);
      for (const w of res.warnings) toast(t(`databases.cloneWarn_${w}`), "info");
      router.push(`/databases/${res.id}`);
    },
    onError: (e) => toast(errMsg(e), "error"),
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useDismiss(moreOpen, moreRef, () => setMoreOpen(false)); // close the "…" menu on outside-click / Esc
  const restore = useMutation({
    mutationFn: (bid: string) => api.restoreBackup(id, bid),
    onSuccess: () => toast(t("databases.restoreSucceeded"), "success"),
    onError: () => toast(t("databases.restoreFailed"), "error"),
    onSettled: invalidateRestores,
  });
  const delBackup = useMutation({ mutationFn: (bid: string) => api.deleteBackup(id, bid), onSuccess: invalidateBackups });
  // Migrator export: a presigned migration URL for an S3 DB backup (feed it to import-from-URL elsewhere).
  const [exported, setExported] = useState<{ id: string; url: string } | null>(null);
  const exportUrl = useMutation({
    mutationFn: (bid: string) => api.exportDatabaseBackupUrl(id, bid),
    onSuccess: (res, bid) => setExported({ id: bid, url: res.url }),
    onError: () => toast(t("databases.exportFailed"), "error"),
  });
  const { data: allDatabases = [] } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  // Run-detail modal: keep only the id so the open modal tracks the polled row (e.g. RUNNING → FAILED).
  const [runDetailId, setRunDetailId] = useState<string | null>(null);
  const runDetail = backups.find((b) => b.id === runDetailId) ?? null;
  const [restoreToBackup, setRestoreToBackup] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState("");
  const restoreToMut = useMutation({
    mutationFn: ({ backupId, targetId }: { backupId: string; targetId: string }) => api.restoreBackupTo(id, backupId, targetId),
    onSuccess: () => { setRestoreToBackup(null); setRestoreTarget(""); toast(t("databases.restoreSucceeded"), "success"); },
    onError: () => toast(t("databases.restoreFailed"), "error"),
    onSettled: invalidateRestores,
  });
  const tags = useMutation({ mutationFn: (next: string[]) => api.setDatabaseTags(id, next), onSuccess: invalidate });

  const [schedEnabled, setSchedEnabled] = useState(false);
  const [interval, setIntervalH] = useState("24");
  const [cron, setCron] = useState("");
  const [retention, setRetention] = useState("7");
  const [retentionDays, setRetentionDays] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importGzip, setImportGzip] = useState(true);
  const [importKey, setImportKey] = useState("");
  const importMut = useMutation({
    mutationFn: () => api.importDatabaseFromUrl(id, { url: importUrl.trim(), gzip: importGzip, encrypted: !!importKey.trim(), encryptionKey: importKey.trim() || undefined }),
    onSuccess: () => { setImportUrl(""); setImportKey(""); toast(t("databases.restoreSucceeded"), "success"); invalidate(); },
    onError: () => toast(t("databases.restoreFailed"), "error"),
    onSettled: invalidateRestores,
  });
  const [destinationId, setDestinationId] = useState("");
  useEffect(() => {
    if (db) {
      setSchedEnabled(db.backupEnabled);
      setIntervalH(String(db.backupIntervalHours ?? 24));
      setCron(db.backupCron ?? "");
      setRetention(String(db.backupRetention));
      setRetentionDays(db.backupRetentionDays != null ? String(db.backupRetentionDays) : "");
      setDestinationId(db.backupDestinationId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db?.id]);
  const saveSchedule = useMutation({
    mutationFn: () =>
      api.setBackupConfig(id, {
        enabled: schedEnabled,
        intervalHours: Number(interval) || 24,
        cron: cron.trim() || null,
        retention: Number(retention) || 7,
        retentionDays: retentionDays.trim() ? Number(retentionDays) : null,
        destinationId: destinationId || null,
      }),
    onSuccess: invalidate,
  });

  const tabDefs = [
    { key: "overview", label: t("databases.tabOverview"), icon: LayoutDashboard },
    ...(db?.canWrite && db?.status !== "NEW" ? [{ key: "logs", label: t("databases.tabLogs"), icon: ScrollText }] : []),
    ...(db?.status !== "NEW" ? [{ key: "metrics", label: t("databases.tabMetrics"), icon: Activity }] : []),
    { key: "backups", label: t("databases.tabBackups"), icon: DatabaseBackup },
    ...(db?.canWrite ? [{ key: "settings", label: t("databases.tabSettings"), icon: Settings2 }, { key: "shell", label: t("databases.tabShell"), icon: Terminal }] : []),
  ];
  const [tab, setTab] = useTabState("overview", tabDefs.map((d) => d.key));

  if (isError && !db) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !db) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={resourceBreadcrumb({ projectId: db.projectId, projectName: db.projectName, environmentName: db.environmentName, name: db.name, projectsLabel: t("nav.projects"), fallbackLabel: t("nav.databases"), fallbackHref: "/databases" })}
        title={db.name}
        status={{ label: provision.isPending && db.status === "NEW" ? "PROVISIONING" : db.status, color: dbColor(provision.isPending ? "PROVISIONING" : db.status) }}
        actions={
          db.canWrite ? (
            <>
              <Btn icon={db.status === "RUNNING" ? RotateCw : db.status === "STOPPED" ? Play : Rocket} iconTone={db.status === "RUNNING" ? "warn" : "success"} loading={provision.isPending} onClick={() => provision.mutate()}>
                {provision.isPending
                  ? t("databases.provisioning")
                  : db.status === "RUNNING" ? t("databases.restart")
                  : db.status === "STOPPED" ? t("databases.start")
                  : db.status === "FAILED" ? t("databases.retryProvision")
                  : t("databases.provision")}
              </Btn>
              <Btn icon={Square} variant="dangerGhost" loading={stop.isPending} disabled={db.status !== "RUNNING"} onClick={async () => { if (await confirm({ body: t("databases.stopConfirm"), danger: true })) stop.mutate(); }}>{t("databases.stop")}</Btn>
              <Btn icon={Terminal} variant="ghost" onClick={() => setTab("shell")}>{t("databases.openShell")}</Btn>
              <div ref={moreRef} style={{ position: "relative" }}>
                <Btn variant="ghost" onClick={() => setMoreOpen((o) => !o)} aria-haspopup="menu" aria-expanded={moreOpen} aria-label={t("databases.more")}><Ellipsis size={16} /></Btn>
                {moreOpen && (
                  <div
                    role="menu"
                    style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20, display: "flex", flexDirection: "column", gap: 6, padding: 8, minWidth: 140, background: "var(--c-bg, var(--c-el))", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", boxShadow: "0 6px 20px rgba(0,0,0,0.25)" }}
                  >
                    <Btn role="menuitem" icon={Pencil} variant="ghost" onClick={() => { setMoreOpen(false); setRenameOpen(true); }}>{t("databases.rename")}</Btn>
                    <Btn role="menuitem" icon={Copy} variant="ghost" onClick={() => { setMoreOpen(false); setCloneOpen(true); }}>{t("databases.clone")}</Btn>
                    <Btn role="menuitem" icon={Trash2} variant="dangerGhost" onClick={() => { setMoreOpen(false); void confirmAndDelete(); }}>{t("databases.delete")}</Btn>
                  </div>
                )}
              </div>
            </>
          ) : undefined
        }
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>
          {engineLabel(db.engine)} · {db.version} · :{db.port}{db.hostPort ? ` → host :${db.hostPort}` : ""}
        </p>
      </PageHeader>

      <DatabaseIconCard id={id} iconUpdatedAt={db.iconUpdatedAt} canWrite={db.canWrite} onChanged={invalidate} />

      {renameOpen && (
        <RenameModal
          current={db.name}
          title={t("databases.rename")}
          pending={rename.isPending}
          onClose={() => setRenameOpen(false)}
          onSave={(name) => rename.mutate(name)}
        />
      )}
      {cloneOpen && (
        <RenameModal
          current={`${db.name.slice(0, 53)} (copy)`}
          title={t("databases.cloneTitle")}
          hint={t("databases.cloneHint")}
          saveLabel={t("databases.clone")}
          maxLength={60}
          pending={clone.isPending}
          onClose={() => setCloneOpen(false)}
          onSave={(name) => clone.mutate(name)}
        />
      )}
      {runDetail && (
        <BackupRunModal
          run={runDetail}
          destinationName={destinations.find((d) => d.id === runDetail.destinationId)?.name ?? null}
          exportUrl={(bid) => api.exportDatabaseBackupUrl(id, bid)}
          onClose={() => setRunDetailId(null)}
        />
      )}
      {restoreToBackup && (
        <Modal onClose={() => setRestoreToBackup(null)} width={420} ariaLabel={t("databases.restoreToTitle")}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("databases.restoreToTitle")}</div>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("databases.restoreToConfirm")}</p>
          <Select
            value={restoreTarget}
            onChange={setRestoreTarget}
            placeholder={t("databases.restoreToTarget")}
            options={compatibleRestoreTargets(allDatabases, db).map((d) => ({ value: d.id, label: d.name }))}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <Btn variant="ghost" onClick={() => setRestoreToBackup(null)}>{t("common.cancel")}</Btn>
            <Btn variant="danger" disabled={!restoreTarget || restoreToMut.isPending} onClick={() => restoreToMut.mutate({ backupId: restoreToBackup, targetId: restoreTarget })}>
              {restoreToMut.isPending ? "…" : t("databases.restore")}
            </Btn>
          </div>
        </Modal>
      )}

      <Tabs active={tab} onChange={setTab} tabs={tabDefs} />

      {tab === "shell" && db.canWrite && (
        <TerminalPanel
          target={{ database: id }}
          unavailableReason={db.status !== "RUNNING" ? t("databases.shellDisabledHint") : undefined}
          height={520}
        />
      )}

      {tab === "overview" && (
        provision.isPending || (isDbTransitional(db.status) && !db.connectionUri && db.status !== "NEW") ? (
          <Card style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <Spinner />
              <div style={{ fontWeight: 600 }}>{t("databases.provisioningCardTitle")}</div>
            </div>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("databases.provisioningCardBody")}</p>
          </Card>
        ) : db.canWrite && db.connectionUri ? (
          <SectionCard title={t("databases.connection")} desc={t("databases.connectionDesc")} style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <CopyRow label={t("databases.uri")} value={db.connectionUri} copy={t("databases.copy")} secret />
              {db.internalHost && <CopyRow label={t("databases.host")} value={db.internalHost} copy={t("databases.copy")} />}
              {db.username && <CopyRow label={t("databases.username")} value={db.username} copy={t("databases.copy")} />}
              {db.password && <CopyRow label={t("databases.password")} value={db.password} copy={t("databases.copy")} secret />}
              {db.database && <CopyRow label={t("databases.database")} value={db.database} copy={t("databases.copy")} />}
            </div>
            {db.publicUri ? (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--c-bd)" }}>
                <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("databases.publicConnection")}</div>
                <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("databases.publicConnectionDesc")}</p>
                <CopyRow label={t("databases.uriPublic")} value={db.publicUri} copy={t("databases.copy")} secret />
              </div>
            ) : db.hostPort ? (
              <p style={{ margin: "16px 0 0", paddingTop: 16, borderTop: "1px solid var(--c-bd)", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
                {t("databases.publicPortNoIp", { port: db.hostPort })}
              </p>
            ) : null}
          </SectionCard>
        ) : (
          <Card style={{ padding: 16 }}><EmptyState>{t("databases.connectionPending")}</EmptyState></Card>
        )
      )}

      {tab === "logs" && db.canWrite && (
        <LiveLogsCard basePath={`/databases/${id}`} title={t("databases.tabLogs")} />
      )}

      {tab === "metrics" && <AppMetricsCard id={id} kind="database" />}

      {tab === "settings" && db.canWrite && (
        <>
          <EnvironmentCard kind="database" id={id} environmentId={db.environmentId} />
          <div style={{ marginTop: 16 }}>
            <DbServerCard id={id} teamId={db.teamId} serverId={db.serverId} status={db.status} provisioning={provision.isPending} />
          </div>
          <div style={{ marginTop: 16 }}>
            <DbLimitsCard id={id} healthCmd={db.healthCmd} memoryMb={db.memoryMb} cpus={db.cpus} />
          </div>
          <div style={{ marginTop: 16 }}>
            <EnvCard
              id={id}
              canWrite={db.canWrite}
              title={t("databases.env")}
              desc={t("databases.envDesc")}
              redeployHint={t("databases.envRedeploy")}
              fetchEnv={() => api.getDatabaseEnv(id)}
              saveEnv={(env) => api.setDatabaseEnv(id, env)}
              queryKey={["dbEnv", id]}
              relatedKey={["database", id]}
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <DbVolumesCard id={id} volumes={db.volumes} />
          </div>
          <div style={{ marginTop: 16 }}>
            <DbPublicPortCard id={id} hostPort={db.hostPort} />
          </div>
          <div style={{ marginTop: 16 }}>
            <TagsCard tags={db.tags} canWrite={db.canWrite} onSave={(next) => tags.mutate(next)} />
          </div>
          <div style={{ marginTop: 16 }}>
            <SectionCard title={t("databases.dangerDeleteTitle")} desc={t("databases.dangerDeleteDesc")} style={{ marginBottom: 0, borderColor: "var(--c-r)" }}>
              <Btn icon={Trash2} variant="dangerGhost" loading={del.isPending} onClick={() => void confirmAndDelete()}>{t("databases.delete")}</Btn>
            </SectionCard>
          </div>
        </>
      )}

      {tab === "backups" && db.canWrite && !db.backupSupported && (
        <Card style={{ padding: 16, color: "var(--c-tx3)", fontSize: 13 }}>
          {t("databases.backupUnsupported")}
        </Card>
      )}

      {tab === "backups" && db.canWrite && db.backupSupported && (
        <SectionCard
          title={t("databases.backups")}
          desc={t("databases.backupsDesc")}
          style={{ marginBottom: 0 }}
          right={
            <Btn onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
              {backupNow.isPending ? t("databases.backingUp") : t("databases.backupNow")}
            </Btn>
          }
        >

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
              <input type="checkbox" checked={schedEnabled} onChange={(e) => setSchedEnabled(e.target.checked)} />
              {t("databases.schedule")}
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              {t("databases.every")}
              <input style={fieldSm} type="number" value={interval} onChange={(e) => setIntervalH(e.target.value)} disabled={!!cron.trim()} />
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }} title={t("databases.backupCronHint")}>
              {t("databases.backupCron")}
              <input style={{ ...fieldSm, width: 120 }} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 3 * * *" />
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              {t("databases.keep")}
              <input style={fieldSm} type="number" value={retention} onChange={(e) => setRetention(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }} title={t("databases.backupRetentionDaysHint")}>
              {t("databases.backupRetentionDays")}
              <input style={fieldSm} type="number" value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} placeholder="∞" />
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              {t("databases.destination")}
              <select style={{ ...fieldSm, width: "auto" }} value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                <option value="">{t("databases.localDisk")}</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <Btn variant="ghost" onClick={() => saveSchedule.mutate()} disabled={saveSchedule.isPending}>{t("databases.save")}</Btn>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {backups.map((b) => (
              <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: backupColor(b.status) }}>{b.status}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{b.filename}</span>
                  <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{formatSize(b.sizeBytes)}</span>
                  <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(b.createdAt).toLocaleString()}</span>
                  <button onClick={() => setRunDetailId(b.id)} style={linkBtn}>{t("databases.runDetails")}</button>
                  {b.destinationType === "S3" && b.status === "SUCCESS" && (
                    <button onClick={() => exportUrl.mutate(b.id)} disabled={exportUrl.isPending} title={t("databases.exportHint")} style={{ ...linkBtn, color: "var(--c-a)" }}>
                      {exportUrl.isPending && exportUrl.variables === b.id ? "…" : t("databases.exportUrl")}
                    </button>
                  )}
                  <button
                    onClick={async () => { if (await confirm({ body: t("databases.restoreConfirm"), danger: true })) restore.mutate(b.id); }}
                    style={linkBtn}
                  >
                    {t("databases.restore")}
                  </button>
                  {b.status === "SUCCESS" && db.canWrite && compatibleRestoreTargets(allDatabases, db).length > 0 && (
                    <button onClick={() => { setRestoreTarget(""); setRestoreToBackup(b.id); }} style={linkBtn}>{t("databases.restoreTo")}</button>
                  )}
                  <button aria-label={t("common.delete")} onClick={async () => { if (await confirm({ body: t("common.deleteNamedConfirm", { name: b.filename }), danger: true })) delBackup.mutate(b.id); }} style={{ ...linkBtn, color: "var(--c-r)", display: "inline-flex", alignItems: "center" }}><Trash2 size={14} /></button>
                </div>
                {b.status === "FAILED" && (
                  // A failed row must say WHY (not look empty): the last line of the scrubbed output, full text in the modal.
                  <div className="mono" title={b.errorTail ?? undefined} style={{ padding: "0 12px", fontSize: 11, color: "var(--c-r)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {lastErrorLine(b.errorTail) ?? t("databases.runNoReason")}
                  </div>
                )}
                {exported?.id === b.id && (
                  <div style={{ padding: "0 4px 4px" }}>
                    <CopyRow label={t("databases.exportUrl")} value={exported.url} copy={t("databases.copy")} secret />
                    <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 2 }}>{t("databases.exportExpiry")}</div>
                  </div>
                )}
              </div>
            ))}
            {backups.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("databases.noBackups")}</div>}
          </div>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-bd)" }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("databases.import")}</div>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 10px" }}>{t("databases.importDesc")}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input style={{ ...fieldSm, width: 320, flex: "1 1 280px" }} placeholder={t("databases.importUrl")} aria-label={t("databases.importUrl")} value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
              <input style={{ ...fieldSm, width: 160 }} type="password" placeholder={t("databases.importKey")} aria-label={t("databases.importKey")} value={importKey} onChange={(e) => setImportKey(e.target.value)} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
                <input type="checkbox" checked={importGzip} onChange={(e) => setImportGzip(e.target.checked)} />
                {t("databases.importGzip")}
              </label>
              <Btn onClick={async () => { if (importUrl.trim() && await confirm({ body: t("databases.importConfirm"), danger: true })) importMut.mutate(); }} disabled={importMut.isPending || !importUrl.trim()}>
                {importMut.isPending ? "…" : t("databases.importRun")}
              </Btn>
            </div>
          </div>

          {restores.length > 0 && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-bd)" }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("databases.restoreHistory")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {restores.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: restoreColor(r.status) }}>{r.status}</span>
                    <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t(`databases.restoreKind_${r.kind}`)}</span>
                    <span style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{new Date(r.createdAt).toLocaleString()}</span>
                    {r.status === "FAILED" && r.errorTail && (
                      <span className="mono" title={r.errorTail} style={{ fontSize: 11, color: "var(--c-r)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.errorTail.trim().split("\n").pop()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}

const fieldSm: React.CSSProperties = {
  width: 64,
  padding: "5px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "inherit",
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--c-lapis)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

const limField: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "inherit",
};

function DbLimitsCard({ id, healthCmd, memoryMb, cpus }: { id: string; healthCmd: string | null; memoryMb: number | null; cpus: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [hc, setHc] = useState(healthCmd ?? "");
  const [mem, setMem] = useState(memoryMb != null ? String(memoryMb) : "");
  const [cpu, setCpu] = useState(cpus != null ? String(cpus) : "");
  const save = useMutation({
    mutationFn: () =>
      api.setDatabaseLimits(id, {
        healthCmd: hc.trim() || null,
        memoryMb: mem ? Number(mem) : null,
        cpus: cpu ? Number(cpu) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["database", id] }),
  });
  return (
    <SectionCard title={t("databases.limits")} desc={t("databases.limitsDesc")} style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...limField, flex: "1 1 100%" }} placeholder={t("databases.healthCmd")} aria-label={t("databases.healthCmd")} value={hc} onChange={(e) => setHc(e.target.value)} />
        <input style={{ ...limField, width: 150 }} type="number" placeholder={t("databases.memoryMb")} aria-label={t("databases.memoryMb")} value={mem} onChange={(e) => setMem(e.target.value)} />
        <input style={{ ...limField, width: 130 }} type="number" step="0.1" placeholder={t("databases.cpus")} aria-label={t("databases.cpus")} value={cpu} onChange={(e) => setCpu(e.target.value)} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("databases.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("databases.limitsRedeploy")}</div>}
    </SectionCard>
  );
}

function DbPublicPortCard({ id, hostPort }: { id: string; hostPort: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [port, setPort] = useState(hostPort != null ? String(hostPort) : "");
  const save = useMutation({
    mutationFn: () => api.setDatabasePort(id, port.trim() ? Number(port) : null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["database", id] }),
  });
  return (
    <SectionCard title={t("databases.publicPort")} desc={t("databases.publicPortDesc")} style={{ marginBottom: 0 }}>
      <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 12px" }}>
        {hostPort != null ? t("databases.publicPortExposed", { port: hostPort }) : t("databases.publicPortInternal")}
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input style={{ ...limField, width: 150 }} type="number" placeholder={t("databases.publicPortField")} aria-label={t("databases.publicPortField")} value={port} onChange={(e) => setPort(e.target.value)} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("databases.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("databases.publicPortRedeploy")}</div>}
    </SectionCard>
  );
}

type DbVolume = { name: string; path: string };

/** Extra persistent volumes for a database (name + absolute container path). The real docker volume name is
 *  derived server-side per-database; the managed data volume cannot be reused. Mirrors the app VolumesCard. */
function DbVolumesCard({ id, volumes }: { id: string; volumes: DbVolume[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [rows, setRows] = useState<DbVolume[]>(volumes);
  const save = useMutation({
    mutationFn: () => api.setDatabaseVolumes(id, rows.filter((r) => r.name.trim() && r.path.trim())),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["database", id] }),
  });
  const setRow = (i: number, patch: Partial<DbVolume>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <SectionCard title={t("databases.volumes")} desc={t("databases.volumesDesc")} style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...limField, width: 160 }} placeholder={t("databases.volumeName")} aria-label={t("databases.volumeName")} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} spellCheck={false} autoComplete="off" />
            <input style={{ ...limField, flex: 1 }} placeholder={t("databases.volumePath")} aria-label={t("databases.volumePath")} value={r.path} onChange={(e) => setRow(i, { path: e.target.value })} spellCheck={false} autoComplete="off" />
            <button
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              aria-label={t("common.remove")}
              style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", padding: "4px 9px", fontFamily: "inherit", display: "inline-flex", alignItems: "center" }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { name: "", path: "" }])}>{t("databases.addVolume")}</Btn>
          <div style={{ flex: 1 }} />
          <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("databases.save")}</Btn>
        </div>
      </div>
      {save.isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("databases.volumesSaveFailed")}</div>}
      {save.isSuccess && <div role="status" style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("databases.volumesRedeploy")}</div>}
    </SectionCard>
  );
}

/** Move a database to another server in the same team. Safe only before first deploy (status NEW): a
 *  provisioned database's data lives in a volume on its current server and can't cross servers, so the move
 *  is locked with a hint to back up + restore to a new database on the target instead. */
function DbServerCard({ id, teamId, serverId, status, provisioning }: { id: string; teamId: string; serverId: string; status: string; provisioning: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: servers = [] } = useQuery({ queryKey: ["servers", teamId], queryFn: () => api.listServers({ teamId }) });
  const [target, setTarget] = useState(serverId);
  // Only a NEW database can move, and never while a deploy is in flight (it stays NEW client-side until the
  // provision call returns, but the server has already claimed it PROVISIONING — the API would refuse).
  const movable = status === "NEW" && !provisioning;
  const move = useMutation({
    mutationFn: () => api.moveDatabaseToServer(id, target),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["database", id] }),
  });
  const options = servers.map((s) => ({ value: s.id, label: s.id === serverId ? `${s.name} ${t("databases.moveServerCurrent")}` : s.name }));
  return (
    <SectionCard title={t("databases.moveServerTitle")} desc={t("databases.moveServerDesc")} style={{ marginBottom: 0 }}>
      {!movable && <p style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px" }}>{t("databases.moveServerLocked")}</p>}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Select value={target} onChange={setTarget} options={options} ariaLabel={t("databases.moveServerTitle")} disabled={!movable || move.isPending} />
        <Btn onClick={() => move.mutate()} disabled={!movable || move.isPending || target === serverId}>{t("databases.moveServerAction")}</Btn>
      </div>
      {move.isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{move.error instanceof Error && move.error.message ? move.error.message : t("databases.actionFailed")}</div>}
      {move.isSuccess && <div role="status" style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("databases.moveServerDone")}</div>}
    </SectionCard>
  );
}

/** A database's custom icon: a square PNG (write-gated), shown with a database fallback. Mirrors the app/
 *  project/team icon cards — the browser center-crops to a small PNG before upload to fit the 64KB cap. */
function DatabaseIconCard({ id, iconUpdatedAt, canWrite, onChanged }: { id: string; iconUpdatedAt: string | null; canWrite: boolean; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const url = databaseIconUrl(id, iconUpdatedAt);

  const save = useMutation({
    mutationFn: (data: string) => api.setDatabaseIcon(id, data),
    onSuccess: () => { onChanged(); toast(t("databases.iconUploaded"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("databases.iconFailed"), "error"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDatabaseIcon(id),
    onSuccess: () => { onChanged(); toast(t("databases.iconRemoved"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("databases.iconFailed"), "error"),
  });

  const onPick = async (file: File) => {
    setProcessing(true);
    try {
      let data = "";
      for (const side of [128, 96, 64]) {
        data = await cropToPngBase64(file, side);
        if (data.length * 0.75 <= 64 * 1024) break;
      }
      if (data.length * 0.75 > 64 * 1024) { toast(t("databases.iconTooLarge"), "error"); return; }
      save.mutate(data);
    } catch {
      toast(t("databases.iconReadFailed"), "error");
    } finally {
      setProcessing(false);
    }
  };

  if (!canWrite && !url) return null; // nothing to show a read-only member with no icon

  const busy = processing || save.isPending || remove.isPending;
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
          {url ? <img src={url} alt="" width={48} height={48} style={{ objectFit: "cover" }} /> : <DatabaseIcon size={22} color="var(--c-tx3)" />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{t("databases.iconTitle")}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("databases.iconHint")}</div>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" icon={CloudUpload} onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? "…" : url ? t("databases.iconReplace") : t("databases.iconUpload")}
            </Btn>
            {url && <Btn variant="ghost" icon={Trash2} onClick={() => remove.mutate()} disabled={busy}>{t("databases.iconRemove")}</Btn>}
          </div>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onPick(f); }} />
    </Card>
  );
}

