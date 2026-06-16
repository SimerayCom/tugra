"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { appColor, appSourceSummary, deploymentColor, webhookUrl } from "../../../../lib/apps";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../../components/ui";

export default function AppDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: appData, isLoading } = useQuery({
    queryKey: ["app", id],
    queryFn: () => api.getApp(id),
    refetchInterval: 5000,
  });
  const { data: deployments = [] } = useQuery({
    queryKey: ["deployments", id],
    queryFn: () => api.getDeployments(id),
    refetchInterval: 5000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["app", id] });
    qc.invalidateQueries({ queryKey: ["deployments", id] });
  };
  const deploy = useMutation({ mutationFn: () => api.deployApp(id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stopApp(id), onSuccess: invalidate });
  const del = useMutation({
    mutationFn: () => api.deleteApp(id),
    onSuccess: () => router.replace("/apps"),
  });
  const regen = useMutation({
    mutationFn: () => api.regenerateWebhook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });
  const rollback = useMutation({
    mutationFn: (deploymentId: string) => api.rollbackApp(id, deploymentId),
    onSuccess: invalidate,
  });

  if (isLoading || !appData) return <div style={{ padding: 28 }}><Spinner /></div>;

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: appColor(appData.status) }} />
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{appData.name}</h1>
        <span style={{ fontSize: 12, color: appColor(appData.status), fontWeight: 600 }}>{appData.status}</span>
      </div>
      <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: "0 0 6px" }}>
        {appSourceSummary(appData)}
        {appData.hostPort ? ` · :${appData.hostPort}→${appData.containerPort}` : ""}
      </p>
      {appData.url && (
        <p style={{ margin: "0 0 18px" }}>
          <a href={appData.url} target="_blank" rel="noreferrer" style={{ color: "var(--c-lapis)", fontSize: 13 }}>
            {appData.url} {t("apps.open")}
          </a>
        </p>
      )}

      {appData.canWrite && (
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <Btn onClick={() => deploy.mutate()} disabled={deploy.isPending}>
            {deploy.isPending ? t("apps.deploying") : t("apps.deploy")}
          </Btn>
          <Btn variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{t("apps.stop")}</Btn>
          <div style={{ flex: 1 }} />
          <Btn variant="danger" onClick={() => del.mutate()}>Delete</Btn>
        </div>
      )}

      {appData.canWrite && appData.webhookToken && (
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.webhooks")}</div>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>
            {t("apps.webhookDesc", { branch: appData.gitBranch ?? "main" })}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <CopyRow label={t("apps.webhookUrl")} value={webhookUrl(appData.webhookToken)} copy={t("apps.copy")} />
            {appData.webhookSecret && (
              <CopyRow label={t("apps.webhookSecret")} value={appData.webhookSecret} copy={t("apps.copy")} secret />
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <Btn
              variant="ghost"
              disabled={regen.isPending}
              onClick={() => {
                if (confirm(t("apps.regenerateConfirm"))) regen.mutate();
              }}
            >
              {t("apps.regenerate")}
            </Btn>
          </div>
        </Card>
      )}

      {appData.source === "COMPOSE" && appData.composeFile && (
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("apps.compose")}</div>
          <pre className="mono" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" }}>{appData.composeFile}</pre>
        </Card>
      )}

      {appData.canWrite && <EnvCard id={id} />}

      <Card style={{ padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("apps.deployments")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {deployments.map((d) => {
            const latestSuccessId = deployments.find((x) => x.status === "SUCCESS")?.id;
            const canRollback = appData.canWrite && !!d.imageTag && d.id !== latestSuccessId;
            return (
            <div key={d.id} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
                {d.exitCode != null && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.exit", { code: d.exitCode })}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(d.createdAt).toLocaleString()}</span>
                {canRollback && (
                  <button
                    onClick={() => { if (confirm(t("apps.rollbackConfirm"))) rollback.mutate(d.id); }}
                    disabled={rollback.isPending}
                    style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-lapis)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
                  >
                    {t("apps.rollback")}
                  </button>
                )}
              </div>
              {d.logs && (
                <pre className="mono" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>{d.logs}</pre>
              )}
            </div>
            );
          })}
          {deployments.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.noDeployments")}</div>}
        </div>
      </Card>
    </div>
  );
}

function CopyRow({ label, value, copy, secret }: { label: string; value: string; copy: string; secret?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: "var(--c-tx3)", width: 80, flexShrink: 0 }}>{label}</span>
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
        {secret ? "•".repeat(Math.min(value.length, 32)) : value}
      </code>
      <Btn variant="ghost" onClick={() => navigator.clipboard?.writeText(value)}>{copy}</Btn>
    </div>
  );
}

const envField: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
};

function EnvCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: env } = useQuery({ queryKey: ["appEnv", id], queryFn: () => api.getAppEnv(id) });
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (env) setRows(Object.entries(env).map(([key, value]) => ({ key, value })));
  }, [env]);

  const save = useMutation({
    mutationFn: () => {
      const map: Record<string, string> = {};
      for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
      return api.setAppEnv(id, map);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appEnv", id] });
      qc.invalidateQueries({ queryKey: ["app", id] });
    },
  });

  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("apps.env")}</div>
        <button onClick={() => setReveal((v) => !v)} style={{ ...envField, cursor: "pointer", border: "none", background: "transparent", color: "var(--c-tx3)" }}>
          {reveal ? t("apps.hideValues") : t("apps.showValues")}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.envDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input style={{ ...envField, width: 200 }} placeholder="KEY" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} />
            <input style={{ ...envField, flex: 1 }} type={reveal ? "text" : "password"} placeholder="value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
            <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)" }}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>{t("apps.envAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}
