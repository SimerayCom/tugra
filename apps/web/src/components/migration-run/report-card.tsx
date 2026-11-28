"use client";

import { useQuery } from "@tanstack/react-query";
import { api, migrationRunReportMdUrl } from "../../lib/api";
import { useI18n, useT } from "../../i18n/provider";
import { Badge, SectionCard, Spinner } from "../ui";
import { formatBytes, formatDuration } from "../../lib/import";
import { EVIDENCE_KINDS, codeText } from "../../lib/migration-run";
import { stepTitleKey } from "../../lib/inplace-run";
import type { MigrationRunDataIntegrity, MigrationRunReport } from "../../lib/types";
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
const LANE_KEY = {
  dump: "migrationRun.report.data.lane.dump",
  stream: "migrationRun.report.data.lane.stream",
  files: "migrationRun.report.data.lane.files",
} as const;
const ROWS_KEY = {
  match: "migrationRun.report.data.rows.match",
  close: "migrationRun.report.data.rows.close",
  mismatch: "migrationRun.report.data.rows.mismatch",
  unverified: "migrationRun.report.data.rows.unverified",
} as const;
const ROWS_TONE = { match: "ok", close: "warn", mismatch: "danger", unverified: "muted" } as const;
const OUTCOME_TONE = { moved: "ok", skipped: "muted", acked: "warn", failed: "danger", "not-cut-over": "warn" } as const;

/** The secret-free run report: what moved, what did not and why, which evidence the run relied on, and the measured
 *  window against the estimate. Loaded on demand; a Markdown copy can be downloaded. */
export function ReportCard({ runId, enabled, inPlace = false }: { runId: string; enabled: boolean; inPlace?: boolean }) {
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
      {q.data && <ReportBody report={q.data} inPlace={inPlace} />}
    </SectionCard>
  );
}

/** The import op lists every task of the whole fleet; an item the importer skipped without a reason of its own is noise on one server's report. */
const FLEET_NOISE_CODE = "import.task-skipped";

export function ReportBody({ report, inPlace = false }: { report: MigrationRunReport; inPlace?: boolean }) {
  const t = useT();
  const ev = report.evidenceSummary;
  const items = inPlace ? report.items.filter((it) => !(it.outcome === "skipped" && it.code === FLEET_NOISE_CODE)) : report.items;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {(report.source.version || (report.targets?.length ?? 0) > 1 || report.campaign) && (
        <div style={{ display: "flex", gap: "4px 14px", flexWrap: "wrap", fontSize: 13, color: "var(--c-tx2)" }}>
          {report.source.version && <span>{t("migrationRun.report.version", { version: report.source.version })}</span>}
          {(report.targets?.length ?? 0) > 1 && <span>{t("migrationRun.report.targets", { servers: report.targets!.map((x) => x.serverName ?? x.serverId).join(", ") })}</span>}
          {report.campaign && <span>{t("migrationRun.report.campaign", { campaign: report.campaign })}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
        <span>{t("migrationRun.report.estimated", { time: report.window.estimatedSec === null ? t("migrationRun.window.none") : (formatDuration(report.window.estimatedSec) ?? "-") })}</span>
        <span>{t("migrationRun.report.measured", { time: report.window.measuredSec === null ? t("migrationRun.window.none") : (formatDuration(report.window.measuredSec) ?? "-") })}</span>
      </div>
      {!inPlace && (
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.report.evidence")}</span>
        {/* the three classic kinds always, the two newer ones (source API, host script) only when the run relied on them */}
        {EVIDENCE_KINDS.filter((k) => (ev[k] ?? 0) > 0 || k === "hub-verified" || k === "migrator-reported" || k === "operator-attested").map((k) => (
          <span key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
            <EvidenceBadge kind={k} /> {ev[k] ?? 0}
          </span>
        ))}
      </div>
      )}
      {items.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((it, i) => (
            <li key={`${it.kind}:${it.name}:${i}`} style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "center", fontSize: 13, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: "var(--c-tx3)", minWidth: 64 }}>{t(KIND_KEY[it.kind])}</span>
              <span className="mono" style={{ flex: "1 1 160px", minWidth: 0, wordBreak: "break-all" }}>{it.name}</span>
              <Badge tone={OUTCOME_TONE[it.outcome]}>{t(OUTCOME_KEY[it.outcome])}</Badge>
              {it.code && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{codeText(t, it.code)}</span>}
              {it.evidence && !inPlace && <EvidenceBadge kind={it.evidence} />}
            </li>
          ))}
        </ul>
      )}
      {(report.dataIntegrity?.length ?? 0) > 0 && <DataChecks items={report.dataIntegrity!} />}
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
      {/* how long each step took; the hub's own poll counter (`attempts`) is not a retry count and is not shown */}
      {!inPlace && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {report.steps.map((s) => (
            <li key={s.key} style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--c-tx3)", flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 140px" }}>{t(stepTitleKey({ inPlace }, s.key))}</span>
              <span>{s.durationSec === null ? "-" : formatDuration(s.durationSec)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row per migrated database: the route it took and a one-sentence row check; size, parts and the checksum sit behind More. */
function DataChecks({ items }: { items: MigrationRunDataIntegrity[] }) {
  const t = useT();
  const { lang } = useI18n();
  const num = (n: number | null): string => (n === null ? "-" : n.toLocaleString(lang));
  return (
    <section aria-label={t("migrationRun.report.data.title")}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", marginBottom: 8 }}>{t("migrationRun.report.data.title")}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((d) => {
          const total = d.rows.sourceRows ?? d.rows.targetRows;
          return (
            <li key={d.itemRef} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "center", fontSize: 13 }}>
                <span className="mono" style={{ flex: "1 1 160px", minWidth: 0, wordBreak: "break-all" }}>{d.name}</span>
                <Badge tone="muted">{t(LANE_KEY[d.lane])}</Badge>
                <Badge tone={ROWS_TONE[d.rows.status]}>{t(ROWS_KEY[d.rows.status], { relations: num(d.rows.relations), rows: num(total), differing: num(d.rows.differing), names: d.rows.names.join(", ") || "-" })}</Badge>
              </div>
              <details style={{ fontSize: 12, color: "var(--c-tx3)" }}>
                <summary style={{ cursor: "pointer", minHeight: 24 }}>{t("migrationRun.report.data.more")}</summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 6 }}>
                  <span>{d.bytes === null ? "-" : t("migrationRun.report.data.size", { size: formatBytes(d.bytes) })}</span>
                  {d.parts !== null && <span>{t("migrationRun.report.data.parts", { parts: num(d.parts) })}</span>}
                  <span>{t("migrationRun.report.data.sourceRows", { rows: num(d.rows.sourceRows) })} · {t("migrationRun.report.data.targetRows", { rows: num(d.rows.targetRows) })}</span>
                  <span>{t(d.lane === "stream" ? "migrationRun.report.data.checksumParts" : "migrationRun.report.data.checksum")}</span>
                  {d.sha256 ? <span className="mono" style={{ wordBreak: "break-all", color: "var(--c-tx2)" }}>{d.sha256}</span> : <span>{t("migrationRun.report.data.noChecksum")}</span>}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
