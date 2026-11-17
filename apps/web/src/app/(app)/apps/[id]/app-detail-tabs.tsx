"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowDown, ChevronRight, CloudUpload, Lock } from "lucide-react";
import { AppCrashTimelineCard } from "../../../../components/app-crash-timeline-card";
import { AppFilesCard } from "../../../../components/app-files-card";
import { AppMetricsCard } from "../../../../components/app-metrics-card";
import { type ChartEvent } from "../../../../components/charts";
import { LiveLogsCard } from "../../../../components/live-logs-card";
import { ActivitySpinner, Btn, Card, EmptyState, SectionCard, Spinner } from "../../../../components/ui";
import { useT } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { containerListRefetchMs, friendlyContainer, pickDefaultLogContainer } from "../../../../lib/log-container";
import { deploymentColor, shortDigest } from "../../../../lib/apps";
import { LevelLog } from "../../../../components/level-log";
import { collapseCarriageReturns, summarizeDeployLog } from "../../../../lib/log-lines";
import { TERMINAL_PRE_STYLE } from "../../../../lib/terminal-theme";
import { type Application, type Deployment } from "../../../../lib/types";
import { ContainerPickerModal } from "./app-detail-misc-cards";
import { LogDrainCard } from "../../../../components/log-drains/log-drain-card";
import { ROLLOUT_KNOWN, rolloutColor } from "./app-detail-shared";
import { useChartTimes } from "../../../../lib/appearance";
import { formatDateTime } from "../../../../lib/format-time";

