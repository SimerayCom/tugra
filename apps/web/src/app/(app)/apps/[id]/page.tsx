"use client";

import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { appColor, appSourceSummary, deploymentColor } from "../../../../lib/apps";
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

      <Card style={{ padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("apps.deployments")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {deployments.map((d) => (
            <div key={d.id} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
                {d.exitCode != null && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.exit", { code: d.exitCode })}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(d.createdAt).toLocaleString()}</span>
              </div>
              {d.logs && (
                <pre className="mono" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>{d.logs}</pre>
              )}
            </div>
          ))}
          {deployments.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.noDeployments")}</div>}
        </div>
      </Card>
    </div>
  );
}
