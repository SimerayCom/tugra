"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ChevronRight, CloudUpload, Lock } from "lucide-react";
import { AppCrashTimelineCard } from "../../../../components/app-crash-timeline-card";
import { AppFilesCard } from "../../../../components/app-files-card";
import { AppMetricsCard } from "../../../../components/app-metrics-card";
import { type ChartEvent } from "../../../../components/charts";
import { LiveLogsCard } from "../../../../components/live-logs-card";
import { Btn, Card, EmptyState, SectionCard, Spinner } from "../../../../components/ui";
import { useT } from "../../../../i18n/provider";
import { deploymentColor, shortDigest } from "../../../../lib/apps";
import { collapseCarriageReturns, summarizeDeployLog } from "../../../../lib/log-lines";
import { TERMINAL_PRE_STYLE } from "../../../../lib/terminal-theme";
import { type Application, type Deployment } from "../../../../lib/types";
import { ContainerPickerModal } from "./app-detail-misc-cards";
import { ROLLOUT_KNOWN, rolloutColor } from "./app-detail-shared";

export function LiveContainerLogsCard({ id, isCompose }: { id: string; isCompose: boolean }) {
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
          {collapseCarriageReturns(lines) || <span style={{ color: "var(--c-term-mute)" }}>{t("apps.waitingForBuild")}</span>}
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

export function FilesTab({ id, app }: { id: string; app: Pick<Application, "source" | "composeVolumes" | "volumes"> }) {
  const t = useT();
  return (
    <SectionCard title={t("apps.files.title")} desc={t("apps.files.desc")}>
      <AppFilesCard
        id={id}
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

export function LogsTab({ id, canWrite, isCompose, streamActive, liveLines, lastDeployLog }: { id: string; canWrite: boolean; isCompose: boolean; streamActive: boolean; liveLines: string; lastDeployLog: string | null | undefined }) {
  const t = useT();
  return (
    <>
      {/* During a deploy the BUILD log belongs up top; runtime container logs sit below it. */}
      {streamActive && <LiveLogCard lines={liveLines} />}
      {canWrite && <LiveContainerLogsCard id={id} isCompose={isCompose} />}
      {!streamActive &&
        (lastDeployLog ? (
          <SectionCard title={t("apps.lastDeployLog")} style={{ marginBottom: 0 }}>
            <pre className="mono" style={{ ...TERMINAL_PRE_STYLE, maxHeight: 420 }}>{collapseCarriageReturns(lastDeployLog)}</pre>
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
              <span style={{ fontSize: 11, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
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
              <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{new Date(d.createdAt).toLocaleString()}</span>
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
