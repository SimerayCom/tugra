"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, appIconUrl } from "../../../../lib/api";
import { LiveLogsCard } from "../../../../components/live-logs-card";
import type { AppVolume, HostMount, Application, AppSource, BuildType, Deployment } from "../../../../lib/types";
import { appColor, appSourceSummary, deploymentColor, shortDigest, webhookUrl } from "../../../../lib/apps";
import { relativeTime } from "../../../../lib/fleet";
import { backupColor, formatSize } from "../../../../lib/backups";
import { useDeployLogStream } from "../../../../hooks/useDeployLogStream";
import { AppMetricsCard } from "../../../../components/app-metrics-card";
import { AppFilesCard } from "../../../../components/app-files-card";
import { ConfigMountsCard } from "../../../../components/config-mounts-card";
import { DatabaseLinksCard } from "../../../../components/database-links-card";
import { TerminalModal } from "../../../../components/terminal-modal";
import { CloneAppModal } from "../../../../components/clone-app-modal";
import { RenameModal } from "../../../../components/rename-modal";
import { ExposeModal } from "../../../../components/expose-modal";
import { Modal } from "../../../../components/modal";
import { resourceBreadcrumb } from "../../../../lib/breadcrumb";
import { useTabState } from "../../../../hooks/useTabState";
import { CopyRow } from "../../../../components/copy-row";
import { IconBtn } from "../../../../components/icon-btn";
import { useConfirm } from "../../../../components/confirm";
import type { TerminalTarget } from "../../../../lib/ws";
import { parseDotenv, toDotenv, duplicateKeys, invalidKeys } from "../../../../lib/dotenv";
import { collapseCarriageReturns, summarizeDeployLog } from "../../../../lib/log-lines";
import { cleanDomain } from "../../../../lib/domain";
import { EnvironmentCard } from "../../../../components/environment-card";
import { ClusterDeployCard } from "../../../../components/cluster-deploy-card";
import { TagsCard } from "../../../../components/tags";
import { useT } from "../../../../i18n/provider";
import { useToast } from "../../../../components/toast";
import { Badge, Btn, Card, EmptyState, SectionCard, Spinner } from "../../../../components/ui";
import { PageHeader } from "../../../../components/page-header";
import { AppLogo } from "../../../../components/app-logo";
import { ErrorState } from "../../../../components/error-state";
import { Tabs } from "../../../../components/tabs-nav";
import { ConfigLayout } from "../../../../components/config-layout";
import { CONFIG_GROUP_KEYS, visibleConfigGroups, type ConfigCardId } from "../../../../lib/config-groups";
import { resolveTab } from "../../../../lib/tab-param";
import {
  LayoutDashboard, Settings2, Rocket, Activity, ScrollText, FolderOpen,
  SlidersHorizontal, Hammer, Variable, Globe, HardDrive, HeartPulse, Clock,
  RotateCw, Play, RefreshCw, Square, Terminal, Ellipsis, CloudDownload, CloudUpload,
  Pencil, Trash2, Copy, Lock, ChevronRight, ExternalLink, ArrowDown, X, type LucideIcon,
} from "lucide-react";

// Icon per Configuration sub-nav group. Kept here (not in config-groups.ts) so that pure, tested file
// stays presentation-free.
const CONFIG_GROUP_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal, build: Hammer, environment: Variable, domains: Globe,
  storage: HardDrive, "health-resources": HeartPulse, automation: Clock,
};

// Post-deploy rollout states the agent reports via the TUGRA_ROLLOUT marker, mapped to a chip colour.
// `healthy`/`converged` are good outcomes; `rolled_back` is a caution; anything else (rollback_failed,
// failed, unexpected) is an error. Known states get a translated label; an unknown one shows verbatim.
const ROLLOUT_KNOWN = new Set(["healthy", "converged", "rolled_back", "rollback_failed", "failed"]);
function rolloutColor(state: string): string {
  if (state === "healthy" || state === "converged") return "var(--c-g)";
  if (state === "rolled_back") return "var(--c-am)";
  return "var(--c-r)";
}

// Deployment origins (Deployment.trigger) that have a translated label; an unknown one shows verbatim, and a
// null trigger (legacy rows) falls back to the kind label.
const TRIGGER_KNOWN = new Set(["manual", "webhook", "preview", "rollback"]);

/** Human-readable wall-clock duration from a millisecond count (e.g. 1500 → "2s", 83000 → "1m 23s"). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

/** At-a-glance summary for a non-compose app's Overview tab: the live URL plus a compact stat grid
 *  (status, source, exposure, placement, resources, port, environment, last deployment). Replaces the
 *  earlier single-line placeholder so the first tab actually tells you what the app is and how it ran. */