export function LiveContainerLogsCard({ id, isCompose, neverDeployed = false, clustered = false, appName, services }: { id: string; isCompose: boolean; neverDeployed?: boolean; clustered?: boolean; appName?: string; services?: readonly string[] }) {
  const t = useT();
  // The container the user explicitly picked; until they pick one a compose app follows its main service.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A NEW app has no container yet → nothing to follow (a stream would only relay "No such container" on every
  // reconnect). A swarm app streams the aggregated service logs, so it needs no container either. A classic
  // compose app has many containers: list them (the picker shares this query) and start on the main service
  // right away — "Pick a container" before any log appears reads as "this app has no logs".
  const perContainer = isCompose && !clustered && !neverDeployed;
  // Kept fresh: opened during a deploy/restart the list can be empty or all-exited, and must not stay that way.
  const list = useQuery({
    queryKey: ["appContainers", id],
    queryFn: () => api.listAppContainers(id),
    enabled: perContainer,
    refetchInterval: (q) => containerListRefetchMs(q.state.data?.containers),
  });
  const containers = list.data?.containers;
  const followed = useRef<string | undefined>(undefined);
  const auto = containers ? pickDefaultLogContainer(containers, { appName, services, keep: followed.current }) : undefined;
  useEffect(() => {
    followed.current = auto;
  }, [auto]);
  // An explicit pick wins, but only while that container still exists (a redeploy can rename it).
  const container = picked && (!containers || containers.some((c) => c.name === picked)) ? picked : auto;
  const active = !neverDeployed && (!perContainer || !!container);
  const emptyHint = neverDeployed
    ? t("apps.logsBeforeFirstDeploy")
    : list.isLoading
      ? t("apps.loadingContainers")
      : containers && containers.length === 0
        ? t("apps.noContainers")
        : list.isError
          ? t("apps.pickContainerToStream")
          : t("apps.loadingContainers");

  return (
    <>
      <LiveLogsCard
        basePath={`/apps/${id}`}
        container={perContainer ? container : undefined}
        active={active}
        emptyHint={emptyHint}
        headerExtra={
          perContainer ? (
            <Btn variant="ghost" onClick={() => setPickerOpen(true)} title={container}>
              {container ? friendlyContainer(container) : t("apps.selectContainer")}
            </Btn>
          ) : undefined
        }
      />
      {pickerOpen && (
        <ContainerPickerModal
          id={id}
          onClose={() => setPickerOpen(false)}
          onPick={(name) => {
            setPicked(name);
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}

export function LiveLogCard({ lines }: { lines: string }) {
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
          {collapseCarriageReturns(lines) ? <LevelLog text={collapseCarriageReturns(lines)} /> : <span style={{ color: "var(--c-term-mute)" }}>{t("apps.waitingForBuild")}</span>}
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

export function MetricsTab({ id, events }: { id: string; events: ChartEvent[] }) {
  const t = useT();
  return (
    <>
      <SectionCard title={t("apps.crash.title")} desc={t("apps.crash.desc")}>
        <AppCrashTimelineCard id={id} />
      </SectionCard>
      <AppMetricsCard id={id} events={events} />
    </>
  );
}

// The Files tab is only rendered for writers (the page gates it on `appData.canWrite`), so the write UI is enabled here.
export function FilesTab({ id, app }: { id: string; app: Pick<Application, "source" | "composeVolumes" | "volumes" | "serverId"> }) {
  const t = useT();
  return (
    <SectionCard title={t("apps.files.title")} desc={t("apps.files.desc")}>
      <AppFilesCard
        id={id}
        canWrite
        serverId={app.serverId}
        volumes={
          app.source === "COMPOSE"
            ? app.composeVolumes
                .filter((v) => v.browsable)
                .map((v) => ({ name: v.key, path: v.mounts.map((m) => `${m.service}:${m.path}`).join(", ") || v.key }))
            : app.volumes
        }
      />
    </SectionCard>
  );
}

export function LogsTab({ id, canWrite, isCompose, clustered = false, neverDeployed, streamActive, liveLines, lastDeployLog, appName, services }: { id: string; canWrite: boolean; isCompose: boolean; clustered?: boolean; appName?: string; services?: readonly string[]; neverDeployed: boolean; streamActive: boolean; liveLines: string; lastDeployLog: string | null | undefined }) {
  const t = useT();
  return (
    <>
      {/* During a deploy the BUILD log belongs up top; runtime container logs sit below it. */}
      {streamActive && <LiveLogCard lines={liveLines} />}
      {canWrite && <LiveContainerLogsCard id={id} isCompose={isCompose} neverDeployed={neverDeployed} clustered={clustered} appName={appName} services={services} />}
      {canWrite && <LogDrainCard scope={{ kind: "app", id, isCompose, clustered }} />}
      {!streamActive &&
        (lastDeployLog ? (
          <SectionCard title={t("apps.lastDeployLog")} style={{ marginBottom: 0 }}>
            <pre className="mono" style={{ ...TERMINAL_PRE_STYLE, maxHeight: 420 }}><LevelLog text={collapseCarriageReturns(lastDeployLog)} /></pre>
          </SectionCard>
        ) : (
          !canWrite && <Card style={{ padding: 16 }}><EmptyState>{t("apps.noLogs")}</EmptyState></Card>
        ))}
    </>
  );
}

export function DeploymentsTab({
  app,
  deployments,
  cancelPending,
  deployPending,
  onDeploy,
  onCancel,
}: {
  app: Application;
  deployments: Deployment[];
  cancelPending: boolean;
  deployPending: boolean;
  onDeploy: () => void;
  onCancel: (id: string) => void;
}) {
  const t = useT();
  const chartTimes = useChartTimes();
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {deployments.map((d) => {
          // Rollout state is hub-parsed (`rollout`); fall back to parsing the log for an older hub that still
          // ships logs in the list.
          const rollout = d.rollout ?? (d.logs ? summarizeDeployLog(d.logs).rollout : null);
          // A QUEUED deploy hasn't started; a RUNNING one is cancelled by killing its build on the
          // agent. Offer Cancel for both. The button sits OUTSIDE the drill-in row link (no nesting).
          const cancellable = (d.status === "QUEUED" || d.status === "RUNNING") && app.canWrite;
          // The whole row is a LINK into the deployment's own page (deep-linkable, lazy-loaded full log).
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
            <Link
              href={`/apps/${app.id}/deployments/${d.id}`}
              className="dep-row"
              style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flex: 1, minWidth: 0, textAlign: "left", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", textDecoration: "none", transition: "background .12s, border-color .12s" }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: deploymentColor(d.status), display: "inline-flex", alignItems: "center", gap: 6 }}>
                {(d.status === "RUNNING" || d.status === "QUEUED") && <ActivitySpinner size={11} />}
                {d.status}
              </span>
              {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
              {rollout && (
                <span style={{ fontSize: 11, fontWeight: 700, color: rolloutColor(rollout), border: `1px solid ${rolloutColor(rollout)}`, borderRadius: "999px", padding: "1px 7px", letterSpacing: "0.02em" }}>
                  {ROLLOUT_KNOWN.has(rollout) ? t(`apps.rollout_${rollout}`) : rollout}
                </span>
              )}
              {d.registryImage && <span title={d.registryImage} style={{ display: "inline-flex", alignItems: "center", color: "var(--c-tx3)" }}><CloudUpload size={12} aria-hidden /></span>}
              {d.imageDigest && (
                <span title={d.imageDigest} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--c-tx3)" }}>
                  <Lock size={11} aria-hidden /> {shortDigest(d.imageDigest)}
                </span>
              )}
              {d.exitCode != null && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.exit", { code: d.exitCode })}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{formatDateTime(d.createdAt, chartTimes)}</span>
              <ChevronRight size={15} aria-hidden style={{ color: "var(--c-tx3)", flexShrink: 0 }} />
            </Link>
            {cancellable && (
              <button
                type="button"
                onClick={() => onCancel(d.id)}
                disabled={cancelPending}
                style={{ flexShrink: 0, border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", background: "transparent", color: "var(--c-r)", fontSize: 12, cursor: "pointer", padding: "0 14px", font: "inherit" }}
              >
                {t("apps.cancel")}
              </button>
            )}
            </div>
          );
        })}
        {deployments.length === 0 && (
          <EmptyState action={app.canWrite ? <Btn onClick={() => onDeploy()} disabled={deployPending}>{t("apps.deploy")}</Btn> : undefined}>
            {t("apps.noDeployments")}
          </EmptyState>
        )}
      </div>
    </Card>
  );
}
