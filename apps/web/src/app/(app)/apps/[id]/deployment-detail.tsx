"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowDown, ExternalLink, Lock } from "lucide-react";
import { useToast } from "../../../../components/toast";
import { Btn, Card } from "../../../../components/ui";
import { useT } from "../../../../i18n/provider";
import { deploymentColor, shortDigest } from "../../../../lib/apps";
import { buildTimeline } from "../../../../lib/deployment-timeline";
import { relativeTime } from "../../../../lib/fleet";
import { gitWebUrls } from "../../../../lib/git-web-url";
import { collapseCarriageReturns, summarizeDeployLog } from "../../../../lib/log-lines";
import { TERMINAL_PRE_STYLE } from "../../../../lib/terminal-theme";
import type { Application, DeploymentDetail } from "../../../../lib/types";
import { ROLLOUT_KNOWN, TRIGGER_KNOWN, formatDuration, rolloutColor } from "./app-detail-shared";

const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", marginBottom: 3 };
const chip = (color: string): React.CSSProperties => ({ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: "999px", padding: "1px 7px", letterSpacing: "0.02em" });

/**
 * The deployment DETAIL view (Coolify/Dokploy pattern), presentational: status + notes, the queued → started →
 * finished timeline, who/what/where facts, the config diff against the nearest older snapshot, and the full
 * build log in a dark terminal pane — live-following while the deploy is RUNNING, persisted afterwards.
 * Actions (cancel / rollback / analyze) are callbacks; the page owns the mutations and confirmations.
 */