function AppOverview({ app, deployments }: { app: Application; deployments: Deployment[] }) {
  const t = useT();
  const last = deployments[0] ?? null;
  const resourceParts: string[] = [];
  if (app.memoryMb) resourceParts.push(`${app.memoryMb} MB`);
  if (app.cpus) resourceParts.push(`${app.cpus} CPU`);
  const stats: { label: string; node: ReactNode }[] = [
    { label: t("apps.status"), node: <span style={{ color: appColor(app.status), fontWeight: 600 }}>{app.status}</span> },
    { label: t("apps.source"), node: <span className="mono">{appSourceSummary(app) || "—"}</span> },
    { label: t("apps.exposeTitle"), node: t(`apps.exposeMode_${app.exposeMode}`) },
    { label: t("apps.placementTitle"), node: app.clusterId ? t("apps.ovSwarm", { n: app.replicas ?? 1 }) : t("apps.ovSingleServer") },
    { label: t("apps.ovResources"), node: resourceParts.length ? resourceParts.join(" · ") : t("apps.ovNoLimit") },
    { label: t("apps.ovPort"), node: app.containerPort != null ? String(app.containerPort) : "—" },
    { label: t("apps.ovEnv"), node: t("apps.ovEnvCount", { n: app.envCount }) },
    {
      label: t("apps.ovLastDeploy"),
      node: last ? (
        <span>
          <span style={{ color: deploymentColor(last.status), fontWeight: 600 }}>{last.status}</span>
          {" · "}
          {relativeTime(last.createdAt)}
        </span>
      ) : (
        t("apps.ovNever")
      ),
    },
  ];
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", paddingBottom: 14, marginBottom: 14, borderBottom: "1px solid var(--c-bd)" }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)" }}>{t("apps.ovLiveUrl")}</span>
        {app.url ? (
          <a href={app.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)", fontSize: 14, wordBreak: "break-all" }}>
            {app.url}<ExternalLink size={13} aria-hidden style={{ marginLeft: 4, verticalAlign: "middle" }} />
          </a>
        ) : (
          <span style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("apps.ovNotExposed")}</span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))", gap: 14 }}>
        {stats.map((s) => (
          <div key={s.label}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 }}>{s.label}</div>
            <div style={{ fontSize: 13, color: "var(--c-tx)" }}>{s.node}</div>
          </div>
        ))}
      </div>
      {app.canWrite && !last && <div style={{ marginTop: 14, fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.overviewHint")}</div>}
      {!app.canWrite && <div style={{ marginTop: 14, fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.readOnlyHint")}</div>}
    </Card>
  );
}

/** Center-crop an image file to a square PNG at the given side, returned as a base64 string (no data: prefix). */
async function cropToPngBase64(file: File, side: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    const crop = Math.min(img.width, img.height);
    if (!crop) throw new Error("empty");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no-canvas");
    ctx.imageSmoothingQuality = "high"; // the default "low" aliases badly downscaling a large photo to 128px
    ctx.drawImage(img, (img.width - crop) / 2, (img.height - crop) / 2, crop, crop, 0, 0, side, side);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("encode");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload / replace / remove the app's custom icon. Crops client-side to a 128px square PNG (falling back to
 *  smaller sides if the encoded image would exceed the server's 64KB budget) before sending. Writer-only. */
function AppIconCard({ app, onChanged }: { app: Application; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const hasIcon = !!app.iconUpdatedAt;

  const save = useMutation({
    mutationFn: (data: string) => api.setAppIcon(app.id, data),
    onSuccess: () => { onChanged(); toast(t("apps.iconUploaded"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("apps.actionFailed"), "error"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAppIcon(app.id),
    onSuccess: () => { onChanged(); toast(t("apps.iconRemoved"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("apps.actionFailed"), "error"),
  });

  const onPick = async (file: File) => {
    setProcessing(true);
    try {
      // Try 128px, then shrink if the PNG would blow the 64KB server cap (base64 ≈ 4/3 of the byte size).
      let data = "";
      for (const side of [128, 96, 64]) {
        data = await cropToPngBase64(file, side);
        if (data.length * 0.75 <= 64 * 1024) break;
      }
      if (data.length * 0.75 > 64 * 1024) { toast(t("apps.iconTooLarge"), "error"); return; }
      save.mutate(data);
    } catch {
      toast(t("apps.iconReadFailed"), "error");
    } finally {
      setProcessing(false);
    }
  };

  const busy = processing || save.isPending || remove.isPending;
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("apps.iconTitle")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14, maxWidth: 520 }}>{t("apps.iconHint")}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ width: 56, height: 56, borderRadius: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <AppLogo iconUrl={appIconUrl(app.id, app.iconUpdatedAt)} templateSlug={app.templateSlug} templateLogo={app.templateLogo} source={app.source} name={app.name} size={36} />
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant="ghost" icon={CloudUpload} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "…" : hasIcon ? t("apps.iconReplace") : t("apps.iconUpload")}
          </Btn>
          {hasIcon && (
            <Btn variant="ghost" icon={Trash2} onClick={() => remove.mutate()} disabled={busy}>{t("apps.iconRemove")}</Btn>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (f) void onPick(f);
        }}
      />
    </Card>
  );
}

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
  const del = useMutation({
    mutationFn: () => api.deleteApp(id, keepVolumes.current),
    onSuccess: () => router.replace("/apps"),
    onError: (e) => toast(errMsg(e), "error"),
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const regen = useMutation({
    mutationFn: () => api.regenerateWebhook(id),
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

  const onDeploy = (opts?: { noCache?: boolean }) => { setOptimisticDeploy(true); deploy.mutate(opts); setTab("logs"); };
  const deployingNow = deploy.isPending || optimisticDeploy;
  const isRunning = appData.status === "RUNNING";
  const headerStatus = deployingNow && appData.status !== "RUNNING" ? { label: "DEPLOYING", color: "var(--c-am)" } : { label: appData.status, color: appColor(appData.status) };
  const primary: "deploy" | "restart" | "start" = appData.status === "RUNNING" ? "restart" : appData.status === "STOPPED" ? "start" : "deploy";

  // Configuration tab is a Coolify-style left sub-nav: group gating lives in config-groups.ts,
  // and each card's JSX is a thunk so a null webhookToken/domain never renders (and never throws).
  const configGroups = visibleConfigGroups(appData);
  const activeSection = resolveTab(sectionRaw, ["overview", ...configGroups.map((g) => g.key)], "overview");
  const renderConfigCard: Record<ConfigCardId, () => ReactNode> = {
    deploySettings: () => (
      <DeploySettingsCard id={id} deployStrategy={appData.deployStrategy} rollbackOnFailure={appData.rollbackOnFailure} />
    ),
    clusterDeploy: () => (
      <ClusterDeployCard id={id} teamId={appData.teamId} clusterId={appData.clusterId} replicas={appData.replicas} placement={appData.placement} volumes={appData.volumes} constraintServerId={appData.constraintServerId} />
    ),
    environment: () => <EnvironmentCard kind="app" id={id} environmentId={appData.environmentId} />,
    tags: () => <TagsCard tags={appData.tags} canWrite={appData.canWrite} onSave={(next) => tags.mutate(next)} />,
    source: () => <SourceCard id={id} source={appData.source} gitUrl={appData.gitUrl} gitBranch={appData.gitBranch} image={appData.image} composePath={appData.composePath} />,
    build: () => <BuildSettingsCard id={id} buildType={appData.buildType} dockerfilePath={appData.dockerfilePath} baseDirectory={appData.baseDirectory} buildCommand={appData.buildCommand} outputDir={appData.outputDir} />,
    buildConfig: () => (
      <BuildConfigCard id={id} teamId={appData.teamId} registryId={appData.registryId} pushToRegistry={appData.pushToRegistry} buildServerId={appData.buildServerId} />
    ),
    buildArgs: () => <BuildArgsCard id={id} />,
    dockerOptions: () => <DockerOptionsCard id={id} dockerOptions={appData.dockerOptions} />,
    deployHooks: () => <DeployHooksCard id={id} pre={appData.preDeployCommand} post={appData.postDeployCommand} />,
    credentials: () => (
      <CredentialsCard id={id} source={appData.source} gitUrl={appData.gitUrl} composePath={appData.composePath} hasGitToken={appData.hasGitToken} hasGitSshKey={appData.hasGitSshKey} gitSshPublicKey={appData.gitSshPublicKey} registryUrl={appData.registryUrl} registryUser={appData.registryUser} />
    ),
    env: () => <EnvCard id={id} clusterId={appData.clusterId} />,
    databaseLinks: () => <DatabaseLinksCard id={id} serverId={appData.serverId} canWrite={appData.canWrite} />,
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
        <DomainOptionsCard id={id} domain={appData.domain} https={appData.https} domainRedirect={appData.domainRedirect} securityHeaders={appData.securityHeaders} forwardAuth={appData.forwardAuth} />
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
      <HealthCheckCard id={id} healthCheckType={appData.healthCheckType} healthCheckPath={appData.healthCheckPath} healthCheckPort={appData.healthCheckPort} healthCmd={appData.healthCmd} />
    ),
    limits: () => (
      <LimitsCard id={id} memoryMb={appData.memoryMb} cpus={appData.cpus} reserveMemoryMb={appData.reserveMemoryMb} reserveCpus={appData.reserveCpus} gpus={appData.gpus} deployTimeoutSec={appData.deployTimeoutSec} clusterId={appData.clusterId} />
    ),
    scheduledTasks: () => <ScheduledTasksCard id={id} />,
    webhooks: () =>
      appData.webhookToken ? (
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
      ) : null,
    preview: () => <PreviewCard id={id} previewEnabled={appData.previewEnabled} domain={appData.domain} />,
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
              {primary === "restart" && (
                <Btn icon={RotateCw} onClick={() => restart.mutate()} disabled={restart.isPending}>{restart.isPending ? t("apps.restarting") : t("apps.restart")}</Btn>
              )}
              {primary === "start" && (
                <Btn icon={Play} onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? t("apps.starting") : t("apps.start")}</Btn>
              )}
              <Btn icon={appData.status === "NEW" ? Rocket : RefreshCw} variant={primary === "deploy" ? "primary" : "ghost"} onClick={() => onDeploy()} disabled={deploy.isPending}>
                {deploy.isPending ? t("apps.deploying") : appData.status === "NEW" ? t("apps.deploy") : t("apps.redeploy")}
              </Btn>
              <Btn icon={Square} variant="dangerGhost" onClick={() => stop.mutate()} disabled={stop.isPending || !isRunning}>{t("apps.stop")}</Btn>
              <Btn
                icon={Terminal}
                variant="ghost"
                onClick={() => (appData.source === "COMPOSE" ? setPickerOpen(true) : setShell({ app: id }))}
                disabled={!isRunning}
                title={!isRunning ? t("apps.shellDisabledHint") : undefined}
              >
                {t("apps.openShell")}
              </Btn>
              <div style={{ position: "relative" }}>
                <Btn variant="ghost" onClick={() => setMoreOpen((o) => !o)} aria-haspopup="menu" aria-expanded={moreOpen} aria-label={t("apps.more")}><Ellipsis size={16} /></Btn>
                {moreOpen && (
                  <div
                    role="menu"
                    style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20, display: "flex", flexDirection: "column", gap: 6, padding: 8, minWidth: 140, background: "var(--c-bg, var(--c-el))", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", boxShadow: "0 6px 20px rgba(0,0,0,0.25)" }}
                  >
                    <Btn icon={appData.source === "COMPOSE" || appData.source === "IMAGE" ? CloudDownload : Hammer} variant="ghost" onClick={() => { setMoreOpen(false); onDeploy({ noCache: true }); }} disabled={deploy.isPending} title={t("apps.forceDeployHint")}>
                      {appData.source === "COMPOSE" || appData.source === "IMAGE" ? t("apps.pullRedeploy") : t("apps.rebuild")}
                    </Btn>
                    <Btn icon={Pencil} variant="ghost" onClick={() => { setMoreOpen(false); setRenameOpen(true); }}>{t("apps.rename")}</Btn>
                    <Btn icon={Copy} variant="ghost" onClick={() => { setMoreOpen(false); setCloneOpen(true); }}>{t("apps.clone")}</Btn>
                    <Btn icon={Trash2} variant="dangerGhost" onClick={async () => { setMoreOpen(false); keepVolumes.current = false; if (await confirm({ title: t("apps.delete"), body: appData.source === "COMPOSE" ? t("apps.deleteConfirmCompose") : t("apps.deleteConfirm"), danger: true, confirmText: appData.name, checkbox: { label: t("apps.keepVolumes"), ref: keepVolumes } })) del.mutate(); }}>{t("apps.delete")}</Btn>
                  </div>
                )}
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
                fontSize: 10,
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
        <CloneAppModal appId={id} defaultName={`${appData.name} (copy)`} onClose={() => setCloneOpen(false)} />
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

      {tab === "deployments" && (() => {
        // Current version = latest SUCCESS; a deploy is rollbackable when its artifact is retained
        // (image tag / registry image, or — for compose apps — the compose YAML snapshot) and isn't current.
        const latestSuccessId = deployments.find((x) => x.status === "SUCCESS")?.id;
        const selDepObj = selDep ? deployments.find((x) => x.id === selDep) ?? null : null;
        if (selDepObj) {
          return (
            <DeploymentDetail
              app={appData}
              deployment={selDepObj}
              canRollback={appData.canWrite && selDepObj.rollbackable && selDepObj.id !== latestSuccessId}
              aiResult={aiResults[selDepObj.id]}
              analyzePending={analyze.isPending && analyze.variables === selDepObj.id}
              rollbackPending={rollback.isPending}
              onBack={() => setSelDep(null)}
              onRollback={async (did) => { if (await confirm({ body: t("apps.rollbackConfirm"), danger: true })) rollback.mutate(did); }}
              onAnalyze={(did) => analyze.mutate(did)}
            />
          );
        }
        return (
          <Card style={{ padding: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {deployments.map((d) => {
                const sum = d.logs ? summarizeDeployLog(d.logs) : null;
                // A QUEUED deploy hasn't started — offer Cancel (a RUNNING one can't be cancelled yet). The
                // Cancel button sits OUTSIDE the drill-in row button (no nested buttons).
                const cancellable = d.status === "QUEUED" && appData.canWrite;
                // The whole row is the click target: it drills into the deployment (full log lives there).
                return (
                  <div key={d.id} style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
                  <button
                    type="button"
                    className="dep-row"
                    onClick={() => setSelDep(d.id)}
                    style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flex: 1, minWidth: 0, textAlign: "left", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", transition: "background .12s, border-color .12s" }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
                    {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
                    {sum?.rollout && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: rolloutColor(sum.rollout), border: `1px solid ${rolloutColor(sum.rollout)}`, borderRadius: "999px", padding: "1px 7px", letterSpacing: "0.02em" }}>
                        {ROLLOUT_KNOWN.has(sum.rollout) ? t(`apps.rollout_${sum.rollout}`) : sum.rollout}
                      </span>
                    )}
                    {d.registryImage && <span title={d.registryImage} style={{ display: "inline-flex", alignItems: "center", color: "var(--c-tx3)" }}><CloudUpload size={12} aria-hidden /></span>}
                    {d.imageDigest && (
                      <span title={d.imageDigest} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--c-tx3)" }}>
                        <Lock size={11} aria-hidden /> {shortDigest(d.imageDigest)}
                      </span>
                    )}
                    {d.exitCode != null && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.exit", { code: d.exitCode })}</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(d.createdAt).toLocaleString()}</span>
                    <ChevronRight size={15} aria-hidden style={{ color: "var(--c-tx3)", flexShrink: 0 }} />
                  </button>
                  {cancellable && (
                    <button
                      type="button"
                      onClick={() => cancelDeploy.mutate(d.id)}
                      disabled={cancelDeploy.isPending}
                      style={{ flexShrink: 0, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", background: "transparent", color: "var(--c-r)", fontSize: 12, cursor: "pointer", padding: "0 14px", font: "inherit" }}
                    >
                      {t("apps.cancel")}
                    </button>
                  )}
                  </div>
                );
              })}
              {deployments.length === 0 && (
                <EmptyState action={appData.canWrite ? <Btn onClick={() => onDeploy()} disabled={deploy.isPending}>{t("apps.deploy")}</Btn> : undefined}>
                  {t("apps.noDeployments")}
                </EmptyState>
              )}
            </div>
          </Card>
        );
      })()}

      {tab === "metrics" && <AppMetricsCard id={id} />}

      {tab === "logs" && (
        <>
          {/* During a deploy the BUILD log belongs up top; runtime container logs sit below it. */}
          {streamActive && <LiveLogCard lines={live.lines} />}
          {appData.canWrite && <LiveContainerLogsCard id={id} isCompose={appData.source === "COMPOSE"} />}
          {!streamActive &&
            (deployments[0]?.logs ? (
              <Card style={{ padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("apps.lastDeployLog")}</div>
                <pre className="mono" style={{ ...TERMINAL_PRE_STYLE, maxHeight: 420 }}>{collapseCarriageReturns(deployments[0].logs)}</pre>
              </Card>
            ) : (
              !appData.canWrite && <Card style={{ padding: 16 }}><EmptyState>{t("apps.noLogs")}</EmptyState></Card>
            ))}
        </>
      )}

      {tab === "files" && appData.canWrite && (
        <SectionCard title={t("apps.files.title")} desc={t("apps.files.desc")}>
          <AppFilesCard
            id={id}
            volumes={
              appData.source === "COMPOSE"
                ? appData.composeVolumes
                    .filter((v) => v.browsable)
                    .map((v) => ({ name: v.key, path: v.mounts.map((m) => `${m.service}:${m.path}`).join(", ") || v.key }))
                : appData.volumes
            }
          />
        </SectionCard>
      )}
    </div>
  );
}

function ContainerPickerModal({ id, onClose, onPick }: { id: string; onClose: () => void; onPick: (name: string) => void }) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({ queryKey: ["appContainers", id], queryFn: () => api.listAppContainers(id) });
  const containers = data?.containers ?? [];
  return (
    <Modal onClose={onClose} width={480} ariaLabel={t("apps.selectContainer")}>
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

/** Read-only summary for a COMPOSE-from-git app: where the stack is cloned from. The compose file lives in
 *  the repo (not stored here), so there is no in-place editor — it is cloned, validated and run on deploy. */
function GitComposeSourceCard({ app }: { app: Application }) {
  const t = useT();
  const rows: { label: string; value: string }[] = [
    { label: t("apps.gitUrl"), value: app.gitUrl ?? "—" },
    { label: t("apps.branch"), value: app.gitBranch ?? "main" },
    { label: t("apps.composePath"), value: app.composePath ?? "docker-compose.yml" },
  ];
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("apps.composeFromGit")}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", gap: 12, fontSize: 13 }}>
            <span style={{ color: "var(--c-tx3)", minWidth: 120 }}>{r.label}</span>
            <span className="mono" style={{ color: "var(--c-tx)", wordBreak: "break-all" }}>{r.value}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 10 }}>{t("apps.composePathHint")}</div>
    </Card>
  );
}

/** Edit a COMPOSE app's docker-compose.yml in place (writer only). Validation (safe compose) runs on
 *  save; changes apply on the next deploy, so Save persists and "Save & deploy" chains the deploy. */
function ComposeEditorCard({ id, composeFile, canWrite, onDeploy }: { id: string; composeFile: string; canWrite: boolean; onDeploy: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(composeFile);
  // Re-seed if the saved file changes under us (another tab, a deploy that rewrote it).
  useEffect(() => { setText(composeFile); }, [composeFile]);
  const dirty = text !== composeFile;
  const save = useMutation({
    mutationFn: () => api.setAppComposeFile(id, text),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["app", id] }); toast(t("apps.composeSaved"), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });

  if (!canWrite) {
    return (
      <Card style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("apps.compose")}</div>
        <pre className="mono" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto" }}>{composeFile}</pre>
      </Card>
    );
  }

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("apps.compose")}</div>
        {dirty && <span style={{ fontSize: 11, color: "var(--c-am)" }}>{t("apps.composeUnsaved")}</span>}
      </div>
      <textarea
        className="mono"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        style={{ width: "100%", minHeight: 300, maxHeight: 520, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
      />
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("apps.composeHint")}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <Btn variant="ghost" onClick={() => setText(composeFile)} disabled={!dirty || save.isPending}>{t("apps.composeReset")}</Btn>
        <Btn variant="ghost" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending ? "…" : t("apps.composeSave")}</Btn>
        <Btn onClick={() => { save.mutateAsync().then(() => onDeploy()).catch(() => {}); }} disabled={save.isPending}>{t("apps.composeSaveDeploy")}</Btn>
      </div>
      {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 6 }}>{(save.error as Error).message}</div>}
    </Card>
  );
}

function LiveContainerLogsCard({ id, isCompose }: { id: string; isCompose: boolean }) {
  const t = useT();
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A compose app has many containers → the user must pick one before we can follow it.
  const active = !isCompose || !!container;

  return (
    <>
      <LiveLogsCard
        basePath={`/apps/${id}`}
        container={container}
        active={active}
        emptyHint={t("apps.pickContainerToStream")}
        headerExtra={
          isCompose ? (
            <Btn variant="ghost" onClick={() => setPickerOpen(true)}>
              {container ?? t("apps.selectContainer")}
            </Btn>
          ) : undefined
        }
      />
      {pickerOpen && (
        <ContainerPickerModal
          id={id}
          onClose={() => setPickerOpen(false)}
          onPick={(name) => {
            setContainer(name);
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}

/** Deployment drill-in (Coolify/Dokploy pattern): clicking a row in the Deployments list ENTERS the
 *  deployment and its full build log fills a proper dark terminal panel here — instead of being crammed
 *  into a tiny inline <details> expander. Metadata, rollback/analyze actions and config changes sit above. */
function DeploymentDetail({
  app,
  deployment: d,
  canRollback,
  aiResult,
  analyzePending,
  rollbackPending,
  onBack,
  onRollback,
  onAnalyze,
}: {
  app: Application;
  deployment: Deployment;
  canRollback: boolean;
  aiResult?: string;
  analyzePending: boolean;
  rollbackPending: boolean;
  onBack: () => void;
  onRollback: (id: string) => void;
  onAnalyze: (id: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const sum = d.logs ? summarizeDeployLog(d.logs) : null;
  const rawLog = collapseCarriageReturns(d.logs ?? "");
  const hasCleaned = !!(sum && sum.stripped && sum.body);
  // Drilling in is the "full log" view, so default to the raw build log; a Cleaned toggle appears only
  // when the raw output actually carries control markers (TUGRA_*, bare ids) worth hiding.
  const [cleaned, setCleaned] = useState(false);
  const shown = cleaned && hasCleaned ? sum!.body : rawLog;
  const lineCount = shown ? shown.split("\n").length : 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      toast(t("apps.copied"), "success");
    } catch {
      toast(t("common.copyFailed"), "error");
    }
  };

  const stats: { label: string; node: ReactNode }[] = [
    { label: t("apps.status"), node: <span style={{ color: deploymentColor(d.status), fontWeight: 600 }}>{d.status}</span> },
    // Trigger = ORIGIN (manual/webhook/preview/rollback). Legacy rows have no trigger → fall back to the
    // kind (outcome) label so the stat is never blank.
    { label: t("apps.trigger"), node: d.trigger ? (TRIGGER_KNOWN.has(d.trigger) ? t(`apps.trigger_${d.trigger}`) : d.trigger) : t(`apps.kind_${d.kind}`) },
    ...(sum?.rollout ? [{ label: t("apps.rolloutLabel"), node: <span style={{ color: rolloutColor(sum.rollout), fontWeight: 600 }}>{ROLLOUT_KNOWN.has(sum.rollout) ? t(`apps.rollout_${sum.rollout}`) : sum.rollout}</span> }] : []),
    ...(d.durationMs != null ? [{ label: t("apps.durationLabel"), node: formatDuration(d.durationMs) }] : []),
    ...(d.registryImage || d.imageTag ? [{ label: t("apps.imageLabel"), node: <span className="mono" style={{ wordBreak: "break-all" }}>{d.registryImage ?? d.imageTag}</span> }] : []),
    ...(d.imageDigest ? [{ label: t("apps.digestLabel"), node: <span className="mono" title={d.imageDigest}>{shortDigest(d.imageDigest)}</span> }] : []),
    ...(d.commitSha ? [{ label: t("apps.commitLabel"), node: <span style={{ wordBreak: "break-word" }}><span className="mono">{d.commitSha.slice(0, 7)}</span>{d.commitMessage ? ` ${d.commitMessage}` : ""}</span> }] : []),
    ...(d.exitCode != null ? [{ label: t("apps.exitLabel"), node: <span className="mono">{d.exitCode}</span> }] : []),
    { label: t("apps.startedLabel"), node: <span>{new Date(d.createdAt).toLocaleString()}{" · "}{relativeTime(d.createdAt)}</span> },
  ];

  return (
    <Card style={{ padding: 16 }}>
      <button
        type="button"
        onClick={onBack}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: "var(--c-lapis)", font: "inherit", fontSize: 12, cursor: "pointer", padding: 0, marginBottom: 14 }}
      >
        <span aria-hidden>‹</span> {t("apps.backToDeployments")}
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
        {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
        {sum?.rollout && (
          <span style={{ fontSize: 10, fontWeight: 700, color: rolloutColor(sum.rollout), border: `1px solid ${rolloutColor(sum.rollout)}`, borderRadius: "999px", padding: "1px 7px", letterSpacing: "0.02em" }}>
            {ROLLOUT_KNOWN.has(sum.rollout) ? t(`apps.rollout_${sum.rollout}`) : sum.rollout}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {canRollback && (
          <button onClick={() => onRollback(d.id)} disabled={rollbackPending} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-lapis)", fontSize: 11, cursor: "pointer", padding: "3px 10px", font: "inherit" }}>
            {t("apps.rollback")}
          </button>
        )}
        {d.status === "FAILED" && app.canWrite && (
          <button onClick={() => onAnalyze(d.id)} disabled={analyzePending} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-a)", fontSize: 11, cursor: "pointer", padding: "3px 10px", font: "inherit" }}>
            {analyzePending ? t("apps.analyzing") : t("apps.analyzeAi")}
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))", gap: 14, paddingBottom: 14, marginBottom: 14, borderBottom: "1px solid var(--c-bd)" }}>
        {stats.map((s) => (
          <div key={s.label}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 }}>{s.label}</div>
            <div style={{ fontSize: 13, color: "var(--c-tx)" }}>{s.node}</div>
          </div>
        ))}
      </div>

      {d.configChanges && d.configChanges.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 6 }}>{t("apps.configChanges", { count: d.configChanges.length })}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {d.configChanges.map((c) => (
              <div key={c.field} className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                <span style={{ color: c.kind === "added" ? "var(--c-g)" : c.kind === "removed" ? "var(--c-r)" : "var(--c-a)" }}>{t(`apps.cfg_${c.kind}`)}</span>{" "}
                <span style={{ color: "var(--c-tx2)" }}>{c.field}</span>
                {c.kind === "changed" && <span>: {c.before} → {c.after}</span>}
                {c.kind === "added" && c.after != null && <span>: {c.after}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {aiResult && (
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-a)", marginBottom: 4 }}>{t("apps.aiAnalysis")}</div>
          <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap" }}>{aiResult}</pre>
        </div>
      )}

      {/* The log terminal — full width, dark in both themes, like Coolify/Dokploy's deployment view. */}
      <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", background: "var(--c-el)", borderBottom: "1px solid var(--c-bd)" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx2)" }}>{t("apps.buildLog")}</span>
          {shown && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.logLines", { n: lineCount })}</span>}
          <span style={{ flex: 1 }} />
          {hasCleaned && (
            <div style={{ display: "inline-flex", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden" }}>
              {([{ k: false, label: t("apps.viewRaw") }, { k: true, label: t("apps.viewCleaned") }] as const).map((o) => (
                <button key={String(o.k)} type="button" onClick={() => setCleaned(o.k)} aria-pressed={cleaned === o.k} style={{ background: cleaned === o.k ? "var(--c-lapis)" : "transparent", color: cleaned === o.k ? "#fff" : "var(--c-tx3)", border: "none", font: "inherit", fontSize: 11, padding: "2px 10px", cursor: "pointer" }}>{o.label}</button>
              ))}
            </div>
          )}
          <button type="button" onClick={copy} disabled={!shown} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", font: "inherit", fontSize: 11, padding: "2px 10px", cursor: shown ? "pointer" : "default" }}>{t("apps.copy")}</button>
        </div>
        <pre
          className="mono"
          style={{ ...TERMINAL_PRE_STYLE, borderRadius: 0, minHeight: 300, maxHeight: "62vh" }}
        >
          {shown || <span style={{ color: "#6b7280" }}>{t("apps.noBuildOutput")}</span>}
        </pre>
      </div>
    </Card>
  );
}

function LiveLogCard({ lines }: { lines: string }) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  // Follow the newest output, but STOP snapping to the bottom once the operator scrolls up to read — and
  // offer a "Jump to latest" pill to resume. (Previously it force-scrolled on every chunk, fighting the user.)
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines, following]);
  const onScroll = () => {
    const el = ref.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24); // near the bottom ⇒ keep following
  };
  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
  };
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Spinner />
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.streaming")}</span>
      </div>
      <div style={{ position: "relative" }}>
        <pre
          ref={ref}
          onScroll={onScroll}
          className="mono"
          style={{ ...TERMINAL_PRE_STYLE, maxHeight: 360 }}
        >
          {collapseCarriageReturns(lines) || <span style={{ color: "#6b7280" }}>{t("apps.waitingForBuild")}</span>}
        </pre>
        {!following && (
          <Btn
            icon={ArrowDown}
            variant="ghost"
            onClick={jump}
            style={{ position: "absolute", right: 10, bottom: 10, fontSize: 11, padding: "2px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", boxShadow: "0 1px 6px rgba(0,0,0,.25)" }}
          >
            {t("apps.jumpToLatest")}
          </Btn>
        )}
      </div>
    </Card>
  );
}

// The deployment/build log terminal look — intentionally dark in both themes (like Coolify/Dokploy). Shared
// by the deployment drill-in, the Logs tab's last-deploy log, and the live build-log stream so they can't drift.
const TERMINAL_PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  fontSize: 12,
  lineHeight: 1.55,
  color: "#cdd3de",
  background: "#0b0e14",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderRadius: "var(--r1)",
  overflow: "auto",
};

const envField: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
};

