"use client";

import { useQuery } from "@tanstack/react-query";
import { api, migrationRunReportMdUrl } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Badge, SectionCard, Spinner } from "../ui";
import { formatDuration } from "../../lib/import";
import { STEP_TITLE_KEY, codeText } from "../../lib/migration-run";
import type { MigrationRunReport } from "../../lib/types";
import { EvidenceBadge } from "./badges";
import { CommandBlock } from "./command-block";

/** The compensation item of a host-loop freeze that is still stopped: it comes with the token-free unfreeze script. */
const UNFREEZE_CODE = "freeze.host-loop-unfreeze";

const OUTCOME_KEY = {
  moved: "migrationRun.report.outcome.moved",
  skipped: "migrationRun.report.outcome.skipped",
  acked: "migrationRun.report.outcome.acked",
  failed: "migrationRun.report.outcome.failed",
  "not-cut-over": "migrationRun.report.outcome.notCutOver",
} as const;
const KIND_KEY = {
  app: "migrationRun.report.kind.app",
  database: "migrationRun.report.kind.database",
  service: "migrationRun.report.kind.service",
  volume: "migrationRun.report.kind.volume",
  bucket: "migrationRun.report.kind.bucket",
  domain: "migrationRun.report.kind.domain",
} as const;
const OUTCOME_TONE = { moved: "ok", skipped: "muted", acked: "warn", failed: "danger", "not-cut-over": "warn" } as const;

/** The secret-free run report: what moved, what did not and why, which evidence the run relied on, and the measured
 *  window against the estimate. Loaded on demand; a Markdown copy can be downloaded. */
export function ReportCard({ runId, enabled }: { runId: string; enabled: boolean }) {
  const t = useT();
  const q = useQuery<MigrationRunReport>({ queryKey: ["migration-run-report", runId], queryFn: () => api.getMigrationRunReport(runId), enabled, staleTime: 30_000 });
  return (
    <SectionCard
      title={t("migrationRun.report.title")}
      right={enabled && <a href={migrationRunReportMdUrl(runId)} download className="tg-link" style={{ fontSize: 12 }}>{t("migrationRun.report.download")}</a>}
      style={{ marginBottom: 0 }}
    >
      {!enabled && <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.report.notYet")}</div>}
      {enabled && q.isLoading && <Spinner />}
      {enabled && q.isError && <div role="alert" style={{ fontSize: 13, color: "var(--c-r)" }}>{t("migrationRun.errors.generic")}</div>}
      {q.data && <ReportBody report={q.data} />}
    </SectionCard>
  );
}

export function ReportBody({ report }: { report: MigrationRunReport }) {
  const t = useT();
  const ev = report.evidenceSummary;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
        <span>{t("migrationRun.report.estimated", { time: report.window.estimatedSec === null ? t("migrationRun.window.none") : (formatDuration(report.window.estimatedSec) ?? "-") })}</span>
        <span>{t("migrationRun.report.measured", { time: report.window.measuredSec === null ? t("migrationRun.window.none") : (formatDuration(report.window.measuredSec) ?? "-") })}</span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.report.evidence")}</span>
        {(["hub-verified", "migrator-reported", "operator-attested"] as const).map((k) => (
          <span key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
            <EvidenceBadge kind={k} /> {ev[k]}
          </span>
        ))}
      </div>
      {report.items.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {report.items.map((it, i) => (
            <li key={`${it.kind}:${it.name}:${i}`} style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "center", fontSize: 13, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: "var(--c-tx3)", minWidth: 64 }}>{t(KIND_KEY[it.kind])}</span>
              <span className="mono" style={{ flex: "1 1 160px", minWidth: 0, wordBreak: "break-all" }}>{it.name}</span>
              <Badge tone={OUTCOME_TONE[it.outcome]}>{t(OUTCOME_KEY[it.outcome])}</Badge>
              {it.code && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{codeText(t, it.code)}</span>}
              {it.evidence && <EvidenceBadge kind={it.evidence} />}
            </li>
          ))}
        </ul>
      )}
      {report.manual.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-am)", marginBottom: 6 }}>{t("migrationRun.report.manual")}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {report.manual.map((m, i) => (
              <li key={`${m.code}:${i}`} style={{ wordBreak: "break-word" }}>
                {codeText(t, m.code, m.params)}
                {m.code === UNFREEZE_CODE && (
                  <div style={{ marginTop: 8 }}>
                    <CommandBlock runId={report.runId} stepKey="FREEZE" tokenless />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {report.steps.map((s) => (
          <li key={s.key} style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--c-tx3)", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 140px" }}>{t(STEP_TITLE_KEY[s.key])}</span>
            <span>{s.durationSec === null ? "-" : formatDuration(s.durationSec)}</span>
            <span>{t("migrationRun.step.attempt", { n: s.attempts })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
