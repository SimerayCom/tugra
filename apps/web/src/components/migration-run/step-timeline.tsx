"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import { useT } from "../../i18n/provider";
import { Badge, SectionCard } from "../ui";
import { MeterBar } from "../meter-bar";
import { relativeTime } from "../../lib/fleet";
import { formatDuration } from "../../lib/import";
import {
  DRY_KEY,
  ROLLBACK_KEY,
  STEP_DESC_KEY,
  STEP_KIND_KEY,
  STEP_TITLE_KEY,
  codeText,
  dryRunItemsSorted,
  evidenceCounts,
  progressPct,
  progressText,
  stepStatusColor,
  visibleSteps,
} from "../../lib/migration-run";
import type { MigrationRunStepView, MigrationRunView } from "../../lib/types";
import { EvidenceBadge, StepStatusBadge, StepStatusMark } from "./badges";
import { GateChecks } from "./gate-checks";

const DRY_COLOR = { block: "var(--c-r)", unknown: "var(--c-am)", warn: "var(--c-am)", info: "var(--c-tx3)" } as const;

const isAttention = (s: MigrationRunStepView) => s.status === "FAILED" || s.status === "RUNNING" || s.status.startsWith("WAITING");

function durationSec(s: MigrationRunStepView): number | null {
  if (!s.startedAt || !s.finishedAt) return null;
  const d = (new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function StepBody({ step }: { step: MigrationRunStepView }) {
  const t = useT();
  const pct = progressPct(step.progress);
  const checks = step.gate?.checks ?? [];
  const dry = dryRunItemsSorted(step.progress);
  const trusted = evidenceCounts(step.gate);
  const trustedAny = trusted["hub-verified"] + trusted["migrator-reported"] + trusted["operator-attested"] > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "0 0 4px" }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t(STEP_DESC_KEY[step.key])}</p>
      {step.skippedCode && <div style={{ fontSize: 13 }}>{t("migrationRun.step.skipped", { why: codeText(t, step.skippedCode) })}</div>}
      {step.lastError && <div role="alert" style={{ fontSize: 13, color: "var(--c-r)", wordBreak: "break-word" }}>{codeText(t, step.lastError)}</div>}
      {step.progress && step.progress.total > 0 && (
        <div>
          <MeterBar value={pct} text={pct === null ? "" : `${pct}%`} grow label={t(STEP_TITLE_KEY[step.key])} />
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>
            {progressText(t, step.progress)}
            {step.progress.etaSec != null && step.status === "RUNNING" && <> · {t("migrationRun.step.eta", { time: formatDuration(step.progress.etaSec) ?? "-" })}</>}
          </div>
        </div>
      )}
      {checks.length > 0 && (
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("migrationRun.step.gate")}</span>
            {trustedAny && (
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                {(["hub-verified", "migrator-reported", "operator-attested"] as const).filter((k) => trusted[k] > 0).map((k) => (
                  <span key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11, color: "var(--c-tx3)" }}>
                    <EvidenceBadge kind={k} /> {trusted[k]}
                  </span>
                ))}
              </span>
            )}
          </div>
          <GateChecks checks={checks} />
        </div>
      )}
      {dry.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{t("migrationRun.step.dryRun")}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
            {dry.map((d, i) => (
              <li key={`${d.code}:${d.subject ?? ""}:${i}`} style={{ fontSize: 13, display: "flex", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: DRY_COLOR[d.level], minWidth: 56, flexShrink: 0 }}>{t(DRY_KEY[d.level])}</span>
                <span style={{ wordBreak: "break-word" }}>
                  {codeText(t, d.code, d.params)}
                  {d.subject && <span className="mono" style={{ color: "var(--c-tx3)", fontSize: 11 }}> {d.subject}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {step.approval && (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>
          {t("migrationRun.step.approvedAt", { when: relativeTime(step.approval.at) })}
          {step.approval.expiresAt && <> · {t("migrationRun.step.approvalExpiresAt", { when: new Date(step.approval.expiresAt).toLocaleString() })}</>}
        </div>
      )}
      {step.evidence.attestations.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.step.attestations", { n: step.evidence.attestations.length })}</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--c-tx3)" }}>
        <Badge>{t(STEP_KIND_KEY[step.kind])}</Badge>
        <Badge tone={step.rollbackClass === "LOSSY_AFTER_PONR" ? "danger" : step.rollbackClass === "IRREVERSIBLE" ? "warn" : "muted"}>{t(ROLLBACK_KEY[step.rollbackClass])}</Badge>
        {step.attempt > 1 && <span>{t("migrationRun.step.attempt", { n: step.attempt })}</span>}
        {step.startedAt && <span>{t("migrationRun.step.started", { when: relativeTime(step.startedAt) })}</span>}
        {durationSec(step) !== null && <span>{t("migrationRun.step.took", { time: formatDuration(durationSec(step)) ?? "-" })}</span>}
      </div>
    </div>
  );
}

function StepRow({ step, index, current }: { step: MigrationRunStepView; index: number; current: boolean }) {
  const t = useT();
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (isAttention(step) || current);
  const panelId = `mr-step-${step.key}`;
  return (
    <li id={`step-${step.key}`} style={{ borderTop: index === 0 ? "none" : "1px solid var(--c-bd)", listStyle: "none" }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setOpen(!expanded)}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 48, padding: "10px 4px", background: "transparent", border: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer", flexWrap: "wrap" }}
      >
        <StepStatusMark status={step.status} size={18} />
        <span style={{ fontSize: 14, fontWeight: current ? 700 : 600, flex: "1 1 160px", minWidth: 0, wordBreak: "break-word", color: step.status === "PENDING" || step.status === "SKIPPED" ? "var(--c-tx2)" : "var(--c-tx)" }}>
          <span className="mono" style={{ color: "var(--c-tx3)", fontSize: 11, marginRight: 8 }}>{String(index + 1).padStart(2, "0")}</span>
          {t(STEP_TITLE_KEY[step.key])}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: stepStatusColor(step.status) }}>
            <StepStatusBadge status={step.status} />
          </span>
          {expanded ? <ChevronDown size={15} aria-hidden color="var(--c-tx3)" /> : <ChevronRight size={15} aria-hidden color="var(--c-tx3)" />}
        </span>
      </button>
      {expanded && (
        <div id={panelId} style={{ padding: "0 4px 14px 32px" }}>
          <StepBody step={step} />
        </div>
      )}
    </li>
  );
}