function EnvCard({ id, clusterId }: { id: string; clusterId?: string | null }) {
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
  // Saving a map keeps only the last value for a duplicate key, so a collision silently drops data —
  // warn and block instead. Invalid names (the server rejects them) are a soft, non-blocking hint.
  const dups = duplicateKeys(rows);
  const dupSet = new Set(dups);
  const invalid = invalidKeys(rows);

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
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t(clusterId ? "apps.envDescSwarm" : "apps.envDesc")}</p>
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
            {visible.map(({ r, i }) => {
              const isDup = !!r.key.trim() && dupSet.has(r.key.trim());
              return (
                <div key={i} style={{ display: "flex", gap: 6 }}>
                  <input style={{ ...envField, width: 200, ...(isDup ? { borderColor: "var(--c-r)" } : {}) }} placeholder="KEY" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} aria-invalid={isDup} />
                  <input style={{ ...envField, flex: 1 }} type={reveal ? "text" : "password"} placeholder="value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
                  <button aria-label={t("common.remove")} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X size={14} /></button>
                </div>
              );
            })}
          </div>
          {dups.length > 0 && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.envDupWarning", { keys: dups.join(", ") })}</div>}
          {invalid.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envInvalidWarning", { keys: invalid.join(", ") })}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>{t("apps.envAdd")}</Btn>
            <div style={{ flex: 1 }} />
            <Btn onClick={() => save.mutate()} disabled={save.isPending || dups.length > 0}>{t("apps.save")}</Btn>
          </div>
          {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
        </>
      )}
    </Card>
  );
}

