"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { dbColor, engineLabel } from "../../../../lib/databases";
import { backupColor, formatSize } from "../../../../lib/backups";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../../components/ui";

export default function DatabaseDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: db, isLoading } = useQuery({
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["database", id] });
  const invalidateBackups = () => qc.invalidateQueries({ queryKey: ["backups", id] });
  const provision = useMutation({ mutationFn: () => api.provisionDatabase(id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stopDatabase(id), onSuccess: invalidate });
  const del = useMutation({
    mutationFn: () => api.deleteDatabase(id),
    onSuccess: () => router.replace("/databases"),
  });
  const backupNow = useMutation({ mutationFn: () => api.backupNow(id), onSuccess: invalidateBackups });
  const restore = useMutation({ mutationFn: (bid: string) => api.restoreBackup(id, bid) });
  const delBackup = useMutation({ mutationFn: (bid: string) => api.deleteBackup(id, bid), onSuccess: invalidateBackups });

  const [schedEnabled, setSchedEnabled] = useState(false);
  const [interval, setIntervalH] = useState("24");
  const [retention, setRetention] = useState("7");
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

  if (isLoading || !db) return <div style={{ padding: 28 }}><Spinner /></div>;

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: dbColor(db.status) }} />
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{db.name}</h1>
        <span style={{ fontSize: 12, color: dbColor(db.status), fontWeight: 600 }}>{db.status}</span>
      </div>
      <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: "0 0 18px" }}>
        {engineLabel(db.engine)} · {db.version} · :{db.port}{db.hostPort ? ` → host :${db.hostPort}` : ""}
      </p>

      {db.canWrite && (
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <Btn onClick={() => provision.mutate()} disabled={provision.isPending}>
            {provision.isPending ? t("databases.provisioning") : t("databases.provision")}
          </Btn>
          <Btn variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{t("databases.stop")}</Btn>
          <div style={{ flex: 1 }} />
          <Btn variant="danger" onClick={() => del.mutate()}>Delete</Btn>
        </div>
      )}

      {db.canWrite && db.connectionUri && (
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
      )}

      {db.canWrite && !db.backupSupported && (
        <Card style={{ padding: 16, marginTop: 16, color: "var(--c-tx3)", fontSize: 13 }}>
          {t("databases.backupUnsupported")}
        </Card>
      )}

      {db.canWrite && db.backupSupported && (
        <Card style={{ padding: 16, marginTop: 16 }}>
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
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: backupColor(b.status) }}>{b.status}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{b.filename}</span>
                <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{formatSize(b.sizeBytes)}</span>
                <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(b.createdAt).toLocaleString()}</span>
                <button
                  onClick={() => { if (confirm(t("databases.restoreConfirm"))) restore.mutate(b.id); }}
                  style={linkBtn}
                >
                  {t("databases.restore")}
                </button>
                <button onClick={() => delBackup.mutate(b.id)} style={{ ...linkBtn, color: "var(--c-r)" }}>✕</button>
              </div>
            ))}
            {backups.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("databases.noBackups")}</div>}
          </div>
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

function CopyRow({ label, value, copy, secret }: { label: string; value: string; copy: string; secret?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: "var(--c-tx3)", width: 110, flexShrink: 0 }}>{label}</span>
      <code
        className="mono"
        style={{
          flex: 1,
          fontSize: 12,
          background: "var(--c-el)",
          border: "1px solid var(--c-bd)",
          borderRadius: "var(--r1)",
          padding: "6px 10px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {secret ? "•".repeat(Math.min(value.length, 40)) : value}
      </code>
      <Btn variant="ghost" onClick={() => navigator.clipboard?.writeText(value)}>{copy}</Btn>
    </div>
  );
}