export function DeploymentDetailView({
  app,
  d,
  live,
  aiResult,
  pending,
  onCancel,
  onRollback,
  onAnalyze,
}: {
  app: Pick<Application, "canWrite" | "gitUrl">;
  d: DeploymentDetail;
  /** Live SSE state while the row is RUNNING (lines accumulate; done flips when the deploy settles; ended = the
   *  stream closed with nothing to follow). */
  live: { lines: string; done: boolean; ended?: boolean } | null;
  aiResult?: string;
  pending: { cancel: boolean; rollback: boolean; analyze: boolean };
  onCancel: () => void;
  onRollback: () => void;
  onAnalyze: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const timeline = buildTimeline(d);
  const links = gitWebUrls(app.gitUrl, d.commitSha);
  const isLive = d.status === "RUNNING" && !!live && !live.done && !live.ended;
  // RUNNING on the hub, but nothing to follow here: the command runs on the agent and the hub (restarted / recovering)
  // has no live buffer for it — the full log lands when the deploy settles.
  const liveUnavailable = d.status === "RUNNING" && (!live || live.ended === true);
  // Persisted log once terminal; the live buffer while running (the hub keeps the last 64 KiB).
  const rawSource = isLive ? live!.lines : (d.logs ?? (live?.lines || ""));
  const sum = rawSource ? summarizeDeployLog(rawSource) : null;
  const rawLog = collapseCarriageReturns(rawSource);
  const hasCleaned = !!(sum && sum.stripped && sum.body);
  const [cleaned, setCleaned] = useState(false);
  const shown = cleaned && hasCleaned ? sum!.body : rawLog;
  const lineCount = shown ? shown.split("\n").length : 0;

  // Follow the newest output while live, but stop snapping once the operator scrolls up; offer "Jump to latest".
  const pre = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    if (isLive && following && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown, isLive, following]);
  const onScroll = () => {
    const el = pre.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      toast(t("apps.copied"), "success");
    } catch {
      toast(t("common.copyFailed"), "error");
    }
  };

  const actorText =
    d.actor.kind === "user" ? (d.actor.name ? t("apps.depActor_user", { name: d.actor.name }) : t("apps.depActor_user_unknown")) : t(`apps.depActor_${d.actor.kind}`);
  const facts: { label: string; node: ReactNode }[] = [
    { label: t("apps.trigger"), node: d.trigger ? (TRIGGER_KNOWN.has(d.trigger) ? t(`apps.trigger_${d.trigger}`) : d.trigger) : t(`apps.kind_${d.kind}`) },
    { label: t("apps.depActor"), node: actorText },
    ...(d.durationMs != null ? [{ label: t("apps.durationLabel"), node: formatDuration(d.durationMs) }] : []),
    ...(d.registryImage || d.imageTag ? [{ label: t("apps.imageLabel"), node: <span className="mono" style={{ wordBreak: "break-all" }}>{d.registryImage ?? d.imageTag}</span> }] : []),
    ...(d.imageDigest ? [{ label: t("apps.digestLabel"), node: <span className="mono" title={d.imageDigest} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Lock size={11} aria-hidden /> {shortDigest(d.imageDigest)}</span> }] : []),
    ...(d.commitSha
      ? [{
          label: t("apps.commitLabel"),
          node: (
            <span style={{ wordBreak: "break-word", display: "inline-flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              {links.commit ? (
                <a href={links.commit} target="_blank" rel="noreferrer noopener" className="mono tg-link" title={t("apps.depOpenCommit")}>{d.commitSha.slice(0, 7)} <ExternalLink size={11} aria-hidden style={{ verticalAlign: "-1px" }} /></a>
              ) : (
                <span className="mono">{d.commitSha.slice(0, 7)}</span>
              )}
              {d.commitMessage && <span>{d.commitMessage}</span>}
            </span>
          ),
        }]
      : []),
    ...(d.exitCode != null ? [{ label: t("apps.exitLabel"), node: <span className="mono">{d.exitCode}</span> }] : []),
    ...(d.noCache ? [{ label: t("apps.noCacheLabel"), node: t("apps.noCacheOff") }] : []),
  ];

  const stepLabel = (k: string) => t(`apps.dep${k.charAt(0).toUpperCase()}${k.slice(1)}`);
  return (
    <Card style={{ padding: 16 }}>
      {/* Header: status, kind, rollout, current-version badge, actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: deploymentColor(d.status) }}>{d.status}</span>
        {d.kind && d.kind !== "DEPLOY" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t(`apps.kind_${d.kind}`)}</span>}
        {d.rollout && <span style={chip(rolloutColor(d.rollout))}>{ROLLOUT_KNOWN.has(d.rollout) ? t(`apps.rollout_${d.rollout}`) : d.rollout}</span>}
        {d.isCurrent && <span style={chip("var(--c-g)")}>{t("apps.depCurrentVersion")}</span>}
        <span style={{ flex: 1 }} />
        {d.cancellable && app.canWrite && (
          <Btn variant="ghost" onClick={onCancel} disabled={pending.cancel} style={{ color: "var(--c-r)" }}>{t("apps.depCancelRunning")}</Btn>
        )}
        {app.canWrite && d.rollbackable && !d.isCurrent && (
          <Btn variant="ghost" onClick={onRollback} disabled={pending.rollback}>{t("apps.depRollbackHere")}</Btn>
        )}
        {d.status === "FAILED" && app.canWrite && (
          <Btn variant="ghost" onClick={onAnalyze} disabled={pending.analyze}>{pending.analyze ? t("apps.analyzing") : t("apps.analyzeAi")}</Btn>
        )}
      </div>

      {d.note && (
        <div role="status" style={{ marginBottom: 12, padding: "10px 12px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-el)", fontSize: 12, color: d.note === "interrupted" ? "var(--c-r)" : d.note === "auto_rollback" ? "var(--c-am)" : "var(--c-tx2)" }}>
          {t(`apps.depNote_${d.note}`)}
        </div>
      )}

      {/* Timeline strip */}
      <div style={{ marginBottom: 14 }}>
        <div style={label}>{t("apps.depTimeline")}</div>
        <ol style={{ display: "flex", gap: 0, listStyle: "none", margin: 0, padding: 0, flexWrap: "wrap" }} aria-label={t("apps.depTimeline")}>
          {timeline.steps.map((s, i) => {
            const color = s.state === "done" ? "var(--c-g)" : s.state === "active" ? "var(--c-lapis)" : "var(--c-tx3)";
            return (
              <li key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, padding: "6px 0" }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: s.state === "pending" || s.state === "skipped" ? "transparent" : color, border: `2px solid ${color}`, flexShrink: 0 }} />
                <div style={{ fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: "var(--c-tx)" }}>{stepLabel(s.key)}</div>
                  <div style={{ color: "var(--c-tx3)" }} title={s.at ? new Date(s.at).toLocaleString() : undefined}>
                    {s.at ? `${new Date(s.at).toLocaleTimeString()} · ${relativeTime(s.at)}` : t(`apps.depStep${s.state === "active" ? "Active" : s.state === "skipped" ? "Skipped" : "Pending"}`)}
                  </div>
                </div>
                {i < timeline.steps.length - 1 && <span aria-hidden style={{ flex: 1, minWidth: 16, height: 2, background: "var(--c-bd)", margin: "0 10px" }} />}
              </li>
            );
          })}
        </ol>
        {(timeline.queueWaitMs != null || timeline.runMs != null) && (
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>
            {[timeline.queueWaitMs != null ? t("apps.depQueueWait", { dur: formatDuration(timeline.queueWaitMs) }) : null, timeline.runMs != null ? t("apps.depRunTime", { dur: formatDuration(timeline.runMs) }) : null].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>

      {/* Facts grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))", gap: 14, paddingBottom: 14, marginBottom: 14, borderBottom: "1px solid var(--c-bd)" }}>
        {facts.map((f) => (
          <div key={f.label}>
            <div style={label}>{f.label}</div>
            <div style={{ fontSize: 13, color: "var(--c-tx)" }}>{f.node}</div>
          </div>
        ))}
      </div>

      {/* Config diff */}
      <div style={{ marginBottom: 14 }}>
        <div style={label}>{t("apps.configChanges", { count: d.configChanges?.length ?? 0 })}</div>
        {d.diffBase && <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6 }}>{t("apps.depConfigDiffBase", { when: new Date(d.diffBase.createdAt).toLocaleString() })}</div>}
        {!d.diffBase ? (
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.depConfigNoBase")}</div>
        ) : !d.configChanges || d.configChanges.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.depConfigUnchanged")}</div>
        ) : (
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
        )}
      </div>

      {aiResult && (
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-a)", marginBottom: 4 }}>{t("apps.aiAnalysis")}</div>
          <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--c-tx2)", whiteSpace: "pre-wrap" }}>{aiResult}</pre>
        </div>
      )}

      {/* Log pane */}
      <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", background: "var(--c-el)", borderBottom: "1px solid var(--c-bd)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx2)" }}>{t("apps.buildLog")}</span>
          {isLive && <span style={{ fontSize: 11, color: "var(--c-lapis)" }} aria-live="polite">● {t("apps.depLiveFollowing")}</span>}
          {liveUnavailable && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.depLiveUnavailable")}</span>}
          {shown && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.logLines", { n: lineCount })}</span>}
          <span style={{ flex: 1 }} />
          {hasCleaned && (
            <div style={{ display: "inline-flex", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden" }}>
              {([{ k: false, label: t("apps.viewRaw") }, { k: true, label: t("apps.viewCleaned") }] as const).map((o) => (
                <button key={String(o.k)} type="button" onClick={() => setCleaned(o.k)} aria-pressed={cleaned === o.k} style={{ background: cleaned === o.k ? "var(--c-lapis-fill)" : "transparent", color: cleaned === o.k ? "var(--c-on-lapis)" : "var(--c-tx3)", border: "none", font: "inherit", fontSize: 11, padding: "2px 10px", cursor: "pointer" }}>{o.label}</button>
              ))}
            </div>
          )}
          <button type="button" onClick={copy} disabled={!shown} style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx2)", font: "inherit", fontSize: 11, padding: "2px 10px", cursor: shown ? "pointer" : "default" }}>{t("apps.copy")}</button>
        </div>
        <pre ref={pre} onScroll={onScroll} tabIndex={0} role="region" aria-label={t("apps.buildLog")} className="mono" style={{ ...TERMINAL_PRE_STYLE, borderRadius: 0, minHeight: 300, maxHeight: "62vh", overflow: "auto" }}>
          {shown || <span style={{ color: "var(--c-term-mute)" }}>{isLive || d.status === "QUEUED" ? t("apps.depLogPending") : liveUnavailable ? t("apps.depLiveUnavailable") : t("apps.noBuildOutput")}</span>}
        </pre>
        {isLive && !following && (
          <button type="button" onClick={() => { setFollowing(true); if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }} style={{ position: "absolute", right: 14, bottom: 14, display: "inline-flex", alignItems: "center", gap: 6, background: "var(--c-lapis-fill)", color: "var(--c-on-lapis)", border: "none", borderRadius: "999px", padding: "5px 12px", font: "inherit", fontSize: 11, cursor: "pointer" }}>
            <ArrowDown size={12} aria-hidden /> {t("apps.depJumpToLatest")}
          </button>
        )}
        {isLive && <div style={{ fontSize: 11, color: "var(--c-tx3)", padding: "6px 12px", borderTop: "1px solid var(--c-bd)" }}>{t("apps.depLiveTruncated")}</div>}
      </div>
    </Card>
  );
}
