"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { AppVolume } from "../../../../lib/types";
import { appColor, appSourceSummary, deploymentColor, webhookUrl } from "../../../../lib/apps";
import { backupColor, formatSize } from "../../../../lib/backups";
import { useDeployLogStream } from "../../../../hooks/useDeployLogStream";
import { TerminalModal } from "../../../../components/terminal-modal";
import { EnvironmentCard } from "../../../../components/environment-card";
import { TagsCard } from "../../../../components/tags";
import { useT } from "../../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { Tabs } from "../../../../components/tabs-nav";

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
  const deploy = useMutation({ mutationFn: (opts?: { noCache?: boolean }) => api.deployApp(id, opts), onSuccess: invalidate });
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
  const tags = useMutation({
    mutationFn: (next: string[]) => api.setAppTags(id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });
  const [aiResults, setAiResults] = useState<Record<string, string>>({});
  const analyze = useMutation({
    mutationFn: (deploymentId: string) => api.analyzeDeployment(id, deploymentId),
    onSuccess: (r, deploymentId) => setAiResults((m) => ({ ...m, [deploymentId]: r.analysis })),
    onError: (e, deploymentId) =>
      setAiResults((m) => ({ ...m, [deploymentId]: (e as Error).message || t("apps.aiFailed") })),
  });

  // Deployments come newest-first; a leading RUNNING one means a live deploy.
  const deployActive = deployments[0]?.status === "RUNNING";
  const live = useDeployLogStream(id, deployActive);
  const [shellOpen, setShellOpen] = useState(false);
  const [tab, setTab] = useState("overview");

  if (isLoading || !appData) return <div style={{ padding: 28 }}><Spinner /></div>;

  const onDeploy = (opts?: { noCache?: boolean }) => { deploy.mutate(opts); setTab("logs"); };

  return (
    <div style={{ padding: 28 }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.apps"), href: "/apps" }, { label: appData.name }]}
        title={appData.name}
        status={{ label: appData.status, color: appColor(appData.status) }}
        badge={appData.isPreview ? <Badge tone="lapis">{t("apps.previewBadge", { n: appData.prNumber ?? "?" })}</Badge> : undefined}
        actions={
          appData.canWrite ? (
            <>
              <Btn onClick={() => onDeploy()} disabled={deploy.isPending}>
                {deploy.isPending ? t("apps.deploying") : t("apps.deploy")}
              </Btn>
              <Btn variant="ghost" onClick={() => onDeploy({ noCache: true })} disabled={deploy.isPending} title={t("apps.forceDeployHint")}>{t("apps.forceDeploy")}</Btn>
              <Btn variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{t("apps.stop")}</Btn>
              {appData.source !== "COMPOSE" && (
                <Btn variant="ghost" onClick={() => setShellOpen(true)}>{t("apps.openShell")}</Btn>
              )}
              <Btn variant="danger" onClick={() => del.mutate()}>{t("apps.delete")}</Btn>
            </>
          ) : undefined
        }
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>
          {appSourceSummary(appData)}
          {appData.hostPort ? ` · :${appData.hostPort}→${appData.containerPort}` : ""}
        </p>
        {appData.url && (
          <p style={{ margin: "6px 0 0" }}>
            <a href={appData.url} target="_blank" rel="noreferrer" style={{ color: "var(--c-lapis)", fontSize: 13 }}>
              {appData.url} {t("apps.open")}
            </a>
          </p>
        )}
      </PageHeader>

      {shellOpen && (
        <TerminalModal
          target={{ app: id }}
          title={t("terminal.containerTitle", { name: appData.name })}
          onClose={() => setShellOpen(false)}
        />
      )}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "overview", label: t("apps.tabOverview") },
          ...(appData.canWrite ? [{ key: "configuration", label: t("apps.tabConfiguration") }] : []),
          { key: "deployments", label: t("apps.tabDeployments"), badge: deployments.length },
          { key: "logs", label: t("apps.tabLogs") },
        ]}
      />

      {tab === "overview" && (
        appData.source === "COMPOSE" && appData.composeFile ? (
          <Card style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("apps.compose")}</div>
            <pre className="mono" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto" }}>{appData.composeFile}</pre>
          </Card>
        ) : (
          <Card style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>
              {appData.canWrite ? t("apps.overviewHint") : t("apps.readOnlyHint")}
            </div>
          </Card>
        )
      )}

      {tab === "configuration" && appData.canWrite && (
        <>
          {appData.webhookToken && (
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
                <Btn variant="ghost" disabled={regen.isPending} onClick={() => { if (confirm(t("apps.regenerateConfirm"))) regen.mutate(); }}>
                  {t("apps.regenerate")}
                </Btn>
              </div>
            </Card>
          )}

          {appData.source !== "COMPOSE" && (
            <LimitsCard id={id} healthCmd={appData.healthCmd} memoryMb={appData.memoryMb} cpus={appData.cpus} />
          )}
          {appData.source !== "COMPOSE" && <VolumesCard id={id} volumes={appData.volumes} />}
          {appData.source !== "COMPOSE" && <ScheduledTasksCard id={id} />}
          {!appData.isPreview && (
            <TagsCard tags={appData.tags} canWrite={appData.canWrite} onSave={(next) => tags.mutate(next)} />
          )}
          {!appData.isPreview && appData.source === "GIT" && (
            <PreviewCard id={id} previewEnabled={appData.previewEnabled} domain={appData.domain} />
          )}
          <CredentialsCard
            id={id}
            source={appData.source}
            hasGitToken={appData.hasGitToken}
            registryUrl={appData.registryUrl}
            registryUser={appData.registryUser}
          />
          {appData.domain && (
            <DomainOptionsCard
              id={id}
              domain={appData.domain}
              https={appData.https}
              domainRedirect={appData.domainRedirect}
              securityHeaders={appData.securityHeaders}
            />
          )}
          {appData.source !== "COMPOSE" && appData.volumes.length > 0 && (
            <VolumeBackupsCard
              id={id}
              enabled={appData.volumeBackupEnabled}
              intervalHours={appData.volumeBackupIntervalHours}
              retention={appData.volumeBackupRetention}
              destinationId={appData.volumeBackupDestinationId}
            />
          )}
          <EnvironmentCard kind="app" id={id} environmentId={appData.environmentId} />
          <EnvCard id={id} />
          {appData.source === "GIT" && <BuildArgsCard id={id} />}
        </>
      )}

      {tab === "deployments" && (
        <Card style={{ padding: 16 }}>
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
                    {d.status === "FAILED" && appData.canWrite && (
                      <button
                        onClick={() => analyze.mutate(d.id)}
                        disabled={analyze.isPending}
                        style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-a)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
                      >
                        {analyze.isPending && analyze.variables === d.id ? t("apps.analyzing") : t("apps.analyzeAi")}
                      </button>
                    )}
                  </div>
                  {aiResults[d.id] && (
                    <div style={{ marginTop: 6, padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-a)", marginBottom: 4 }}>{t("apps.aiAnalysis")}</div>
                      <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap" }}>{aiResults[d.id]}</pre>
                    </div>
                  )}
                  {d.configChanges && d.configChanges.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ fontSize: 11, color: "var(--c-tx3)", cursor: "pointer" }}>
                        {t("apps.configChanges", { count: d.configChanges.length })}
                      </summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, margin: "4px 0 0", paddingLeft: 4 }}>
                        {d.configChanges.map((c) => (
                          <div key={c.field} className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                            <span style={{ color: c.kind === "added" ? "var(--c-g)" : c.kind === "removed" ? "var(--c-r)" : "var(--c-a)" }}>{t(`apps.cfg_${c.kind}`)}</span>{" "}
                            <span style={{ color: "var(--c-tx2)" }}>{c.field}</span>
                            {c.kind === "changed" && <span>: {c.before} → {c.after}</span>}
                            {c.kind === "added" && c.after != null && <span>: {c.after}</span>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {d.logs && (
                    <pre className="mono" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--c-tx3)", whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>{d.logs}</pre>
                  )}
                </div>
              );
            })}
            {deployments.length === 0 && <EmptyState>{t("apps.noDeployments")}</EmptyState>}
          </div>
        </Card>
      )}

      {tab === "logs" && (
        deployActive && live.lines ? (
          <LiveLogCard lines={live.lines} />
        ) : deployments[0]?.logs ? (
          <Card style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("apps.lastDeployLog")}</div>
            <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto" }}>{deployments[0].logs}</pre>
          </Card>
        ) : (
          <Card style={{ padding: 16 }}><EmptyState>{t("apps.noLogs")}</EmptyState></Card>
        )
      )}
    </div>
  );
}

