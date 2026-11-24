"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, LinkBtn, SectionCard } from "../ui";
import { formatBytes, formatDuration } from "../../lib/import";
import { ROLLBACK_PATH_KEY, blockerSpec, canAccept, decisionOf, isAckableKey, warningSpec, type DecisionIssue, type WarningFix } from "../../lib/dry-run-decision";
import { codeText, paramVars } from "../../lib/migration-run";
import type { MigrationRunSafetyHints, MigrationRunView } from "../../lib/types";
import { useStartRun } from "./run-actions";
import { runHintsKey, useRunPlumbing } from "./use-run-actions";

const SHOWN_SUBJECTS = 5;
const heading: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" };

/** "a, b, c +2": the subjects of an issue, cut so a long list never floods the screen. */
function subjectsText(subjects: string[]): string {
  const head = subjects.slice(0, SHOWN_SUBJECTS).join(", ");
  return subjects.length > SHOWN_SUBJECTS ? `${head} +${subjects.length - SHOWN_SUBJECTS}` : head;
}

function FixLink({ fix, onOpenSafety }: { fix: WarningFix; onOpenSafety?: () => void }) {
  const t = useT();
  if (fix.kind === "safety") {
    // the pin field lives in the run's Details; without a way to open them the fix is not offered
    return onOpenSafety ? (
      <Btn variant="ghost" onClick={onOpenSafety}>
        {t(fix.labelKey)}
      </Btn>
    ) : null;
  }
  return (
    <LinkBtn href={fix.href} variant="ghost">
      {t(fix.labelKey)}
    </LinkBtn>
  );
}

/** One warning: a sentence, what accepting means behind "More", and the actions the registry knows (a fix, accept and continue). */
function WarningRow({ issue, accepted, busy, onToggle, onOpenSafety }: { issue: DecisionIssue; accepted: boolean; busy: boolean; onToggle: (accept: boolean) => void; onOpenSafety?: () => void }) {
  const t = useT();
  const spec = warningSpec(issue.key);
  const items = issue.params?.items;
  const names = Array.isArray(items) && items.length > 0 ? items.map(String) : issue.subjects;
  const title = spec.titleKey ? t(spec.titleKey, { ...paramVars(issue.params), count: typeof issue.params?.count === "number" ? issue.params.count : issue.count, items: subjectsText(names) }) : codeText(t, issue.code, issue.params);
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0", borderTop: "1px solid var(--c-bd)", listStyle: "none" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {accepted ? <CheckCircle2 size={16} aria-hidden color="var(--c-g)" style={{ flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={16} aria-hidden color="var(--c-am)" style={{ flexShrink: 0, marginTop: 2 }} />}
        <div style={{ minWidth: 0, fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>
          {title}
          {accepted && <span style={{ color: "var(--c-tx3)" }}> {t("migrationRun.decision.acceptedTag")}</span>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingLeft: 26 }}>
        {!accepted && spec.fix && <FixLink fix={spec.fix} onOpenSafety={onOpenSafety} />}
        {canAccept(issue.key) && (
          <Btn variant="ghost" disabled={busy} onClick={() => onToggle(!accepted)} aria-label={t(accepted ? "migrationRun.decision.undoAria" : "migrationRun.decision.acceptAria", { what: title })}>
            {accepted ? t("migrationRun.decision.undo") : t("migrationRun.decision.accept")}
          </Btn>
        )}
        {!accepted && !canAccept(issue.key) && <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t(isAckableKey(issue.key) ? "migrationRun.decision.mustFix" : "migrationRun.decision.noDecision")}</span>}
      </div>
      <details style={{ paddingLeft: 26 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)", minHeight: 44, display: "flex", alignItems: "center" }}>{t("migrationRun.decision.more")}</summary>
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5, wordBreak: "break-word" }}>
          {spec.hintKey && <p style={{ margin: "0 0 6px" }}>{t(spec.hintKey)}</p>}
          <p style={{ margin: 0 }}>{codeText(t, issue.code, issue.params)}</p>
          {issue.subjects.length > 0 && <p className="mono" style={{ margin: "6px 0 0", color: "var(--c-tx3)" }}>{subjectsText(issue.subjects)}</p>}
        </div>
      </details>
    </li>
  );
}

function BlockerRow({ issue }: { issue: DecisionIssue }) {
  const t = useT();
  const spec = blockerSpec(issue.code);
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0", borderTop: "1px solid var(--c-bd)", listStyle: "none" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <XCircle size={16} aria-hidden color="var(--c-r)" style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0, fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>
          {codeText(t, issue.code, issue.params)}
          {issue.subjects.length > 0 && <span className="mono" style={{ color: "var(--c-tx3)", fontSize: 11 }}> {subjectsText(issue.subjects)}</span>}
        </div>
      </div>
      <div style={{ paddingLeft: 26, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>
        <strong>{t("migrationRun.decision.howToFix")}</strong> {t(spec.adviceKey)}
      </div>
      {spec.fix && (
        <div style={{ paddingLeft: 26 }}>
          <FixLink fix={spec.fix} />
        </div>
      )}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={heading}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 3, lineHeight: 1.5, wordBreak: "break-word" }}>{children}</div>
    </div>
  );
}

/**
 * The answer to a dry run, in one screen: green (nothing stops the real run), yellow (warnings to fix or accept) or red
 * (something stops it, and how to get past it), the one card with what the real run would take, and the Start button. The
 * technical step list and events stay on the page, behind "Details". Accepting a warning is stored on the dry run (`warning-acks`)
 * and travels to the real run it is promoted into.
 */