/** The step timeline: every step with its state, gate, progress and dry-run projection. The point of no return is
 *  drawn as a divider before the step that crosses it, and turns solid once it was reached. */
export function StepTimeline({ run }: { run: MigrationRunView }) {
  const t = useT();
  const steps = visibleSteps(run);
  return (
    <SectionCard title={t("migrationRun.timeline.title")} style={{ marginBottom: 0 }}>
      <ol aria-label={t("migrationRun.timeline.title")} style={{ margin: 0, padding: 0 }}>
        {steps.map((s, i) => (
          <Fragment key={s.key}>
            {s.key === "CUTOVER" && (
              <li style={{ listStyle: "none", display: "flex", alignItems: "center", gap: 8, padding: "8px 0", color: run.ponrAt ? "var(--c-r)" : "var(--c-tx3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <ShieldAlert size={13} aria-hidden />
                <span style={{ flex: 1, borderTop: `1px ${run.ponrAt ? "solid" : "dashed"} currentColor`, height: 0 }} />
                <span>{run.ponrAt ? t("migrationRun.timeline.ponrReached") : t("migrationRun.timeline.ponrAhead")}</span>
                <span style={{ flex: 1, borderTop: `1px ${run.ponrAt ? "solid" : "dashed"} currentColor`, height: 0 }} />
              </li>
            )}
            <StepRow step={s} index={i} current={run.currentStep === s.key} />
          </Fragment>
        ))}
      </ol>
    </SectionCard>
  );
}