function LiveLogCard({ lines }: { lines: string }) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Spinner />
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.streaming")}</span>
      </div>
      <pre
        ref={ref}
        className="mono"
        style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" }}
      >
        {lines}
      </pre>
    </Card>
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

function BuildArgsCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: args } = useQuery({ queryKey: ["appBuildArgs", id], queryFn: () => api.getAppBuildArgs(id) });
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  useEffect(() => {
    if (args) setRows(Object.entries(args).map(([key, value]) => ({ key, value })));
  }, [args]);

  const save = useMutation({
    mutationFn: () => {
      const map: Record<string, string> = {};
      for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
      return api.setAppBuildArgs(id, map);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appBuildArgs", id] });
      qc.invalidateQueries({ queryKey: ["app", id] });
    },
  });
  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.buildArgs")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.buildArgsDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input style={{ ...envField, width: 200 }} placeholder="KEY" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} />
            <input style={{ ...envField, flex: 1 }} placeholder="value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
            <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)" }}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>{t("apps.buildArgsAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.buildArgsRedeploy")}</div>}
    </Card>
  );
}

function LimitsCard({ id, healthCmd, memoryMb, cpus }: { id: string; healthCmd: string | null; memoryMb: number | null; cpus: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [hc, setHc] = useState(healthCmd ?? "");
  const [mem, setMem] = useState(memoryMb != null ? String(memoryMb) : "");
  const [cpu, setCpu] = useState(cpus != null ? String(cpus) : "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppLimits(id, {
        healthCmd: hc.trim() || null,
        memoryMb: mem ? Number(mem) : null,
        cpus: cpu ? Number(cpu) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.limits")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.limitsDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...envField, flex: "1 1 100%" }} placeholder={t("apps.healthCmd")} value={hc} onChange={(e) => setHc(e.target.value)} />
        <input style={{ ...envField, width: 150 }} type="number" placeholder={t("apps.memoryMb")} value={mem} onChange={(e) => setMem(e.target.value)} />
        <input style={{ ...envField, width: 130 }} type="number" step="0.1" placeholder={t("apps.cpus")} value={cpu} onChange={(e) => setCpu(e.target.value)} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

function VolumesCard({ id, volumes }: { id: string; volumes: AppVolume[] }) {
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
  });
  const setRow = (i: number, patch: Partial<AppVolume>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.volumes")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.volumesDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...envField, width: 160 }} placeholder={t("apps.volumeName")} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
            <input style={{ ...envField, flex: 1 }} placeholder={t("apps.volumePath")} value={r.path} onChange={(e) => setRow(i, { path: e.target.value })} />
            <button
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", padding: "4px 9px", fontFamily: "inherit" }}
            >
              ×
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
    </Card>
  );
}

function ScheduledTasksCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery({ queryKey: ["appTasks", id], queryFn: () => api.listAppTasks(id) });
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [command, setCommand] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["appTasks", id] });
  const add = useMutation({
    mutationFn: () => api.createAppTask(id, { name, schedule, command }),
    onSuccess: () => { setName(""); setSchedule(""); setCommand(""); invalidate(); },
  });
  const toggle = useMutation({
    mutationFn: ({ taskId, enabled }: { taskId: string; enabled: boolean }) => api.updateAppTask(id, taskId, { enabled }),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (taskId: string) => api.deleteAppTask(id, taskId), onSuccess: invalidate });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.tasks")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.tasksDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {tasks.map((tk) => (
          <div key={tk.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={tk.enabled} onChange={(e) => toggle.mutate({ taskId: tk.id, enabled: e.target.checked })} />
            <span style={{ fontSize: 13, width: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{tk.name}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", width: 110 }}>{tk.schedule}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{tk.command}</span>
            {tk.lastRunAt && <span style={{ fontSize: 10, color: "var(--c-tx3)" }}>{t("apps.taskLastRun")}: {new Date(tk.lastRunAt).toLocaleString()}</span>}
            <button onClick={() => del.mutate(tk.id)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", padding: "4px 9px", fontFamily: "inherit" }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...envField, width: 140 }} placeholder={t("apps.taskName")} value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...envField, width: 130 }} placeholder={t("apps.taskSchedule")} value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        <input style={{ ...envField, flex: 1, minWidth: 160 }} placeholder={t("apps.taskCommand")} value={command} onChange={(e) => setCommand(e.target.value)} />
        <Btn onClick={() => add.mutate()} disabled={add.isPending || !name || !schedule || !command}>{t("apps.addTask")}</Btn>
      </div>
      {add.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(add.error as Error).message}</div>}
    </Card>
  );
}

function PreviewCard({ id, previewEnabled, domain }: { id: string; previewEnabled: boolean; domain: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: previews = [] } = useQuery({
    queryKey: ["appPreviews", id],
    queryFn: () => api.getAppPreviews(id),
    enabled: previewEnabled,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["appPreviews", id] });
    qc.invalidateQueries({ queryKey: ["app", id] });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setPreviewEnabled(id, enabled),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: (previewId: string) => api.deletePreview(id, previewId),
    onSuccess: invalidate,
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.preview")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.previewDesc")}</p>
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
                  <button onClick={() => del.mutate(p.id)} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", padding: "4px 9px", fontFamily: "inherit" }}>×</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {toggle.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(toggle.error as Error).message}</div>}
    </Card>
  );
}