// Edit WHERE the app's code/image comes from, after create. GIT -> repo URL + branch; IMAGE -> image ref.
// (Git credentials themselves live in the Credentials card.) Applies on the next deploy; a host change that
// resets a stored credential is reported back as a warning.
function SourceCard({ id, source, gitUrl, gitBranch, image, composePath }: { id: string; source: AppSource; gitUrl: string | null; gitBranch: string | null; image: string | null; composePath: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState(gitUrl ?? "");
  const [branch, setBranch] = useState(gitBranch ?? "");
  const [img, setImg] = useState(image ?? "");
  const [path, setPath] = useState(composePath ?? "docker-compose.yml");
  // A COMPOSE-from-git app (composePath set) edits its repo/branch/path here, like a GIT app plus the path.
  const isGitCompose = source === "COMPOSE" && composePath != null;
  const gitLike = source === "GIT" || isGitCompose;
  const dirty = gitLike
    ? url.trim() !== (gitUrl ?? "") || branch.trim() !== (gitBranch ?? "") || (isGitCompose && path.trim() !== (composePath ?? ""))
    : img.trim() !== (image ?? "");
  const save = useMutation({
    mutationFn: () =>
      gitLike
        ? api.setAppSource(id, {
            gitUrl: url.trim(),
            ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
            ...(isGitCompose && path.trim() ? { composePath: path.trim() } : {}),
          })
        : api.setAppSource(id, { image: img.trim() }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["app", id] });
      for (const w of res.warnings ?? []) toast(t(`apps.sourceWarn_${w}`), "info");
    },
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.sourceSaveFailed"), "error"),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.source")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.sourceDesc")}</p>
      {gitLike ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...envField, flex: "1 1 320px" }} placeholder={t("apps.sourceGitUrl")} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("apps.sourceGitUrl")} />
          <input style={{ ...envField, width: 180 }} placeholder={t("apps.sourceBranch")} value={branch} onChange={(e) => setBranch(e.target.value)} aria-label={t("apps.sourceBranch")} />
          {isGitCompose && (
            <input style={{ ...envField, flex: "1 1 240px" }} placeholder={t("apps.composePath")} value={path} onChange={(e) => setPath(e.target.value)} aria-label={t("apps.composePath")} />
          )}
        </div>
      ) : (
        <input style={{ ...envField, width: "100%" }} placeholder={t("apps.sourceImage")} value={img} onChange={(e) => setImg(e.target.value)} aria-label={t("apps.sourceImage")} />
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !dirty || (gitLike ? !url.trim() : !img.trim())}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.sourceRedeploy")}</div>}
    </Card>
  );
}

