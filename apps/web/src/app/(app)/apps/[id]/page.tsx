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
import { RenameModal } from "../../../../components/rename-modal";
import { ExposeModal } from "../../../../components/expose-modal";
import { Modal } from "../../../../components/modal";
import { resourceBreadcrumb } from "../../../../lib/breadcrumb";
import { useTabState } from "../../../../hooks/useTabState";
import { CopyRow } from "../../../../components/copy-row";
import { IconBtn } from "../../../../components/icon-btn";
import { useConfirm } from "../../../../components/confirm";
import type { TerminalTarget } from "../../../../lib/ws";
import { parseDotenv, toDotenv } from "../../../../lib/dotenv";
import { cleanDomain } from "../../../../lib/domain";
import { EnvironmentCard } from "../../../../components/environment-card";
import { TagsCard } from "../../../../components/tags";
import { useT } from "../../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { AppLogo } from "../../../../components/app-logo";
import { ErrorState } from "../../../../components/error-state";
import { Tabs } from "../../../../components/tabs-nav";

export default function AppDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();

  const { data: appData, isLoading, isError, refetch } = useQuery({
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
  const start = useMutation({ mutationFn: () => api.startApp(id), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => api.restartApp(id), onSuccess: invalidate });
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
  const [shell, setShell] = useState<TerminalTarget | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exposeOpen, setExposeOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) => api.renameApp(id, name),
    onSuccess: () => { setRenameOpen(false); qc.invalidateQueries({ queryKey: ["app", id] }); },
  });
  const tabDefs = [
    { key: "overview", label: t("apps.tabOverview") },
    ...(appData?.canWrite ? [{ key: "configuration", label: t("apps.tabConfiguration") }] : []),
    { key: "deployments", label: t("apps.tabDeployments"), badge: deployments.length },
    { key: "logs", label: t("apps.tabLogs") },
  ];
  const [tab, setTab] = useTabState("overview", tabDefs.map((d) => d.key));

  if (isError && !appData) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !appData) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  const onDeploy = (opts?: { noCache?: boolean }) => { deploy.mutate(opts); setTab("logs"); };

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={resourceBreadcrumb({ projectId: appData.projectId, projectName: appData.projectName, environmentName: appData.environmentName, name: appData.name, projectsLabel: t("nav.projects"), fallbackLabel: t("nav.apps"), fallbackHref: "/apps" })}
        title={appData.name}
        icon={<AppLogo templateSlug={appData.templateSlug} templateLogo={appData.templateLogo} source={appData.source} name={appData.name} size={20} />}
        status={{ label: appData.status, color: appColor(appData.status) }}
        badge={appData.isPreview ? <Badge tone="lapis">{t("apps.previewBadge", { n: appData.prNumber ?? "?" })}</Badge> : undefined}
        actions={
          appData.canWrite ? (
            <>
              <Btn onClick={() => onDeploy()} disabled={deploy.isPending}>
                {deploy.isPending ? t("apps.deploying") : t("apps.deploy")}
              </Btn>
              <Btn variant="ghost" onClick={() => onDeploy({ noCache: true })} disabled={deploy.isPending} title={t("apps.forceDeployHint")}>{t("apps.forceDeploy")}</Btn>
              <Btn variant="ghost" onClick={() => restart.mutate()} disabled={restart.isPending}>{restart.isPending ? t("apps.restarting") : t("apps.restart")}</Btn>
              {appData.status === "STOPPED" && (
                <Btn variant="ghost" onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? t("apps.starting") : t("apps.start")}</Btn>
              )}
              <Btn variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{t("apps.stop")}</Btn>
              <Btn variant="ghost" onClick={() => (appData.source === "COMPOSE" ? setPickerOpen(true) : setShell({ app: id }))}>{t("apps.openShell")}</Btn>
              <Btn variant="ghost" onClick={() => setRenameOpen(true)}>{t("apps.rename")}</Btn>
              <Btn variant="danger" onClick={async () => { if (await confirm({ title: t("apps.delete"), body: t("apps.deleteConfirm"), danger: true })) del.mutate(); }}>{t("apps.delete")}</Btn>
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

      {renameOpen && (
        <RenameModal
          current={appData.name}
          title={t("apps.rename")}
          pending={rename.isPending}
          onClose={() => setRenameOpen(false)}
          onSave={(name) => rename.mutate(name)}
        />
      )}
      {pickerOpen && (
        <ContainerPickerModal
          id={id}
          onClose={() => setPickerOpen(false)}
          onPick={(name) => { setPickerOpen(false); setShell({ app: id, container: name }); }}
        />
      )}
      {shell && (
        <TerminalModal
          target={shell}
          title={t("terminal.containerTitle", { name: appData.name })}
          onClose={() => setShell(null)}
        />
      )}

      <Tabs active={tab} onChange={setTab} tabs={tabDefs} />

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
                <Btn variant="ghost" disabled={regen.isPending} onClick={async () => { if (await confirm({ body: t("apps.regenerateConfirm"), danger: true })) regen.mutate(); }}>
                  {t("apps.regenerate")}
                </Btn>
              </div>
            </Card>
          )}

          {appData.source !== "COMPOSE" && (
            <LimitsCard id={id} memoryMb={appData.memoryMb} cpus={appData.cpus} deployTimeoutSec={appData.deployTimeoutSec} />
          )}
          {appData.source !== "COMPOSE" && (
            <HealthCheckCard
              id={id}
              healthCheckType={appData.healthCheckType}
              healthCheckPath={appData.healthCheckPath}
              healthCheckPort={appData.healthCheckPort}
              healthCmd={appData.healthCmd}
            />
          )}
          {appData.source !== "COMPOSE" && (
            <BuildConfigCard id={id} teamId={appData.teamId} registryId={appData.registryId} pushToRegistry={appData.pushToRegistry} buildServerId={appData.buildServerId} />
          )}
          {appData.source !== "COMPOSE" && (
            <DockerOptionsCard id={id} dockerOptions={appData.dockerOptions} />
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
          {appData.canWrite && !appData.isPreview && (
            <Card style={{ padding: 16, marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.exposeTitle")}</div>
                <div style={{ fontSize: 13, color: "var(--c-tx)", marginTop: 2 }}>
                  {t(`apps.exposeMode_${appData.exposeMode === "magic" || appData.exposeMode === "port" || appData.exposeMode === "custom" || appData.exposeMode === "none" ? appData.exposeMode : "none"}`)}
                  {appData.url ? ` · ${appData.url}` : ""}
                </div>
              </div>
              <Btn variant="ghost" onClick={() => setExposeOpen(true)}>{t("apps.exposeChange")}</Btn>
            </Card>
          )}
          {exposeOpen && (
            <ExposeModal appId={id} current={appData.exposeMode} currentDomain={appData.domain} onClose={() => setExposeOpen(false)} />
          )}
          {appData.canWrite && !appData.isPreview && appData.domainKind === "custom" && (
            <DomainCard id={id} domain={appData.domain} https={appData.https} />
          )}
          {appData.domain && (
            <DomainOptionsCard
              id={id}
              domain={appData.domain}
              https={appData.https}
              domainRedirect={appData.domainRedirect}
              securityHeaders={appData.securityHeaders}
              forwardAuth={appData.forwardAuth}
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
              // Rollbackable if the local tag is retained OR a portable registry image exists.
              const canRollback = appData.canWrite && (!!d.imageTag || !!d.registryImage) && d.id !== latestSuccessId;
              return (
                <div key={d.id} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
                    {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
                    {d.registryImage && <span title={d.registryImage} style={{ fontSize: 10, color: "var(--c-tx3)" }}>☁</span>}
                    {d.exitCode != null && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.exit", { code: d.exitCode })}</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(d.createdAt).toLocaleString()}</span>
                    {canRollback && (
                      <button
                        onClick={async () => { if (await confirm({ body: t("apps.rollbackConfirm"), danger: true })) rollback.mutate(d.id); }}
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
        <>
          {appData.canWrite && <ContainerLogsCard id={id} />}
          {deployActive && live.lines ? (
            <LiveLogCard lines={live.lines} />
          ) : deployments[0]?.logs ? (
            <Card style={{ padding: 16 }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("apps.lastDeployLog")}</div>
              <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto" }}>{deployments[0].logs}</pre>
            </Card>
          ) : (
            !appData.canWrite && <Card style={{ padding: 16 }}><EmptyState>{t("apps.noLogs")}</EmptyState></Card>
          )}
        </>
      )}
    </div>
  );
}

function ContainerPickerModal({ id, onClose, onPick }: { id: string; onClose: () => void; onPick: (name: string) => void }) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({ queryKey: ["appContainers", id], queryFn: () => api.listAppContainers(id) });
  const containers = data?.containers ?? [];
  return (
    <Modal onClose={onClose} width={480}>
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

function ContainerLogsCard({ id }: { id: string }) {
  const t = useT();
  const logs = useQuery({ queryKey: ["appLogs", id], queryFn: () => api.getAppLogs(id, 200) });
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("apps.containerLogs")}</div>
        <Btn variant="ghost" onClick={() => logs.refetch()} disabled={logs.isFetching}>
          {logs.isFetching ? "…" : t("apps.refresh")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 10px" }}>{t("apps.containerLogsDesc")}</p>
      {logs.isError ? (
        <div style={{ fontSize: 12, color: "var(--c-r)" }}>{(logs.error as Error).message}</div>
      ) : logs.data?.output ? (
        <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto", background: "var(--c-el)", padding: 10, borderRadius: "var(--r1)" }}>{logs.data.output}</pre>
      ) : (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.logsEmpty")}</div>
      )}
    </Card>
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
  const [query, setQuery] = useState("");
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
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
  const openBulk = () => { setBulkText(toDotenv(rows)); setBulk(true); };
  const applyBulk = () => { setRows(parseDotenv(bulkText)); setBulk(false); };

  const q = query.trim().toLowerCase();
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.key.toLowerCase().includes(q));

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("apps.env")}</div>
        <button onClick={() => (bulk ? setBulk(false) : openBulk())} style={{ ...envField, cursor: "pointer", border: "none", background: "transparent", color: "var(--c-tx3)" }}>
          {bulk ? t("apps.rowEdit") : t("apps.bulkEdit")}
        </button>
        {!bulk && (
          <button onClick={() => setReveal((v) => !v)} style={{ ...envField, cursor: "pointer", border: "none", background: "transparent", color: "var(--c-tx3)" }}>
            {reveal ? t("apps.hideValues") : t("apps.showValues")}
          </button>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.envDesc")}</p>
      {bulk ? (
        <>
          <textarea
            className="mono"
            style={{ ...envField, width: "100%", minHeight: 180, resize: "vertical" }}
            placeholder={t("apps.bulkPlaceholder")}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <div style={{ flex: 1 }} />
            <Btn onClick={applyBulk}>{t("apps.bulkApply")}</Btn>
          </div>
        </>
      ) : (
        <>
          {rows.length > 3 && (
            <input style={{ ...envField, width: "100%", marginBottom: 8 }} placeholder={t("apps.searchKeys")} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visible.map(({ r, i }) => (
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
        </>
      )}
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

function LimitsCard({ id, memoryMb, cpus, deployTimeoutSec }: { id: string; memoryMb: number | null; cpus: number | null; deployTimeoutSec: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [mem, setMem] = useState(memoryMb != null ? String(memoryMb) : "");
  const [cpu, setCpu] = useState(cpus != null ? String(cpus) : "");
  const [timeout, setTimeoutS] = useState(deployTimeoutSec != null ? String(deployTimeoutSec) : "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppLimits(id, {
        memoryMb: mem ? Number(mem) : null,
        cpus: cpu ? Number(cpu) : null,
        deployTimeoutSec: timeout ? Number(timeout) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.limits")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.limitsDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...envField, width: 150 }} type="number" placeholder={t("apps.memoryMb")} value={mem} onChange={(e) => setMem(e.target.value)} />
        <input style={{ ...envField, width: 130 }} type="number" step="0.1" placeholder={t("apps.cpus")} value={cpu} onChange={(e) => setCpu(e.target.value)} />
        <input style={{ ...envField, width: 170 }} type="number" placeholder={t("apps.deployTimeout")} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

function HealthCheckCard({
  id,
  healthCheckType,
  healthCheckPath,
  healthCheckPort,
  healthCmd,
}: {
  id: string;
  healthCheckType: string | null;
  healthCheckPath: string | null;
  healthCheckPort: number | null;
  healthCmd: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  // "" = auto (send null); otherwise the explicit type. A legacy app with a command but no
  // saved type shows as CMD so its command stays visible/editable instead of being hidden.
  const [type, setType] = useState(healthCheckType ?? (healthCmd ? "CMD" : ""));
  const [path, setPath] = useState(healthCheckPath ?? "");
  const [port, setPort] = useState(healthCheckPort != null ? String(healthCheckPort) : "");
  const [cmd, setCmd] = useState(healthCmd ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppHealthCheck(id, {
        type: type || null,
        path: type === "HTTP" ? path.trim() || null : null,
        port: type === "HTTP" && port ? Number(port) : null,
        command: type === "CMD" ? cmd.trim() || null : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.healthCheck")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.healthCheckDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 200 }} value={type} onChange={(e) => setType(e.target.value)} aria-label={t("apps.healthCheckType")}>
          {["", "NONE", "HTTP", "CMD"].map((v) => (
            <option key={v || "auto"} value={v}>
              {t(`apps.healthCheckType_${v || "auto"}`)}
            </option>
          ))}
        </select>
        {type === "HTTP" && (
          <>
            <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.healthCheckPath")} value={path} onChange={(e) => setPath(e.target.value)} />
            <input style={{ ...envField, width: 130 }} type="number" placeholder={t("apps.healthCheckPort")} value={port} onChange={(e) => setPort(e.target.value)} />
          </>
        )}
        {type === "CMD" && (
          <input style={{ ...envField, flex: "1 1 100%" }} placeholder={t("apps.healthCmd")} value={cmd} onChange={(e) => setCmd(e.target.value)} />
        )}
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

function BuildConfigCard({ id, teamId, registryId, pushToRegistry, buildServerId }: { id: string; teamId: string; registryId: string | null; pushToRegistry: boolean; buildServerId: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: registries = [] } = useQuery({ queryKey: ["registries"], queryFn: () => api.listRegistries() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const teamRegistries = registries.filter((r) => r.teamId === teamId);
  const buildServers = servers.filter((s) => s.teamId === teamId && s.status === "ONLINE");
  const [reg, setReg] = useState(registryId ?? "");
  const [push, setPush] = useState(pushToRegistry);
  const [buildServer, setBuildServer] = useState(buildServerId ?? "");
  // A build server needs a registry (the deploy server pulls the image); push is then implied.
  const effectivePush = (push && !!reg) || (!!buildServer && !!reg);
  const save = useMutation({
    mutationFn: () => api.setAppBuildConfig(id, { registryId: reg || null, pushToRegistry: effectivePush, buildServerId: (buildServer && reg) ? buildServer : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.buildConfig")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.buildConfigDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 240 }} value={reg} onChange={(e) => setReg(e.target.value)} aria-label={t("apps.buildRegistry")}>
          <option value="">{t("apps.buildRegistryNone")}</option>
          {teamRegistries.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: reg ? "var(--c-tx)" : "var(--c-tx3)" }}>
          <input type="checkbox" checked={effectivePush} disabled={!reg || !!buildServer} onChange={(e) => setPush(e.target.checked)} />
          {t("apps.pushToRegistry")}
        </label>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <select style={{ ...envField, width: 240 }} value={reg ? buildServer : ""} onChange={(e) => setBuildServer(e.target.value)} disabled={!reg} aria-label={t("apps.buildServer")}>
          <option value="">{t("apps.buildServerNone")}</option>
          {buildServers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.buildServerHint")}</span>
      </div>
      {teamRegistries.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.buildNoRegistries")}</div>}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

function DockerOptionsCard({ id, dockerOptions }: { id: string; dockerOptions: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [val, setVal] = useState(dockerOptions ?? "");
  const save = useMutation({
    mutationFn: () => api.setAppDockerOptions(id, val.trim() || null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
  });
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.dockerOptions")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.dockerOptionsDesc")}</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          style={{ ...envField, flex: 1 }}
          placeholder="--cap-add=NET_ADMIN --sysctl net.core.somaxconn=1024"
          value={val}
          onChange={(e) => setVal(e.target.value)}
        />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.dockerOptionsRedeploy")}</div>}
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
  const confirm = useConfirm();
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
            <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(tk.id); }}>×</IconBtn>
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
  const confirm = useConfirm();
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
                  <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(p.id); }}>×</IconBtn>
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

function DomainCard({ id, domain, https }: { id: string; domain: string | null; https: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [value, setValue] = useState(domain ?? "");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["app", id] });
  const save = useMutation({
    mutationFn: () => api.setAppDomain(id, cleanDomain(value) || null),
    onSuccess: invalidate,
  });
  const clear = useMutation({
    mutationFn: () => api.setAppDomain(id, null),
    onSuccess: () => { setValue(""); invalidate(); },
  });
  const pending = save.isPending || clear.isPending;

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.setDomain")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.domainRedeployNote")}</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          style={{ ...envField, minWidth: 240, flex: 1 }}
          value={value}
          placeholder={t("apps.domainPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
        />
        <Btn onClick={() => save.mutate()} disabled={pending || !cleanDomain(value)}>{t("apps.domainSave")}</Btn>
        {domain && <Btn variant="ghost" onClick={() => clear.mutate()} disabled={pending}>{t("apps.domainClear")}</Btn>}
      </div>
      {https && cleanDomain(value) && (
        <div className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10 }}>https://{cleanDomain(value)}</div>
      )}
    </Card>
  );
}

function DomainOptionsCard({
  id,
  domain,
  https,
  domainRedirect,
  securityHeaders,
  forwardAuth,
}: {
  id: string;
  domain: string;
  https: boolean;
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
  forwardAuth: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [redirect, setRedirect] = useState<string>(domainRedirect ?? "");
  const [sec, setSec] = useState(securityHeaders);
  const [fa, setFa] = useState(forwardAuth ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppDomainOptions(id, {
        domainRedirect: redirect ? (redirect as "www" | "root") : null,
        securityHeaders: sec,
        forwardAuth: fa.trim() || null,
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
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.forwardAuth")}</div>
        <input
          style={{ ...envField, width: "100%" }}
          placeholder="https://auth.example.com/api/verify?rd=https://auth.example.com"
          value={fa}
          onChange={(e) => setFa(e.target.value)}
        />
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t("apps.forwardAuthDesc")}</p>
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
            <button onClick={async () => { if (await confirm({ body: t("databases.restoreConfirm"), danger: true })) restore.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              {t("databases.restore")}
            </button>
            <button onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-r)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
          </div>
        ))}
        {backups.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.noVolBackups")}</div>}
      </div>
      {restore.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(restore.error as Error).message}</div>}
    </Card>
  );
}
