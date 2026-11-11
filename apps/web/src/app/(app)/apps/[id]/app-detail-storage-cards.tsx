"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { BackupRunModal } from "../../../../components/backup-run-modal";
import { useConfirm } from "../../../../components/confirm";
import { CopyRow } from "../../../../components/copy-row";
import { Btn, SectionCard } from "../../../../components/ui";
import { useT } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { backupColor, formatSize, lastErrorLine } from "../../../../lib/backups";
import { type AppVolume, type HostMount } from "../../../../lib/types";
import { envField, volField } from "./app-detail-shared";

export function VolumesCard({ id, volumes }: { id: string; volumes: AppVolume[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [rows, setRows] = useState<AppVolume[]>(volumes.length ? volumes : []);
  const save = useMutation({
    mutationFn: () =>
      api.setAppVolumes(
        id,
        rows.filter((r) => r.name.trim() && r.path.trim()),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const setRow = (i: number, patch: Partial<AppVolume>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <SectionCard title={t("apps.volumes")} desc={t("apps.volumesDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...envField, width: 160 }} placeholder={t("apps.volumeName")} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} aria-label={t("apps.volumeName")} />
            <input style={{ ...envField, flex: 1 }} placeholder={t("apps.volumePath")} value={r.path} onChange={(e) => setRow(i, { path: e.target.value })} aria-label={t("apps.volumePath")} />
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
          <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { name: "", path: "" }])}>{t("apps.addVolume")}</Btn>
          <div style={{ flex: 1 }} />
          <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
        </div>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}

export function HostMountsCard({ id, hostMounts }: { id: string; hostMounts: HostMount[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [rows, setRows] = useState<HostMount[]>(hostMounts.length ? hostMounts : []);
  const save = useMutation({
    mutationFn: () =>
      api.setAppHostMounts(
        id,
        rows.filter((r) => r.hostPath.trim() && r.containerPath.trim()),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const setRow = (i: number, patch: Partial<HostMount>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <SectionCard title={t("apps.hostMounts")} desc={t("apps.hostMountsDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input style={{ ...envField, flex: 1, minWidth: 150 }} placeholder={t("apps.hostMountHostPath")} value={r.hostPath} onChange={(e) => setRow(i, { hostPath: e.target.value })} aria-label={t("apps.hostMountHostPath")} />
            <span style={{ color: "var(--c-tx3)" }}>→</span>
            <input style={{ ...envField, flex: 1, minWidth: 150 }} placeholder={t("apps.hostMountContainerPath")} value={r.containerPath} onChange={(e) => setRow(i, { containerPath: e.target.value })} aria-label={t("apps.hostMountContainerPath")} />
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--c-tx2)" }}>
              <input type="checkbox" checked={r.readOnly !== false} onChange={(e) => setRow(i, { readOnly: e.target.checked })} />
              {t("apps.hostMountReadOnly")}
            </label>
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
          <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { hostPath: "", containerPath: "", readOnly: true }])}>{t("apps.addHostMount")}</Btn>
          <div style={{ flex: 1 }} />
          <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
        </div>
      </div>
      <p style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 10, lineHeight: 1.5 }}>{t("apps.hostMountsHint")}</p>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}

export function VolumeBackupsCard({ id, volumes, enabled, intervalHours, retention, destinationId }: { id: string; volumes: AppVolume[]; enabled: boolean; intervalHours: number | null; retention: number; destinationId: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: backups = [] } = useQuery({ queryKey: ["volBackups", id], queryFn: () => api.listVolumeBackups(id), refetchInterval: 5000 });
  const { data: destinations = [] } = useQuery({ queryKey: ["destinations"], queryFn: () => api.listDestinations() });
  const [sched, setSched] = useState(enabled);
  const [interval, setIntervalH] = useState(String(intervalHours ?? 24));
  const [ret, setRet] = useState(String(retention));
  const [dest, setDest] = useState(destinationId ?? "");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["volBackups", id] });
  const backupNow = useMutation({ mutationFn: () => api.volumeBackupNow(id), onSuccess: invalidate });
  const restore = useMutation({ mutationFn: (bid: string) => api.restoreVolumeBackup(id, bid) });
  const del = useMutation({ mutationFn: (bid: string) => api.deleteVolumeBackup(id, bid), onSuccess: invalidate });
  // Migrator export: a presigned migration URL for an S3 backup (feed it to import-from-URL elsewhere).
  const [exported, setExported] = useState<{ id: string; url: string } | null>(null);
  const exportUrl = useMutation({
    mutationFn: (bid: string) => api.exportVolumeBackupUrl(id, bid),
    onSuccess: (res, bid) => setExported({ id: bid, url: res.url }),
  });
  // Run-detail modal: keep only the id so the open modal tracks the polled row (e.g. RUNNING → FAILED).
  const [runDetailId, setRunDetailId] = useState<string | null>(null);
  const runDetail = backups.find((b) => b.id === runDetailId) ?? null;
  const save = useMutation({
    mutationFn: () => api.setVolumeBackupConfig(id, { enabled: sched, intervalHours: Number(interval) || 24, retention: Number(ret) || 7, destinationId: dest || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });

  // Migrator data-pull: import a volume's data from an external staged tar(.gz) URL (overwrites the volume).
  const [showImport, setShowImport] = useState(false);
  const [impVol, setImpVol] = useState(volumes[0]?.name ?? "");
  const [impUrl, setImpUrl] = useState("");
  const [impGzip, setImpGzip] = useState(true);
  const [impEnc, setImpEnc] = useState(false);
  const [impKey, setImpKey] = useState("");
  const importMut = useMutation({
    mutationFn: () =>
      api.importVolumeFromUrl(id, {
        volumeName: impVol,
        url: impUrl.trim(),
        gzip: impGzip,
        encrypted: impEnc,
        encryptionKey: impEnc ? impKey : undefined,
      }),
    onSuccess: () => { setShowImport(false); setImpUrl(""); setImpKey(""); invalidate(); },
  });

  return (
    <SectionCard
      title={t("apps.volBackups")}
      desc={t("apps.volBackupsDesc")}
      right={
        <>
          <Btn variant="ghost" onClick={() => setShowImport((v) => !v)}>{t("apps.volImport")}</Btn>
          <Btn onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
            {backupNow.isPending ? t("databases.backingUp") : t("databases.backupNow")}
          </Btn>
        </>
      }
    >
      {runDetail && (
        <BackupRunModal
          run={runDetail}
          destinationName={destinations.find((d) => d.id === runDetail.destinationId)?.name ?? null}
          exportUrl={(bid) => api.exportVolumeBackupUrl(id, bid)}
          onClose={() => setRunDetailId(null)}
        />
      )}
      {showImport && (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.volImportDesc")}</div>
          <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
            {t("apps.volImportVolume")}
            <select style={{ ...volField, width: "auto" }} value={impVol} onChange={(e) => setImpVol(e.target.value)}>
              {volumes.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </label>
          <input style={{ ...volField, width: "100%" }} placeholder="https://…/volume.tar.gz" value={impUrl} onChange={(e) => setImpUrl(e.target.value)} aria-label={t("apps.volImportUrl")} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={impGzip} onChange={(e) => setImpGzip(e.target.checked)} /> {t("apps.volImportGzip")}
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={impEnc} onChange={(e) => setImpEnc(e.target.checked)} /> {t("apps.volImportEncrypted")}
            </label>
            {impEnc && <input style={{ ...volField, flex: 1, minWidth: 160 }} type="password" placeholder={t("apps.volImportKey")} value={impKey} onChange={(e) => setImpKey(e.target.value)} aria-label={t("apps.volImportKey")} />}
          </div>
          <div style={{ fontSize: 11, color: "var(--c-am)" }}>{t("apps.volImportWarn")}</div>
          <div>
            <Btn
              onClick={async () => { if (await confirm({ body: t("apps.volImportConfirm"), danger: true })) importMut.mutate(); }}
              disabled={importMut.isPending || !impVol || !impUrl.trim() || (impEnc && !impKey)}
            >
              {importMut.isPending ? "…" : t("apps.volImportRun")}
            </Btn>
          </div>
          {importMut.isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{(importMut.error as Error).message}</div>}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={sched} onChange={(e) => setSched(e.target.checked)} />
          {t("databases.schedule")}
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("databases.every")}
          <input style={volField} type="number" value={interval} onChange={(e) => setIntervalH(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("databases.keep")}
          <input style={volField} type="number" value={ret} onChange={(e) => setRet(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("databases.destination")}
          <select style={{ ...volField, width: "auto" }} value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">{t("databases.localDisk")}</option>
            {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("databases.save")}</Btn>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {backups.map((b) => (
          <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: backupColor(b.status) }}>{b.status}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", width: 90 }}>{b.volumeName}</span>
              <span style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{formatSize(b.sizeBytes)}</span>
              <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(b.createdAt).toLocaleString()}</span>
              <button onClick={() => setRunDetailId(b.id)} style={{ background: "transparent", border: "none", color: "var(--c-tx2)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>{t("databases.runDetails")}</button>
              {b.destinationType === "S3" && b.status === "SUCCESS" && (
                <button onClick={() => exportUrl.mutate(b.id)} disabled={exportUrl.isPending} title={t("apps.volExportHint")} style={{ background: "transparent", border: "none", color: "var(--c-a)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {exportUrl.isPending && exportUrl.variables === b.id ? "…" : t("apps.volExportUrl")}
                </button>
              )}
              <button onClick={async () => { if (await confirm({ body: t("databases.restoreConfirm"), danger: true })) restore.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {t("databases.restore")}
              </button>
              <button aria-label={t("common.delete")} onClick={async () => { if (await confirm({ body: t("common.deleteNamedConfirm", { name: new Date(b.createdAt).toLocaleString() }), danger: true })) del.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-r)", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
            </div>
            {b.status === "FAILED" && (
              // A failed row must say WHY (not look empty): the last line of the scrubbed output, full text in the modal.
              <div className="mono" title={b.errorTail ?? undefined} style={{ padding: "0 12px", fontSize: 11, color: "var(--c-r)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {lastErrorLine(b.errorTail) ?? t("databases.runNoReason")}
              </div>
            )}
            {exported?.id === b.id && (
              <div style={{ padding: "0 4px 4px" }}>
                <CopyRow label={t("apps.volExportUrl")} value={exported.url} copy={t("apps.copy")} secret />
                <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 2 }}>{t("apps.volExportExpiry")}</div>
              </div>
            )}
          </div>
        ))}
        {backups.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.noVolBackups")}</div>}
      </div>
      {restore.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(restore.error as Error).message}</div>}
      {exportUrl.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(exportUrl.error as Error).message}</div>}
    </SectionCard>
  );
}
