"use client";

import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { dbColor, engineLabel } from "../../../../lib/databases";
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["database", id] });
  const provision = useMutation({ mutationFn: () => api.provisionDatabase(id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stopDatabase(id), onSuccess: invalidate });
  const del = useMutation({
    mutationFn: () => api.deleteDatabase(id),
    onSuccess: () => router.replace("/databases"),
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
    </div>
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