function DomainOptionsCard({
  id,
  domain,
  https,
  domainRedirect,
  securityHeaders,
}: {
  id: string;
  domain: string;
  https: boolean;
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [redirect, setRedirect] = useState<string>(domainRedirect ?? "");
  const [sec, setSec] = useState(securityHeaders);
  const save = useMutation({
    mutationFn: () =>
      api.setAppDomainOptions(id, {
        domainRedirect: redirect ? (redirect as "www" | "root") : null,
        securityHeaders: sec,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.domainOptions")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.domainOptionsDesc")}</p>
      <div className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 10 }}>
        {https ? "https://" : "http://"}{domain}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, minWidth: 200 }} value={redirect} onChange={(e) => setRedirect(e.target.value)}>
          <option value="">{t("apps.redirectNone")}</option>
          <option value="root">{t("apps.redirectRoot")}</option>
          <option value="www">{t("apps.redirectWww")}</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={sec} onChange={(e) => setSec(e.target.checked)} />
          {t("apps.securityHeaders")}
        </label>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

function CredentialsCard({
  id,
  source,
  hasGitToken,
  registryUrl,
  registryUser,
}: {
  id: string;
  source: string;
  hasGitToken: boolean;
  registryUrl: string | null;
  registryUser: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const isGit = source === "GIT";
  const [gitToken, setGitToken] = useState("");
  const [url, setUrl] = useState(registryUrl ?? "");
  const [user, setUser] = useState(registryUser ?? "");
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.setAppCredentials(
        id,
        isGit
          ? { gitToken: gitToken.trim() || null }
          : { registry: user.trim() && token.trim() ? { url: url.trim() || undefined, user: user.trim(), token } : null },
      ),
    onSuccess: () => {
      setGitToken("");
      setToken("");
      qc.invalidateQueries({ queryKey: ["app", id] });
    },
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.credentials")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.credentialsDesc")}</p>
      {isGit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            style={{ ...envField, flex: 1, minWidth: 200 }}
            type="password"
            placeholder={hasGitToken ? "•••••••• (set — replace)" : t("apps.gitToken")}
            value={gitToken}
            onChange={(e) => setGitToken(e.target.value)}
          />
          <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...envField, width: 200 }} placeholder={t("apps.registryUrl")} value={url} onChange={(e) => setUrl(e.target.value)} />
          <input style={{ ...envField, width: 150 }} placeholder={t("apps.registryUser")} value={user} onChange={(e) => setUser(e.target.value)} />
          <input style={{ ...envField, flex: 1, minWidth: 160 }} type="password" placeholder={t("apps.registryToken")} value={token} onChange={(e) => setToken(e.target.value)} />
          <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
        </div>
      )}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