export function DryRunDecision({ run, onOpenSafety }: { run: MigrationRunView; onOpenSafety?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { onError, toast } = useRunPlumbing(run.id);
  const hints = useQuery<MigrationRunSafetyHints>({ queryKey: runHintsKey(run.id), queryFn: () => api.getMigrationRunSafetyHints(run.id), staleTime: 15_000 });
  const accepted = hints.data?.warningAcks;
  const d = useMemo(() => decisionOf(run, accepted ?? []), [run, accepted]);
  const { onStart, pending: starting } = useStartRun(run);
  const save = useMutation({
    mutationFn: (acks: Array<{ key: string; accepted: boolean }>) => api.setMigrationRunWarningAcks(run.id, { acks }),
    onSuccess: (next) => {
      qc.setQueryData(runHintsKey(run.id), next);
      toast(t("migrationRun.decision.saved"), "success");
    },
    onError,
  });
  const acceptable = d.open.filter((w) => canAccept(w.key));
  const s = d.summary;
  const counts = [
    s.apps !== null && t("migrationRun.decision.countApps", { count: s.apps }),
    s.databases !== null && t("migrationRun.decision.countDatabases", { count: s.databases }),
    s.services !== null && t("migrationRun.decision.countServices", { count: s.services }),
  ].filter((x): x is string => !!x);

  const tone = d.verdict === "blocked" ? "var(--c-r)" : d.verdict === "warnings" ? "var(--c-am)" : "var(--c-g)";
  const Icon = d.verdict === "blocked" ? XCircle : d.verdict === "warnings" ? AlertTriangle : CheckCircle2;
  const headline =
    d.verdict === "blocked"
      ? t(d.blockers.length === 1 ? "migrationRun.decision.blockedOne" : "migrationRun.decision.blockedMany", { count: d.blockers.length })
      : d.verdict === "warnings"
        ? t(d.open.length === 1 ? "migrationRun.decision.warningsOne" : "migrationRun.decision.warningsMany", { count: d.open.length })
        : d.accepted.length > 0
          ? t("migrationRun.decision.cleanAccepted", { count: d.accepted.length })
          : t("migrationRun.decision.clean");
  const canStart = d.verdict === "clean" && run.allowed.start;

  return (
    <SectionCard title={t("migrationRun.decision.title")} style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", border: `1px solid ${tone}`, borderRadius: "var(--r1)", padding: "12px 14px", background: `color-mix(in srgb, ${tone} 8%, transparent)` }}>
          <Icon size={22} aria-hidden color={tone} style={{ flexShrink: 0 }} />
          <div role="status" aria-live="polite" style={{ flex: "1 1 220px", minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{headline}</div>
            {d.verdict === "blocked" && <div style={{ fontSize: 12, color: "var(--c-tx2)", marginTop: 2 }}>{t("migrationRun.decision.blockedHint")}</div>}
            {d.verdict === "warnings" && <div style={{ fontSize: 12, color: "var(--c-tx2)", marginTop: 2 }}>{t("migrationRun.decision.warningsHint")}</div>}
          </div>
          <Btn onClick={onStart} loading={starting} disabled={!canStart}>
            {t("migrationRun.decision.start")}
          </Btn>
        </div>

        {d.blockers.length > 0 && (
          <section aria-label={t("migrationRun.decision.blockersTitle")}>
            <div style={heading}>{t("migrationRun.decision.blockersTitle")}</div>
            <ul style={{ margin: "6px 0 0", padding: 0 }}>{d.blockers.map((b) => <BlockerRow key={`${b.level}:${b.key}`} issue={b} />)}</ul>
          </section>
        )}

        {d.warnings.length > 0 && (
          <section aria-label={t("migrationRun.decision.warningsTitle")}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <div style={heading}>{t("migrationRun.decision.warningsTitle")}</div>
              {acceptable.length > 1 && (
                <Btn variant="ghost" disabled={save.isPending} onClick={() => save.mutate(acceptable.map((w) => ({ key: w.key, accepted: true })))}>
                  {t("migrationRun.decision.acceptAll")}
                </Btn>
              )}
            </div>
            <ul style={{ margin: "6px 0 0", padding: 0 }}>
              {d.warnings.map((w) => {
                const isAccepted = d.accepted.includes(w);
                return <WarningRow key={w.key} issue={w} accepted={isAccepted} busy={save.isPending} onToggle={(accept) => save.mutate([{ key: w.key, accepted: accept }])} onOpenSafety={onOpenSafety} />;
              })}
            </ul>
          </section>
        )}

        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 14, background: "var(--c-el)" }}>
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
            {counts.length > 0 && <Fact label={t("migrationRun.decision.moves")}>{counts.join(", ")}</Fact>}
            <Fact label={t("migrationRun.decision.data")}>{s.dataBytes === null ? t("migrationRun.decision.notMeasured") : formatBytes(s.dataBytes)}</Fact>
            <Fact label={t("migrationRun.decision.duration")}>{s.durationSec === null ? t("migrationRun.decision.notEstimated") : t("migrationRun.decision.about", { time: formatDuration(s.durationSec) ?? "-" })}</Fact>
            <Fact label={t("migrationRun.decision.downtime")}>{s.downtimeSec === null ? t("migrationRun.decision.notEstimated") : t("migrationRun.decision.about", { time: formatDuration(s.downtimeSec) ?? "-" })}</Fact>
            <Fact label={t("migrationRun.decision.rollbackTitle")}>{t(ROLLBACK_PATH_KEY[run.mode])}</Fact>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
