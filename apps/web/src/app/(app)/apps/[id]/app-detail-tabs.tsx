"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowDown, ChevronRight, CloudUpload, Lock } from "lucide-react";
import { AppCrashTimelineCard } from "../../../../components/app-crash-timeline-card";
import { AppFilesCard } from "../../../../components/app-files-card";
import { AppMetricsCard } from "../../../../components/app-metrics-card";
import { type ChartEvent } from "../../../../components/charts";
import { LiveLogsCard } from "../../../../components/live-logs-card";
import { useToast } from "../../../../components/toast";
import { Btn, Card, EmptyState, SectionCard, Spinner } from "../../../../components/ui";
import { useT } from "../../../../i18n/provider";
import { deploymentColor, shortDigest } from "../../../../lib/apps";
import { relativeTime } from "../../../../lib/fleet";
import { collapseCarriageReturns, summarizeDeployLog } from "../../../../lib/log-lines";
import { TERMINAL_PRE_STYLE } from "../../../../lib/terminal-theme";
import { type Application, type Deployment } from "../../../../lib/types";
import { ContainerPickerModal } from "./app-detail-misc-cards";
import { ROLLOUT_KNOWN, TRIGGER_KNOWN, formatDuration, rolloutColor } from "./app-detail-shared";

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

/** Deployment drill-in (Coolify/Dokploy pattern): clicking a row in the Deployments list ENTERS the
 *  deployment and its full build log fills a proper dark terminal panel here — instead of being crammed
 *  into a tiny inline <details> expander. Metadata, rollback/analyze actions and config changes sit above. */
export function DeploymentDetail({
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
        {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
        {sum?.rollout && (
          <span style={{ fontSize: 11, fontWeight: 700, color: rolloutColor(sum.rollout), border: `1px solid ${rolloutColor(sum.rollout)}`, borderRadius: "999px", padding: "1px 7px", letterSpacing: "0.02em" }}>
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
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 }}>{s.label}</div>
            <div style={{ fontSize: 13, color: "var(--c-tx)" }}>{s.node}</div>
          </div>
        ))}
      </div>

      {d.configChanges && d.configChanges.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 6 }}>{t("apps.configChanges", { count: d.configChanges.length })}</div>
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
          {shown || <span style={{ color: "var(--c-term-mute)" }}>{t("apps.noBuildOutput")}</span>}
        </pre>
      </div>
    </Card>
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
  selDep,
  setSelDep,
  aiResults,
  analyzePendingFor,
  rollbackPending,
  cancelPending,
  deployPending,
  onDeploy,
  onRollback,
  onAnalyze,
  onCancel,
}: {
  app: Application;
  deployments: Deployment[];
  selDep: string | null;
  setSelDep: (id: string | null) => void;
  aiResults: Record<string, string>;
  /** The deployment id an AI analysis is currently running for (undefined when none is pending). */
  analyzePendingFor: string | undefined;
  rollbackPending: boolean;
  cancelPending: boolean;
  deployPending: boolean;
  onDeploy: () => void;
  onRollback: (id: string) => void | Promise<void>;
  onAnalyze: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const t = useT();
  // Current version = latest SUCCESS; a deploy is rollbackable when its artifact is retained
  // (image tag / registry image, or — for compose apps — the compose YAML snapshot) and isn't current.
  const latestSuccessId = deployments.find((x) => x.status === "SUCCESS")?.id;
  const selDepObj = selDep ? deployments.find((x) => x.id === selDep) ?? null : null;
  if (selDepObj) {
    return (
      <DeploymentDetail
        app={app}
        deployment={selDepObj}
        canRollback={app.canWrite && selDepObj.rollbackable && selDepObj.id !== latestSuccessId}
        aiResult={aiResults[selDepObj.id]}
        analyzePending={analyzePendingFor === selDepObj.id}
        rollbackPending={rollbackPending}
        onBack={() => setSelDep(null)}
        onRollback={onRollback}
        onAnalyze={onAnalyze}
      />
    );
  }
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {deployments.map((d) => {
          const sum = d.logs ? summarizeDeployLog(d.logs) : null;
          // A QUEUED deploy hasn't started; a RUNNING one is cancelled by killing its build on the
          // agent. Offer Cancel for both. The button sits OUTSIDE the drill-in row button (no nesting).
          const cancellable = (d.status === "QUEUED" || d.status === "RUNNING") && app.canWrite;
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
              {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
              {sum?.rollout && (
                <span style={{ fontSize: 11, fontWeight: 700, color: rolloutColor(sum.rollout), border: `1px solid ${rolloutColor(sum.rollout)}`, borderRadius: "999px", padding: "1px 7px", letterSpacing: "0.02em" }}>
                  {ROLLOUT_KNOWN.has(sum.rollout) ? t(`apps.rollout_${sum.rollout}`) : sum.rollout}
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
            </button>
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