// Build-pack enum -> existing apps.* label key (reused from the create wizard).
const BUILD_TYPE_LABEL: Record<BuildType, string> = {
  NIXPACKS: "nixpacks",
  DOCKERFILE: "dockerfile",
  STATIC: "static",
  RAILPACK: "railpack",
  HEROKU: "heroku",
};

// Edit HOW a Git app is built, after create: the build pack and the fields that apply to it. Changing the
// pack clears the other packs' fields server-side. Applies on the next deploy.
// Monorepo base directory: trim, strip a leading "./" or "/" and a trailing "/", and map "", "." and "/"
// to null (repo root). The server stays strict; this just lets a user type a Coolify-style "/apps/api".
function normalizeBaseDir(s: string): string | null {
  let v = s.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (v === "" || v === ".") v = "";
  return v || null;
}

function BuildSettingsCard({ id, buildType, dockerfilePath, baseDirectory, buildCommand, outputDir }: { id: string; buildType: BuildType; dockerfilePath: string | null; baseDirectory: string | null; buildCommand: string | null; outputDir: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<BuildType>(buildType);
  const [dockerfile, setDockerfile] = useState(dockerfilePath ?? "");
  const [base, setBase] = useState(baseDirectory ?? "");
  const [cmd, setCmd] = useState(buildCommand ?? "");
  const [out, setOut] = useState(outputDir ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppBuild(id, {
        buildType: type,
        // Always sent (replace semantics): a monorepo base applies to every build type.
        baseDirectory: normalizeBaseDir(base),
        ...(type === "DOCKERFILE" ? { dockerfilePath: dockerfile.trim() || null } : {}),
        ...(type === "STATIC" ? { buildCommand: cmd.trim() || null, outputDir: out.trim() || null } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.buildSaveFailed"), "error"),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.buildSettings")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.buildSettingsDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 200 }} value={type} onChange={(e) => setType(e.target.value as BuildType)} aria-label={t("apps.buildSettings")}>
          {(["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"] as BuildType[]).map((v) => (
            <option key={v} value={v}>{t(`apps.${BUILD_TYPE_LABEL[v]}`)}</option>
          ))}
        </select>
        {/* Monorepo base directory — applies to every build type, so it sits before the type-specific inputs. */}
        <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.buildBaseDirectory")} value={base} onChange={(e) => setBase(e.target.value)} aria-label={t("apps.buildBaseDirectory")} />
        {type === "DOCKERFILE" && (
          <input style={{ ...envField, flex: "1 1 240px" }} placeholder={t("apps.buildDockerfilePath")} value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} aria-label={t("apps.buildDockerfilePath")} />
        )}
        {type === "STATIC" && (
          <>
            <input style={{ ...envField, flex: "1 1 240px" }} placeholder={t("apps.buildCommand")} value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label={t("apps.buildCommand")} />
            <input style={{ ...envField, width: 160 }} placeholder={t("apps.outputDir")} value={out} onChange={(e) => setOut(e.target.value)} aria-label={t("apps.outputDir")} />
          </>
        )}
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.sourceRedeploy")}</div>}
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
  const dups = duplicateKeys(rows);
  const dupSet = new Set(dups);
  const invalid = invalidKeys(rows);

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.buildArgs")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.buildArgsDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => {
          const isDup = !!r.key.trim() && dupSet.has(r.key.trim());
          return (
            <div key={i} style={{ display: "flex", gap: 6 }}>
              <input style={{ ...envField, width: 200, ...(isDup ? { borderColor: "var(--c-r)" } : {}) }} placeholder="KEY" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} aria-invalid={isDup} />
              <input style={{ ...envField, flex: 1 }} placeholder="value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
              <button aria-label={t("common.remove")} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X size={14} /></button>
            </div>
          );
        })}
      </div>
      {dups.length > 0 && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.envDupWarning", { keys: dups.join(", ") })}</div>}
      {invalid.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envInvalidWarning", { keys: invalid.join(", ") })}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>{t("apps.buildArgsAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending || dups.length > 0}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.buildArgsRedeploy")}</div>}
    </Card>
  );
}