const volField: React.CSSProperties = {
  width: 64,
  padding: "5px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "inherit",
};

function VolumeBackupsCard({ id, enabled, intervalHours, retention, destinationId }: { id: string; enabled: boolean; intervalHours: number | null; retention: number; destinationId: string | null }) {
  const t = useT();
  const qc = useQueryClient();
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
  const save = useMutation({
    mutationFn: () => api.setVolumeBackupConfig(id, { enabled: sched, intervalHours: Number(interval) || 24, retention: Number(ret) || 7, destinationId: dest || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("apps.volBackups")}</div>
        <Btn onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
          {backupNow.isPending ? t("databases.backingUp") : t("databases.backupNow")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.volBackupsDesc")}</p>

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
          <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: backupColor(b.status) }}>{b.status}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--c-tx2)", width: 90 }}>{b.volumeName}</span>
            <span style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{formatSize(b.sizeBytes)}</span>
            <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(b.createdAt).toLocaleString()}</span>
            <button onClick={() => { if (confirm(t("databases.restoreConfirm"))) restore.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              {t("databases.restore")}
            </button>
            <button onClick={() => del.mutate(b.id)} style={{ background: "transparent", border: "none", color: "var(--c-r)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
          </div>
        ))}
        {backups.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.noVolBackups")}</div>}
      </div>
      {restore.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(restore.error as Error).message}</div>}
    </Card>
  );
}
