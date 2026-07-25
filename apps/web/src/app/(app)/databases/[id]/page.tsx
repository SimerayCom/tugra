"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { dbColor, engineLabel } from "../../../../lib/databases";
import { backupColor, formatSize, restoreColor } from "../../../../lib/backups";
import { ErrorState } from "../../../../components/error-state";
import { resourceBreadcrumb } from "../../../../lib/breadcrumb";
import { useTabState } from "../../../../hooks/useTabState";
import { CopyRow } from "../../../../components/copy-row";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { Tabs } from "../../../../components/tabs-nav";
import { EnvironmentCard } from "../../../../components/environment-card";
import { TagsCard } from "../../../../components/tags";
import { RenameModal } from "../../../../components/rename-modal";
import { TerminalModal } from "../../../../components/terminal-modal";
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
    refetchInterval: 5000,
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
  const provision = useMutation({ mutationFn: () => api.provisionDatabase(id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stopDatabase(id), onSuccess: invalidate });
  const [renameOpen, setRenameOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) => api.renameDatabase(id, name),
    onSuccess: () => { setRenameOpen(false); invalidate(); },
  });
  const del = useMutation({
    mutationFn: () => api.deleteDatabase(id),
    onSuccess: () => router.replace("/databases"),
  });
  const backupNow = useMutation({ mutationFn: () => api.backupNow(id), onSuccess: invalidateBackups });
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
  const [retention, setRetention] = useState("7");
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
      setRetention(String(db.backupRetention));
      setDestinationId(db.backupDestinationId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db?.id]);
  const saveSchedule = useMutation({
    mutationFn: () =>
      api.setBackupConfig(id, {
        enabled: schedEnabled,
        intervalHours: Number(interval) || 24,
        retention: Number(retention) || 7,
        destinationId: destinationId || null,
      }),
    onSuccess: invalidate,
  });

  const tabDefs = [
    { key: "overview", label: t("databases.tabOverview") },
    { key: "backups", label: t("databases.tabBackups") },
    ...(db?.canWrite ? [{ key: "settings", label: t("databases.tabSettings") }] : []),
  ];
  const [tab, setTab] = useTabState("overview", tabDefs.map((d) => d.key));

  if (isError && !db) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !db) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={resourceBreadcrumb({ projectId: db.projectId, projectName: db.projectName, environmentName: db.environmentName, name: db.name, projectsLabel: t("nav.projects"), fallbackLabel: t("nav.databases"), fallbackHref: "/databases" })}
        title={db.name}
        status={{ label: db.status, color: dbColor(db.status) }}
        actions={
          db.canWrite ? (
            <>
              <Btn onClick={() => provision.mutate()} disabled={provision.isPending}>
                {provision.isPending ? t("databases.provisioning") : t("databases.provision")}
              </Btn>
              <Btn variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{t("databases.stop")}</Btn>
              <Btn variant="ghost" onClick={() => setShellOpen(true)}>{t("databases.openShell")}</Btn>
              <Btn variant="ghost" onClick={() => setRenameOpen(true)}>{t("databases.rename")}</Btn>
              <Btn variant="danger" onClick={async () => { if (await confirm({ title: t("databases.delete"), body: t("databases.deleteConfirm"), danger: true })) del.mutate(); }}>{t("databases.delete")}</Btn>
            </>
          ) : undefined
        }
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>
          {engineLabel(db.engine)} · {db.version} · :{db.port}{db.hostPort ? ` → host :${db.hostPort}` : ""}
        </p>
      </PageHeader>

      {renameOpen && (
        <RenameModal
          current={db.name}
          title={t("databases.rename")}
          pending={rename.isPending}
          onClose={() => setRenameOpen(false)}
          onSave={(name) => rename.mutate(name)}
        />
      )}
      {shellOpen && (
        <TerminalModal
          target={{ database: id }}
          title={t("terminal.containerTitle", { name: db.name })}
          onClose={() => setShellOpen(false)}
        />
      )}
      {restoreToBackup && (
        <Modal onClose={() => setRestoreToBackup(null)} width={420}>
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

      {tab === "overview" && (
        db.canWrite && db.connectionUri ? (
          <Card style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("databases.connection")}</div>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("databases.connectionDesc")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <CopyRow label={t("databases.uri")} value={db.connectionUri} copy={t("databases.copy")} secret />
              {db.internalHost && <CopyRow label={t("databases.host")} value={db.internalHost} copy={t("databases.copy")} />}
              {db.username && <CopyRow label={t("databases.username")} value={db.username} copy={t("databases.copy")} />}
              {db.password && <CopyRow label={t("databases.password")} value={db.password} copy={t("databases.copy")} secret />}
              {db.database && <CopyRow label={t("databases.database")} value={db.database} copy={t("databases.copy")} />}
            </div>
          </Card>
        ) : (
          <Card style={{ padding: 16 }}><EmptyState>{t("databases.connectionPending")}</EmptyState></Card>
        )
      )}

      {tab === "settings" && db.canWrite && (
        <>
          <EnvironmentCard kind="database" id={id} environmentId={db.environmentId} />
          <div style={{ marginTop: 16 }}>
            <DbLimitsCard id={id} healthCmd={db.healthCmd} memoryMb={db.memoryMb} cpus={db.cpus} />
          </div>
          <div style={{ marginTop: 16 }}>
            <DbPublicPortCard id={id} hostPort={db.hostPort} />
          </div>
          <div style={{ marginTop: 16 }}>
            <TagsCard tags={db.tags} canWrite={db.canWrite} onSave={(next) => tags.mutate(next)} />
          </div>
        </>
      )}

      {tab === "backups" && db.canWrite && !db.backupSupported && (
        <Card style={{ padding: 16, color: "var(--c-tx3)", fontSize: 13 }}>
          {t("databases.backupUnsupported")}
        </Card>
      )}

      {tab === "backups" && db.canWrite && db.backupSupported && (
        <Card style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("databases.backups")}</div>
            <Btn onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
              {backupNow.isPending ? t("databases.backingUp") : t("databases.backupNow")}
            </Btn>
          </div>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("databases.backupsDesc")}</p>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
              <input type="checkbox" checked={schedEnabled} onChange={(e) => setSchedEnabled(e.target.checked)} />
              {t("databases.schedule")}
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              {t("databases.every")}
              <input style={fieldSm} type="number" value={interval} onChange={(e) => setIntervalH(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              {t("databases.keep")}
              <input style={fieldSm} type="number" value={retention} onChange={(e) => setRetention(e.target.value)} />
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
                  <button onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) delBackup.mutate(b.id); }} style={{ ...linkBtn, color: "var(--c-r)" }}>✕</button>
                </div>
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
              <input style={{ ...fieldSm, width: 320, flex: "1 1 280px" }} placeholder={t("databases.importUrl")} value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
              <input style={{ ...fieldSm, width: 160 }} type="password" placeholder={t("databases.importKey")} value={importKey} onChange={(e) => setImportKey(e.target.value)} />
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
        </Card>
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
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("databases.limits")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("databases.limitsDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...limField, flex: "1 1 100%" }} placeholder={t("databases.healthCmd")} value={hc} onChange={(e) => setHc(e.target.value)} />
        <input style={{ ...limField, width: 150 }} type="number" placeholder={t("databases.memoryMb")} value={mem} onChange={(e) => setMem(e.target.value)} />
        <input style={{ ...limField, width: 130 }} type="number" step="0.1" placeholder={t("databases.cpus")} value={cpu} onChange={(e) => setCpu(e.target.value)} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("databases.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("databases.limitsRedeploy")}</div>}
    </Card>
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
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("databases.publicPort")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" }}>{t("databases.publicPortDesc")}</p>
      <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 12px" }}>
        {hostPort != null ? t("databases.publicPortExposed", { port: hostPort }) : t("databases.publicPortInternal")}
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input style={{ ...limField, width: 150 }} type="number" placeholder={t("databases.publicPortField")} value={port} onChange={(e) => setPort(e.target.value)} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("databases.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("databases.publicPortRedeploy")}</div>}
    </Card>
  );
}