function LimitsCard({ id, memoryMb, cpus, reserveMemoryMb, reserveCpus, gpus, deployTimeoutSec, clusterId }: { id: string; memoryMb: number | null; cpus: number | null; reserveMemoryMb: number | null; reserveCpus: number | null; gpus: string | null; deployTimeoutSec: number | null; clusterId: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [mem, setMem] = useState(memoryMb != null ? String(memoryMb) : "");
  const [cpu, setCpu] = useState(cpus != null ? String(cpus) : "");
  const [reserveMem, setReserveMem] = useState(reserveMemoryMb != null ? String(reserveMemoryMb) : "");
  const [reserveCpu, setReserveCpu] = useState(reserveCpus != null ? String(reserveCpus) : "");
  const [gpu, setGpu] = useState(gpus ?? "");
  const [timeout, setTimeoutS] = useState(deployTimeoutSec != null ? String(deployTimeoutSec) : "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppLimits(id, {
        memoryMb: mem ? Number(mem) : null,
        cpus: cpu ? Number(cpu) : null,
        // Swarm-only reservation hints; only sent for a clustered app (inputs are hidden otherwise).
        reserveMemoryMb: clusterId && reserveMem ? Number(reserveMem) : null,
        reserveCpus: clusterId && reserveCpu ? Number(reserveCpu) : null,
        gpus: gpu.trim() || null,
        deployTimeoutSec: timeout ? Number(timeout) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.limitsSaveFailed"), "error"),
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.limits")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.limitsDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...envField, width: 150 }} type="number" placeholder={t("apps.memoryMb")} value={mem} onChange={(e) => setMem(e.target.value)} />
        <input style={{ ...envField, width: 130 }} type="number" step="0.1" placeholder={t("apps.cpus")} value={cpu} onChange={(e) => setCpu(e.target.value)} />
        {clusterId && (
          <>
            <input style={{ ...envField, width: 170 }} type="number" placeholder={t("apps.reserveMemoryMb")} value={reserveMem} onChange={(e) => setReserveMem(e.target.value)} />
            <input style={{ ...envField, width: 150 }} type="number" step="0.1" placeholder={t("apps.reserveCpus")} value={reserveCpu} onChange={(e) => setReserveCpu(e.target.value)} />
          </>
        )}
        <input style={{ ...envField, width: 180 }} placeholder={t("apps.gpus")} value={gpu} onChange={(e) => setGpu(e.target.value)} />
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
    meta: { successMessage: t("apps.saved") },
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

function DeploySettingsCard({ id, deployStrategy, rollbackOnFailure }: { id: string; deployStrategy: string; rollbackOnFailure: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [strategy, setStrategy] = useState<"ROLLING" | "RECREATE">(deployStrategy === "RECREATE" ? "RECREATE" : "ROLLING");
  const [rollback, setRollback] = useState(rollbackOnFailure);
  const save = useMutation({
    mutationFn: () => api.setAppDeploySettings(id, { deployStrategy: strategy, rollbackOnFailure: rollback }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.deploySettings")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.deploySettingsDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 220 }} value={strategy} onChange={(e) => setStrategy(e.target.value as "ROLLING" | "RECREATE")} aria-label={t("apps.deployStrategy")}>
          {(["ROLLING", "RECREATE"] as const).map((v) => (
            <option key={v} value={v}>{t(`apps.deployStrategy_${v}`)}</option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx)" }}>
          <input type="checkbox" checked={rollback} onChange={(e) => setRollback(e.target.checked)} />
          {t("apps.rollbackOnFailure")}
        </label>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {!rollback && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.rollbackOnFailureDesc")}</div>}
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
    meta: { successMessage: t("apps.saved") },
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
    meta: { successMessage: t("apps.saved") },
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

function DeployHooksCard({ id, pre, post }: { id: string; pre: string | null; post: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [preVal, setPreVal] = useState(pre ?? "");
  const [postVal, setPostVal] = useState(post ?? "");
  const save = useMutation({
    mutationFn: () => api.setAppDeployHooks(id, { preDeployCommand: preVal.trim() || null, postDeployCommand: postVal.trim() || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const field: React.CSSProperties = { ...envField, width: "100%", boxSizing: "border-box", minHeight: 52, resize: "vertical" };
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.deployHooks")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.deployHooksDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("apps.preDeployCommand")}</span>
          <textarea style={field} placeholder={t("apps.preDeployPlaceholder")} value={preVal} onChange={(e) => setPreVal(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("apps.postDeployCommand")}</span>
          <textarea style={field} placeholder={t("apps.postDeployPlaceholder")} value={postVal} onChange={(e) => setPostVal(e.target.value)} />
        </label>
        <div><Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn></div>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.deployHooksRedeploy")}</div>}
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
    meta: { successMessage: t("apps.saved") },
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
    </Card>
  );
}

function HostMountsCard({ id, hostMounts }: { id: string; hostMounts: HostMount[] }) {
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
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.hostMounts")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.hostMountsDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input style={{ ...envField, flex: 1, minWidth: 150 }} placeholder={t("apps.hostMountHostPath")} value={r.hostPath} onChange={(e) => setRow(i, { hostPath: e.target.value })} />
            <span style={{ color: "var(--c-tx3)" }}>→</span>
            <input style={{ ...envField, flex: 1, minWidth: 150 }} placeholder={t("apps.hostMountContainerPath")} value={r.containerPath} onChange={(e) => setRow(i, { containerPath: e.target.value })} />
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
            <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(tk.id); }}><X size={14} /></IconBtn>
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
                  <IconBtn label={t("common.delete")} danger onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(p.id); }}><X size={14} /></IconBtn>
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

// Extra alias hostnames (served alongside the primary domain). A textarea, one host per line (also accepts
// Per-service domains (COMPOSE): route a named service on a port to its own hostname. Replace-set on save.
function ServiceDomainsCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["serviceDomains", id], queryFn: () => api.getServiceDomains(id) });
  const [rows, setRows] = useState<{ service: string; hostname: string; port: string }[]>([]);
  useEffect(() => {
    if (data) setRows(data.map((d) => ({ service: d.service, hostname: d.hostname, port: String(d.port) })));
  }, [data]);
  const setRow = (i: number, patch: Partial<{ service: string; hostname: string; port: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = useMutation({
    mutationFn: () =>
      api.setServiceDomains(id, rows.filter((r) => r.service.trim() && r.hostname.trim()).map((r) => ({ service: r.service.trim(), hostname: r.hostname.trim().toLowerCase(), port: Number(r.port) || 80 }))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["serviceDomains", id] }); qc.invalidateQueries({ queryKey: ["app", id] }); },
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.serviceDomainsSaveFailed"), "error"),
  });
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.serviceDomains")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.serviceDomainsDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input style={{ ...envField, width: 150 }} placeholder={t("apps.serviceDomainsService")} value={r.service} onChange={(e) => setRow(i, { service: e.target.value })} aria-label={t("apps.serviceDomainsService")} />
            <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.serviceDomainsHost")} value={r.hostname} onChange={(e) => setRow(i, { hostname: e.target.value })} aria-label={t("apps.serviceDomainsHost")} />
            <input style={{ ...envField, width: 90 }} type="number" placeholder={t("apps.serviceDomainsPort")} value={r.port} onChange={(e) => setRow(i, { port: e.target.value })} aria-label={t("apps.serviceDomainsPort")} />
            <button aria-label={t("common.remove")} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { service: "", hostname: "", port: "80" }])}>{t("apps.serviceDomainsAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.serviceDomainsRedeploy")}</div>}
    </Card>
  );
}

// comma/space separated); replace-set on save, applied on the next deploy.
function ExtraDomainsCard({ id, extraDomains }: { id: string; extraDomains: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(extraDomains.join("\n"));
  const parse = (s: string) => Array.from(new Set(s.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean)));
  const save = useMutation({
    mutationFn: () => api.setAppExtraDomains(id, parse(value)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.extraDomainsSaveFailed"), "error"),
  });
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.extraDomains")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.extraDomainsDesc")}</p>
      <textarea
        className="mono"
        style={{ ...envField, width: "100%", minHeight: 80, resize: "vertical" }}
        value={value}
        placeholder={t("apps.extraDomainsPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
        aria-label={t("apps.extraDomains")}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.extraDomainsRedeploy")}</div>}
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
    meta: { successMessage: t("apps.saved") },
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

// Upload an operator-supplied TLS cert for this app's domain (certType "custom"). The cert is served
// statically by Traefik (no ACME) and applied on the next deploy. The private key never comes back from
// the server — the card only shows the covered domains + expiry once a cert is stored.
function CustomCertCard({
  id,
  hasCustomCert,
  certDomains,
  certNotAfter,
}: {
  id: string;
  hasCustomCert: boolean;
  certDomains: string[];
  certNotAfter: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["app", id] });
  const upload = useMutation({
    mutationFn: () => api.setAppCert(id, cert, key),
    onSuccess: () => { setCert(""); setKey(""); invalidate(); },
    meta: { successMessage: t("apps.certUploaded") },
  });
  const clear = useMutation({
    mutationFn: () => api.clearAppCert(id),
    onSuccess: invalidate,
    meta: { successMessage: t("apps.certCleared") },
  });
  const ta: React.CSSProperties = { ...envField, width: "100%", minHeight: 88, fontFamily: "monospace", fontSize: 12, resize: "vertical" };

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.customCert")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.customCertDesc")}</p>
      {hasCustomCert && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "2px 8px" }}>
            {certDomains.length ? certDomains.join(", ") : "—"}
          </span>
          {certNotAfter && (
            <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.certExpires", { date: new Date(certNotAfter).toLocaleDateString() })}</span>
          )}
          <Btn
            variant="dangerGhost"
            disabled={clear.isPending}
            onClick={async () => { if (await confirm({ body: t("apps.certClearConfirm"), danger: true })) clear.mutate(); }}
          >
            {t("apps.certRemove")}
          </Btn>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea style={ta} placeholder={t("apps.certPemPlaceholder")} value={cert} onChange={(e) => setCert(e.target.value)} aria-label={t("apps.certPem")} spellCheck={false} autoComplete="off" />
        <textarea style={ta} placeholder={t("apps.certKeyPlaceholder")} value={key} onChange={(e) => setKey(e.target.value)} aria-label={t("apps.certKey")} spellCheck={false} autoComplete="off" />
        <div>
          <Btn onClick={() => upload.mutate()} disabled={upload.isPending || !cert.trim() || !key.trim()}>
            {hasCustomCert ? t("apps.certReplace") : t("apps.certUpload")}
          </Btn>
        </div>
      </div>
      {upload.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{(upload.error as Error).message}</div>}
      {(upload.isSuccess || clear.isSuccess) && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </Card>
  );
}

function CredentialsCard({
  id,
  source,
  gitUrl,
  composePath,
  hasGitToken,
  hasGitSshKey,
  gitSshPublicKey,
  registryUrl,
  registryUser,
}: {
  id: string;
  source: string;
  gitUrl: string | null;
  composePath: string | null;
  hasGitToken: boolean;
  hasGitSshKey: boolean;
  gitSshPublicKey: string | null;
  registryUrl: string | null;
  registryUser: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  // A GIT build OR a git-sourced COMPOSE app both clone a repo → both manage a deploy key / git token here.
  const isGit = source === "GIT" || (source === "COMPOSE" && composePath != null);
  // An ssh:// / git@ repo authenticates with a deploy key, not a token.
  const sshRepo = isGit && !!gitUrl && /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(gitUrl);
  const [gitToken, setGitToken] = useState("");
  const [url, setUrl] = useState(registryUrl ?? "");
  const [user, setUser] = useState(registryUser ?? "");
  const [token, setToken] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["app", id] });
  const save = useMutation({
    mutationFn: () =>
      api.setAppCredentials(
        id,
        isGit
          ? { gitToken: gitToken.trim() || null }
          : { registry: user.trim() && token.trim() ? { url: url.trim() || undefined, user: user.trim(), token } : null },
      ),
    onSuccess: () => { setGitToken(""); setToken(""); invalidate(); },
  });
  const genKey = useMutation({ mutationFn: () => api.generateGitSshKey(id), onSuccess: invalidate });
  const rmKey = useMutation({ mutationFn: () => api.removeGitSshKey(id), onSuccess: invalidate });

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("apps.credentials")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.credentialsDesc")}</p>
      {sshRepo ? (
        gitSshPublicKey ? (
          <div>
            <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 6px" }}>{t("apps.deployKeyHint")}</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input readOnly value={gitSshPublicKey} onFocus={(e) => e.currentTarget.select()} aria-label={t("apps.deployKey")} style={{ ...envField, flex: 1, minWidth: 200, fontFamily: "monospace", fontSize: 11 }} />
              <Btn variant="ghost" onClick={() => navigator.clipboard?.writeText(gitSshPublicKey).catch(() => {})}>{t("apps.copy")}</Btn>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Btn variant="ghost" onClick={() => genKey.mutate()} disabled={genKey.isPending}>{t("apps.deployKeyRegen")}</Btn>
              <Btn variant="dangerGhost" onClick={() => rmKey.mutate()} disabled={rmKey.isPending}>{t("apps.deployKeyRemove")}</Btn>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px" }}>{t("apps.deployKeyNone")}</p>
            <Btn onClick={() => genKey.mutate()} disabled={genKey.isPending}>{t("apps.deployKeyGenerate")}</Btn>
            {genKey.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{(genKey.error as Error).message}</div>}
          </div>
        )
      ) : isGit ? (
        <div>
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
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("apps.gitTokenHint")}</p>
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

function VolumeBackupsCard({ id, volumes, enabled, intervalHours, retention, destinationId }: { id: string; volumes: AppVolume[]; enabled: boolean; intervalHours: number | null; retention: number; destinationId: string | null }) {
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
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", flex: 1 }}>{t("apps.volBackups")}</div>
        <Btn variant="ghost" onClick={() => setShowImport((v) => !v)}>{t("apps.volImport")}</Btn>
        <Btn onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
          {backupNow.isPending ? t("databases.backingUp") : t("databases.backupNow")}
        </Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("apps.volBackupsDesc")}</p>

      {showImport && (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.volImportDesc")}</div>
          <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
            {t("apps.volImportVolume")}
            <select style={{ ...volField, width: "auto" }} value={impVol} onChange={(e) => setImpVol(e.target.value)}>
              {volumes.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </label>
          <input style={{ ...volField, width: "100%" }} placeholder="https://…/volume.tar.gz" value={impUrl} onChange={(e) => setImpUrl(e.target.value)} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={impGzip} onChange={(e) => setImpGzip(e.target.checked)} /> {t("apps.volImportGzip")}
            </label>
            <label style={{ fontSize: 12, color: "var(--c-tx3)", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={impEnc} onChange={(e) => setImpEnc(e.target.checked)} /> {t("apps.volImportEncrypted")}
            </label>
            {impEnc && <input style={{ ...volField, flex: 1, minWidth: 160 }} type="password" placeholder={t("apps.volImportKey")} value={impKey} onChange={(e) => setImpKey(e.target.value)} />}
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
              {b.destinationType === "S3" && b.status === "SUCCESS" && (
                <button onClick={() => exportUrl.mutate(b.id)} disabled={exportUrl.isPending} title={t("apps.volExportHint")} style={{ background: "transparent", border: "none", color: "var(--c-a)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {exportUrl.isPending && exportUrl.variables === b.id ? "…" : t("apps.volExportUrl")}
                </button>
              )}
              <button onClick={async () => { if (await confirm({ body: t("databases.restoreConfirm"), danger: true })) restore.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {t("databases.restore")}
              </button>
              <button aria-label={t("common.delete")} onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(b.id); }} style={{ background: "transparent", border: "none", color: "var(--c-r)", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
            </div>
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
    </Card>
  );
}
