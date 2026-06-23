"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { dbColor, engineLabel } from "../../../../lib/databases";
import { backupColor, formatSize } from "../../../../lib/backups";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { Tabs } from "../../../../components/tabs-nav";
import { EnvironmentCard } from "../../../../components/environment-card";
import { TagsCard } from "../../../../components/tags";

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
  const tags = useMutation({ mutationFn: (next: string[]) => api.setDatabaseTags(id, next), onSuccess: invalidate });

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

  const [tab, setTab] = useState("overview");

  if (isLoading || !db) return <div style={{ padding: 28 }}><Spinner /></div>;

  return (
    <div style={{ padding: 28 }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.databases"), href: "/databases" }, { label: db.name }]}
        title={db.name}
        status={{ label: db.status, color: dbColor(db.status) }}
        actions={
          db.canWrite ? (
            <>
              <Btn onClick={() => provision.mutate()} disabled={provision.isPending}>
                {provision.isPending ? t("databases.provisioning") : t("databases.provision")}
              </Btn>
              <Btn variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{t("databases.stop")}</Btn>
              <Btn variant="danger" onClick={() => del.mutate()}>{t("databases.delete")}</Btn>
            </>
          ) : undefined
        }
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>
          {engineLabel(db.engine)} · {db.version} · :{db.port}{db.hostPort ? ` → host :${db.hostPort}` : ""}
        </p>
      </PageHeader>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "overview", label: t("databases.tabOverview") },
          { key: "backups", label: t("databases.tabBackups") },
          ...(db.canWrite ? [{ key: "settings", label: t("databases.tabSettings") }] : []),
        ]}
      />

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
