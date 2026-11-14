"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, appIconUrl } from "../../../../lib/api";
import { appColor, appSourceSummary, webhookUrl } from "../../../../lib/apps";
import { useDeployLogStream } from "../../../../hooks/useDeployLogStream";
import { type ChartEvent } from "../../../../components/charts";
import { ConfigMountsCard } from "../../../../components/config-mounts-card";
import { DatabaseLinksCard } from "../../../../components/database-links-card";
import { EnvCard } from "../../../../components/env-card";
import { AppSecretRefsCard } from "../../../../components/app-secret-refs-card";
import { TerminalModal } from "../../../../components/terminal-modal";
import { CloneAppModal } from "../../../../components/clone-app-modal";
import { RenameModal } from "../../../../components/rename-modal";
import { ExposeModal } from "../../../../components/expose-modal";
import { resourceBreadcrumb } from "../../../../lib/breadcrumb";
import { useTabState } from "../../../../hooks/useTabState";
import { useLeaveGuard } from "../../../../hooks/useUnsavedChanges";
import { CopyRow } from "../../../../components/copy-row";
import { Menu } from "../../../../components/menu";
import { useConfirm } from "../../../../components/confirm";
import type { TerminalTarget } from "../../../../lib/ws";
import { EnvironmentCard } from "../../../../components/environment-card";
import { ClusterDeployCard } from "../../../../components/cluster-deploy-card";
import { TagsCard } from "../../../../components/tags";
import { useT } from "../../../../i18n/provider";
import { useToast } from "../../../../components/toast";
import { Badge, Btn, Card, SectionCard, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { AppLogo } from "../../../../components/app-logo";
import { ErrorState } from "../../../../components/error-state";
import { ExtraPortsCard } from "../../../../components/extra-ports-card";
import { LimitsCard } from "../../../../components/limits-card";
import { HealthCheckCard } from "../../../../components/health-check-card";
import { DockerOptionsCard } from "../../../../components/docker-options-card";
import { DomainCard } from "../../../../components/domain-card";
import { Tabs } from "../../../../components/tabs-nav";
import { ConfigLayout } from "../../../../components/config-layout";
import { CONFIG_GROUP_KEYS, visibleConfigGroups, type ConfigCardId } from "../../../../lib/config-groups";
import { resolveTab } from "../../../../lib/tab-param";
import { LayoutDashboard, Settings2, Rocket, Activity, ScrollText, FolderOpen, Hammer, RotateCw, Play, Square, Terminal, CloudDownload, CloudUpload, Pencil, Trash2, Copy } from "lucide-react";
import { CONFIG_GROUP_ICONS, actionGroup, actionGroupSep } from "./app-detail-shared";
import { SourceCard, BuildSettingsCard, BuildArgsCard, BuildSecretsCard, DeploySettingsCard, BuildConfigCard, ContainerCommandCard, RestartPolicyCard, ContainerPortCard, DeployHooksCard, CredentialsCard, WatchPathsCard } from "./app-detail-build-cards";
import { ExtraDomainsCard, ServiceDomainsCard, DomainOptionsCard, CustomCertCard, RedirectsCard, BasicAuthCard, NetworkAliasesCard } from "./app-detail-domain-cards";
import { VolumesCard, HostMountsCard, VolumeBackupsCard } from "./app-detail-storage-cards";
import { ScheduledTasksCard, PreviewCard, AppDescriptionCard, ComposeEditorCard, GitComposeSourceCard, AppIconCard, AppOverview, ContainerPickerModal } from "./app-detail-misc-cards";
import { DeploymentsTab, MetricsTab, LogsTab, FilesTab } from "./app-detail-tabs";

export default function AppDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const pathname = usePathname();
  const confirm = useConfirm();
  const toast = useToast();

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
  // Deploy markers for the Metrics charts — "did this deploy cause the spike?". Only events that actually
  // changed the running container get a marker: a SUCCESS deploy, or a rollback. A failed/cancelled/queued
  // deploy never swapped the container, so it must not imply a code change at that moment. The timestamp is
  // the cutover (createdAt + build durationMs), not the queue time. Only in-range markers render.
  const deployEvents = useMemo<ChartEvent[]>(
    () =>
      deployments
        .filter((d) => d.status === "SUCCESS" || d.kind === "ROLLBACK" || d.kind === "AUTO_ROLLBACK")
        .map((d) => ({
          ts: new Date(d.createdAt).getTime() + (d.durationMs ?? 0),
          kind: d.kind === "AUTO_ROLLBACK" ? "error" : d.kind === "ROLLBACK" ? "restart" : "deploy",
          label: d.commitMessage ?? (d.commitSha ? d.commitSha.slice(0, 7) : undefined),
        })),
    [deployments],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["app", id] });
    qc.invalidateQueries({ queryKey: ["deployments", id] });
  };
  const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : t("apps.actionFailed"));
  // Optimistic deploy: true from the click until the deploy has been seen running and then finished
  // (or it failed to start / a safety timeout elapses), so the log stream attaches immediately.
  const [optimisticDeploy, setOptimisticDeploy] = useState(false);
  const deploy = useMutation({
    mutationFn: (opts?: { noCache?: boolean }) => api.deployApp(id, opts),
    onSuccess: invalidate,
    onError: (e) => { setOptimisticDeploy(false); toast(errMsg(e), "error"); },
  });
  const stop = useMutation({ mutationFn: () => api.stopApp(id), onSuccess: invalidate, onError: (e) => toast(errMsg(e), "error") });
  const start = useMutation({ mutationFn: () => api.startApp(id), onSuccess: invalidate, onError: (e) => toast(errMsg(e), "error") });
  const restart = useMutation({ mutationFn: () => api.restartApp(id), onSuccess: invalidate, onError: (e) => toast(errMsg(e), "error") });
  // Read at mutate() time (a stable ref, not a captured state value) so the keep-volumes choice the user
  // ticked in the confirm dialog isn't lost to a stale closure inside the async handler.
  const keepVolumes = useRef(false);
  const removeImages = useRef(false);
  const del = useMutation({
    mutationFn: () => api.deleteApp(id, keepVolumes.current, removeImages.current),
    onSuccess: () => router.replace("/apps"),
    onError: (e) => toast(errMsg(e), "error"),
  });
  // Shared by the header "…" menu and the Danger-zone card, so one delete flow with its typed-name
  // guard and keep-volumes / remove-images opt-ins lives in a single place.
  const confirmAndDelete = async () => {
    if (!appData || del.isPending) return; // guard both entry points (header "…" menu + Danger-zone card) against a double-fire
    keepVolumes.current = false;
    removeImages.current = false;
    // Offer "also remove images" only for Image/Git apps — a compose app's images are its
    // upstream/compose-built tags, which the hub intentionally never removes.
    const boxes = [{ label: t("apps.keepVolumes"), ref: keepVolumes }];
    if (appData.source !== "COMPOSE") boxes.push({ label: t("apps.removeImages"), ref: removeImages });
    if (await confirm({ title: t("apps.delete"), body: appData.source === "COMPOSE" ? t("apps.deleteConfirmCompose") : t("apps.deleteConfirm"), danger: true, confirmText: appData.name, checkbox: boxes })) del.mutate();
  };
  const regen = useMutation({
    mutationFn: () => api.regenerateWebhook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const autoDeployMut = useMutation({
    mutationFn: (enabled: boolean) => api.setAppAutoDeploy(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const rollback = useMutation({
    mutationFn: (deploymentId: string) => api.rollbackApp(id, deploymentId),
    onSuccess: invalidate,
  });
  const cancelDeploy = useMutation({
    mutationFn: (deploymentId: string) => api.cancelDeployment(id, deploymentId),
    onSuccess: invalidate,
    meta: { successMessage: t("apps.deployCancelled") },
  });
  const tags = useMutation({
    mutationFn: (next: string[]) => api.setAppTags(id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
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
  const seenActive = useRef(false);
  useEffect(() => {
    if (!optimisticDeploy) { seenActive.current = false; return; }
    if (deployActive) { seenActive.current = true; return; }
    if (seenActive.current && !deploy.isPending) { setOptimisticDeploy(false); return; }
    const timer = setTimeout(() => setOptimisticDeploy(false), 20000); // never hold the stream open forever
    return () => clearTimeout(timer);
  }, [optimisticDeploy, deployActive, deploy.isPending]);
  const streamActive = deployActive || deploy.isPending || optimisticDeploy;
  const live = useDeployLogStream(id, streamActive);
  // The stream reports a final SUCCESS/FAILED + exit code the UI used to ignore — toast it once so a deploy's
  // outcome is visible even if the operator looked away. The ref makes it fire once per completion.
  const deployDone = useRef(false);
  useEffect(() => {
    if (!live.done) { deployDone.current = false; return; }
    if (live.status && !deployDone.current) {
      deployDone.current = true;
      if (live.status === "SUCCESS") toast(t("apps.deploySucceeded"), "success");
      else toast(t("apps.deployFailed", { code: live.exitCode ?? "?" }), "error");
    }
  }, [live.done, live.status, live.exitCode, toast, t]);
  const [shell, setShell] = useState<TerminalTarget | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exposeOpen, setExposeOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  // Which deployment the Deployments tab has drilled into (Coolify-style). null ⇒ show the list.
  const [selDep, setSelDep] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (name: string) => api.renameApp(id, name),
    onSuccess: () => { setRenameOpen(false); qc.invalidateQueries({ queryKey: ["app", id] }); },
  });
  // Overview is merged with Configuration (Coolify-style): the one "overview" tab renders a left sub-nav
  // whose first section is the summary and the rest are the config groups. An old ?tab=configuration link
  // simply falls back to "overview" (resolveTab drops the now-unknown key).
  const tabDefs = [
    { key: "overview", label: t("apps.tabOverview"), icon: LayoutDashboard },
    { key: "deployments", label: t("apps.tabDeployments"), badge: deployments.length, icon: Rocket },
    { key: "metrics", label: t("apps.tabMetrics"), icon: Activity },
    { key: "logs", label: t("apps.tabLogs"), icon: ScrollText },
    // Files listing is writer-only (the hub endpoint requires write permission), like logs/config.
    ...(appData?.canWrite ? [{ key: "files", label: t("apps.tabFiles"), icon: FolderOpen }] : []),
  ];
  const [tab, setTab] = useTabState("overview", tabDefs.map((d) => d.key));
  // The Deploy -> Logs jump unmounts the config cards (tabs render conditionally), so it leaves them like a tab click does.
  const guardLeave = useLeaveGuard();
  // Overview/Configuration sub-nav section, deep-linked as ?section=. "overview" is the first section
  // (the summary); the rest are the config groups. Default lands on the summary.
  const [sectionRaw, setSection] = useTabState("overview", ["overview", ...CONFIG_GROUP_KEYS], "section");
  // Jump into a specific sub-nav section from elsewhere (e.g. the not-deployed banner). Writes tab + section
  // in ONE navigation so the two useTabState setters don't race (each rebuilds the URL from the same snapshot).
  const goToSection = (section: string) => {
    const params = new URLSearchParams(sp.toString());
    params.delete("tab"); // "overview" is the tab fallback → omit the param
    if (section === "overview") params.delete("section");
    else params.set("section", section);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // Leaving the Deployments tab clears the drilled-in deployment so returning starts at the list.
  useEffect(() => { if (tab !== "deployments") setSelDep(null); }, [tab]);

  if (isError && !appData) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !appData) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  // Guard BEFORE mutating: with a dirty card, "Stay" must cancel the deploy as well as the jump to Logs.
  const onDeploy = (opts?: { noCache?: boolean }) => guardLeave(() => { setOptimisticDeploy(true); deploy.mutate(opts); setTab("logs"); });
  const deployingNow = deploy.isPending || optimisticDeploy;
  const isRunning = appData.status === "RUNNING";
  const headerStatus = deployingNow && appData.status !== "RUNNING" ? { label: "DEPLOYING", color: "var(--c-am)" } : { label: appData.status, color: appColor(appData.status) };
  const primary: "deploy" | "restart" | "start" = appData.status === "RUNNING" ? "restart" : appData.status === "STOPPED" ? "start" : "deploy";

  // Configuration tab is a Coolify-style left sub-nav: group gating lives in config-groups.ts,
  // and each card's JSX is a thunk so a null webhookToken/domain never renders (and never throws).
  const configGroups = visibleConfigGroups(appData);
  const activeSection = resolveTab(sectionRaw, ["overview", ...configGroups.map((g) => g.key)], "overview");
  const renderConfigCard: Record<ConfigCardId, () => ReactNode> = {
    description: () => <AppDescriptionCard id={id} description={appData.description} />,
    deploySettings: () => (
      <DeploySettingsCard id={id} deployStrategy={appData.deployStrategy} rollbackOnFailure={appData.rollbackOnFailure} imagesToKeep={appData.imagesToKeep} postCutoverSoakSec={appData.postCutoverSoakSec} />
    ),
    clusterDeploy: () => (
      <ClusterDeployCard id={id} teamId={appData.teamId} clusterId={appData.clusterId} replicas={appData.replicas} placement={appData.placement} volumes={appData.volumes} constraintServerId={appData.constraintServerId} />
    ),
    environment: () => <EnvironmentCard kind="app" id={id} environmentId={appData.environmentId} />,
    tags: () => <TagsCard tags={appData.tags} canWrite={appData.canWrite} onSave={(next) => tags.mutate(next)} />,
    source: () => <SourceCard id={id} source={appData.source} gitUrl={appData.gitUrl} gitBranch={appData.gitBranch} gitCommit={appData.gitCommit} image={appData.image} composePath={appData.composePath} />,
    build: () => <BuildSettingsCard id={id} buildType={appData.buildType} dockerfilePath={appData.dockerfilePath} dockerBuildTarget={appData.dockerBuildTarget} baseDirectory={appData.baseDirectory} buildCommand={appData.buildCommand} outputDir={appData.outputDir} nixpacksInstallCmd={appData.nixpacksInstallCmd} nixpacksBuildCmd={appData.nixpacksBuildCmd} nixpacksStartCmd={appData.nixpacksStartCmd} />,
    buildConfig: () => (
      <BuildConfigCard id={id} teamId={appData.teamId} registryId={appData.registryId} pushToRegistry={appData.pushToRegistry} buildServerId={appData.buildServerId} />
    ),
    buildArgs: () => <BuildArgsCard id={id} />,
    buildSecrets: () => <BuildSecretsCard id={id} buildType={appData.buildType} source={appData.source} />,
    dockerOptions: () => <DockerOptionsCard id={id} dockerOptions={appData.dockerOptions} allowPrivileged={appData.allowPrivilegedDockerOptions} />,
    containerCommand: () => <ContainerCommandCard id={id} entrypoint={appData.containerEntrypoint} command={appData.containerCommand} />,
    restartPolicy: () => <RestartPolicyCard id={id} restartPolicy={appData.restartPolicy} />,
    deployHooks: () => <DeployHooksCard id={id} pre={appData.preDeployCommand} post={appData.postDeployCommand} />,
    credentials: () => (
      <CredentialsCard id={id} source={appData.source} gitUrl={appData.gitUrl} composePath={appData.composePath} hasGitToken={appData.hasGitToken} hasGitSshKey={appData.hasGitSshKey} gitSshPublicKey={appData.gitSshPublicKey} registryUrl={appData.registryUrl} registryUser={appData.registryUser} />
    ),
    env: () => <EnvCard id={id} clusterId={appData.clusterId} canWrite={appData.canWrite} />,
    databaseLinks: () => <DatabaseLinksCard id={id} serverId={appData.serverId} canWrite={appData.canWrite} />,
    secretRefs: () => <AppSecretRefsCard id={id} teamId={appData.teamId} canWrite={appData.canWrite} />,
    expose: () => (
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
    ),
    domain: () => <DomainCard id={id} domain={appData.domain} https={appData.https} />,
    extraDomains: () => <ExtraDomainsCard id={id} extraDomains={appData.extraDomains} />,
    serviceDomains: () => <ServiceDomainsCard id={id} />,
    domainOptions: () =>
      appData.domain ? (
        <DomainOptionsCard id={id} domain={appData.domain} https={appData.https} domainRedirect={appData.domainRedirect} securityHeaders={appData.securityHeaders} gzip={appData.gzip} forwardAuth={appData.forwardAuth} ipAllowlist={appData.ipAllowlist} pathPrefix={appData.pathPrefix} stripPrefix={appData.stripPrefix} rateLimit={appData.rateLimit} />
      ) : null,
    customCert: () =>
      appData.domain ? (
        <CustomCertCard id={id} hasCustomCert={appData.hasCustomCert} certDomains={appData.certDomains} certNotAfter={appData.certNotAfter} />
      ) : null,
    volumes: () => <VolumesCard id={id} volumes={appData.volumes} />,
    hostMounts: () => <HostMountsCard id={id} hostMounts={appData.hostMounts} />,
    volumeBackups: () => (
      <VolumeBackupsCard id={id} volumes={appData.volumes} enabled={appData.volumeBackupEnabled} intervalHours={appData.volumeBackupIntervalHours} retention={appData.volumeBackupRetention} destinationId={appData.volumeBackupDestinationId} />
    ),
    configMounts: () => <ConfigMountsCard id={id} onDeploy={() => onDeploy()} />,
    healthCheck: () => (
      <HealthCheckCard id={id} healthCheckType={appData.healthCheckType} healthCheckPath={appData.healthCheckPath} healthCheckPort={appData.healthCheckPort} healthCheckMethod={appData.healthCheckMethod} healthCheckScheme={appData.healthCheckScheme} healthCheckResponseText={appData.healthCheckResponseText} healthCmd={appData.healthCmd} timings={{ interval: appData.healthInterval, timeout: appData.healthTimeout, retries: appData.healthRetries, startPeriod: appData.healthStartPeriod, expectedStatus: appData.healthExpectedStatus }} />
    ),
    limits: () => (
      <LimitsCard id={id} memoryMb={appData.memoryMb} cpus={appData.cpus} reserveMemoryMb={appData.reserveMemoryMb} reserveCpus={appData.reserveCpus} gpus={appData.gpus} deployTimeoutSec={appData.deployTimeoutSec} clusterId={appData.clusterId} />
    ),
    scheduledTasks: () => <ScheduledTasksCard id={id} />,
    webhooks: () =>
      appData.webhookToken ? (
        <SectionCard title={t("apps.webhooks")} desc={t("apps.webhookDesc", { branch: appData.gitBranch ?? "main" })}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <CopyRow label={t("apps.webhookUrl")} value={webhookUrl(appData.webhookToken)} copy={t("apps.copy")} />
            {appData.webhookSecret && (
              <CopyRow label={t("apps.webhookSecret")} value={appData.webhookSecret} copy={t("apps.copy")} secret />
            )}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", marginTop: 12 }}>
            <input type="checkbox" checked={appData.autoDeploy} disabled={autoDeployMut.isPending} onChange={(e) => autoDeployMut.mutate(e.target.checked)} />
            {t("apps.autoDeploy")}
          </label>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px" }}>{t("apps.autoDeployHint")}</p>
          <div style={{ marginTop: 12 }}>
            <Btn variant="ghost" disabled={regen.isPending} onClick={async () => { if (await confirm({ body: t("apps.regenerateConfirm"), danger: true })) regen.mutate(); }}>
              {t("apps.regenerate")}
            </Btn>
          </div>
        </SectionCard>
      ) : null,
    watchPaths: () => <WatchPathsCard id={id} watchPaths={appData.watchPaths} />,
    basicAuth: () => <BasicAuthCard id={id} usernames={appData.basicAuthUsers} />,
    redirects: () => <RedirectsCard id={id} redirects={appData.redirects} />,
    containerPort: () => <ContainerPortCard id={id} containerPort={appData.containerPort} />,
    extraPorts: () => <ExtraPortsCard id={id} ports={appData.extraPorts} />,
    networkAliases: () => <NetworkAliasesCard id={id} aliases={appData.networkAliases} />,
    preview: () => <PreviewCard id={id} previewEnabled={appData.previewEnabled} domain={appData.domain} excludeKeys={appData.previewExcludeKeys} limit={appData.previewLimit} />,
    danger: () => (
      <SectionCard title={t("apps.dangerDeleteTitle")} desc={t("apps.dangerDeleteDesc")} style={{ borderColor: "var(--c-r)" }}>
        <Btn icon={Trash2} variant="dangerGhost" loading={del.isPending} onClick={() => void confirmAndDelete()}>{t("apps.delete")}</Btn>
      </SectionCard>
    ),
  };

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={resourceBreadcrumb({ projectId: appData.projectId, projectName: appData.projectName, environmentName: appData.environmentName, name: appData.name, projectsLabel: t("nav.projects"), fallbackLabel: t("nav.apps"), fallbackHref: "/apps" })}
        title={appData.name}
        icon={<AppLogo iconUrl={appIconUrl(appData.id, appData.iconUpdatedAt)} templateSlug={appData.templateSlug} templateLogo={appData.templateLogo} source={appData.source} name={appData.name} size={20} />}
        status={headerStatus}
        badge={appData.isPreview ? <Badge tone="lapis">{t("apps.previewBadge", { n: appData.prNumber ?? "?" })}</Badge> : undefined}
        actions={
          appData.canWrite ? (
            <>
              {/* One primary (ship code) + a lifecycle group (restart/start, stop) + an overflow menu for
                  the rest (shell, rebuild, rename, clone, delete). Groups 2/3 carry a border-left separator. */}
              <div role="group" aria-label={t("apps.actionsDeploy")} style={actionGroup}>
                <Btn
                  icon={appData.status === "NEW" ? Rocket : CloudUpload}
                  variant={primary === "deploy" ? "primary" : "ghost"}
                  iconTone={primary === "deploy" ? undefined : "success"}
                  loading={deploy.isPending}
                  title={appData.status === "NEW" ? undefined : t("apps.redeployHint")}
                  onClick={() => onDeploy()}
                >
                  {deploy.isPending ? t("apps.deploying") : appData.status === "NEW" ? t("apps.deploy") : t("apps.redeploy")}
                </Btn>
              </div>
              <div role="group" aria-label={t("apps.actionsLifecycle")} style={actionGroupSep}>
                {primary === "restart" && (
                  <Btn icon={RotateCw} iconTone="warn" loading={restart.isPending} title={t("apps.restartHint")} onClick={() => restart.mutate()}>{restart.isPending ? t("apps.restarting") : t("apps.restart")}</Btn>
                )}
                {primary === "start" && (
                  <Btn icon={Play} iconTone="success" loading={start.isPending} onClick={() => start.mutate()}>{start.isPending ? t("apps.starting") : t("apps.start")}</Btn>
                )}
                <Btn icon={Square} variant="dangerGhost" loading={stop.isPending} disabled={!isRunning} onClick={async () => { if (await confirm({ body: t("apps.stopConfirm"), danger: true })) stop.mutate(); }}>{t("apps.stop")}</Btn>
              </div>
              <div role="group" aria-label={t("apps.actionsTools")} style={actionGroupSep}>
                <Menu
                  label={t("apps.more")}
                  items={[
                    {
                      key: "shell",
                      label: t("apps.openShell"),
                      icon: Terminal,
                      disabled: !isRunning,
                      title: !isRunning ? t("apps.shellDisabledHint") : undefined,
                      onSelect: () => (appData.source === "COMPOSE" ? setPickerOpen(true) : setShell({ app: id })),
                    },
                    {
                      key: "rebuild",
                      label: appData.source === "COMPOSE" || appData.source === "IMAGE" ? t("apps.pullRedeploy") : t("apps.rebuild"),
                      icon: appData.source === "COMPOSE" || appData.source === "IMAGE" ? CloudDownload : Hammer,
                      tone: "warn",
                      disabled: deploy.isPending,
                      title: t("apps.forceDeployHint"),
                      onSelect: () => onDeploy({ noCache: true }),
                    },
                    { key: "rename", label: t("apps.rename"), icon: Pencil, onSelect: () => setRenameOpen(true) },
                    { key: "clone", label: t("apps.clone"), icon: Copy, onSelect: () => setCloneOpen(true) },
                    { key: "delete", label: t("apps.delete"), icon: Trash2, danger: true, onSelect: () => void confirmAndDelete() },
                  ]}
                />
              </div>
            </>
          ) : undefined
        }
      >
        <p className="mono" style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>
            {appSourceSummary(appData)}
            {appData.hostPort ? ` · :${appData.hostPort}→${appData.containerPort}` : ""}
          </span>
          {appData.source !== "COMPOSE" && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                padding: "1px 6px",
                borderRadius: "var(--r1)",
                background: "var(--c-el)",
                color: appData.zeroDowntime ? "var(--c-g)" : "var(--c-tx3)",
                border: "1px solid var(--c-bd)",
              }}
            >
              {appData.zeroDowntime ? t("apps.zeroDowntime") : t("apps.recreateStrategy")}
            </span>
          )}
        </p>
        {appData.url && (
          <p style={{ margin: "6px 0 0" }}>
            <a href={appData.url} target="_blank" rel="noreferrer" style={{ color: "var(--c-lapis)", fontSize: 13 }}>
              {appData.url} {t("apps.open")}
            </a>
          </p>
        )}
      </PageHeader>

      {cloneOpen && (
        <CloneAppModal appId={id} defaultName={`${appData.name} (copy)`} teamId={appData.teamId} currentServerId={appData.serverId} onClose={() => setCloneOpen(false)} />
      )}
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

      {appData.status === "NEW" && !deployingNow && (
        <div style={{ margin: "14px 0", padding: "12px 14px", border: "1px solid var(--c-bd)", borderLeft: "3px solid var(--c-am)", borderRadius: "var(--r1)", background: "var(--c-sb)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t("apps.notDeployedTitle")}</div>
            <div style={{ fontSize: 12.5, color: "var(--c-tx3)", marginTop: 2 }}>{t("apps.notDeployedBody")}</div>
          </div>
          {appData.canWrite && (
            <Btn variant="ghost" icon={Settings2} onClick={() => goToSection("general")}>{t("apps.tabConfiguration")}</Btn>
          )}
          {appData.canWrite && (
            <Btn onClick={() => onDeploy()} disabled={deploy.isPending}>{t("apps.deploy")}</Btn>
          )}
        </div>
      )}

      {tab === "overview" && (() => {
        // The merged Overview+Configuration page. The summary is the first sub-nav section; the config
        // groups follow. A COMPOSE app's summary is its compose editor. Read-only users (no config groups)
        // just get the summary, with no sidebar.
        const overviewPanel =
          appData.source === "COMPOSE" && appData.composeFile ? (
            <ComposeEditorCard id={id} composeFile={appData.composeFile} canWrite={appData.canWrite} onDeploy={() => deploy.mutate(undefined)} />
          ) : appData.source === "COMPOSE" && appData.composePath && !appData.canWrite ? (
            // Read-only users have no config groups, so surface the git source here; writers edit it in the
            // Build group's source card instead (and get the normal overview).
            <GitComposeSourceCard app={appData} />
          ) : (
            <AppOverview app={appData} deployments={deployments} />
          );
        if (!appData.canWrite) return overviewPanel;
        return (
          <>
            <ConfigLayout
              navLabel={t("apps.cfgNavLabel")}
              active={activeSection}
              onChange={setSection}
              groups={[
                { key: "overview", label: t("apps.cfgGroupOverview"), icon: LayoutDashboard, content: <>{overviewPanel}<AppIconCard app={appData} onChanged={() => { invalidate(); qc.invalidateQueries({ queryKey: ["apps"] }); }} /></> },
                ...configGroups.map((g) => ({
                  key: g.key,
                  label: t(g.labelKey),
                  icon: CONFIG_GROUP_ICONS[g.key],
                  content: g.cardIds.map((cid) => <Fragment key={cid}>{renderConfigCard[cid]()}</Fragment>),
                })),
              ]}
            />
            {exposeOpen && (
              <ExposeModal appId={id} current={appData.exposeMode} currentDomain={appData.domain} onClose={() => setExposeOpen(false)} />
            )}
          </>
        );
      })()}

      {tab === "deployments" && (
        <DeploymentsTab
          app={appData}
          deployments={deployments}
          selDep={selDep}
          setSelDep={setSelDep}
          aiResults={aiResults}
          analyzePendingFor={analyze.isPending ? analyze.variables : undefined}
          rollbackPending={rollback.isPending}
          cancelPending={cancelDeploy.isPending}
          deployPending={deploy.isPending}
          onDeploy={() => onDeploy()}
          onRollback={async (did) => { if (await confirm({ body: t("apps.rollbackConfirm"), danger: true })) rollback.mutate(did); }}
          onAnalyze={(did) => analyze.mutate(did)}
          onCancel={(did) => cancelDeploy.mutate(did)}
        />
      )}

      {tab === "metrics" && <MetricsTab id={id} events={deployEvents} />}

      {tab === "logs" && (
        <LogsTab id={id} canWrite={appData.canWrite} isCompose={appData.source === "COMPOSE"} streamActive={streamActive} liveLines={live.lines} lastDeployLog={deployments[0]?.logs} />
      )}

      {tab === "files" && appData.canWrite && <FilesTab id={id} app={appData} />}
    </div>
  );
}
