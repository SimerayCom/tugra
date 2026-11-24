"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, CircleHelp } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { formatBytes } from "../../lib/import";
import { Btn, SectionCard, Spinner } from "../ui";
import { useRunPlumbing } from "./use-run-actions";
import type { MigrationRunView, VerificationReport, VerificationView, VerifyPageSample, VerifyVerdict } from "../../lib/types";

const verdictColor: Record<VerifyVerdict, string> = { same: "var(--c-g)", similar: "var(--c-g)", differs: "var(--c-r)", unknown: "var(--c-am)" };
const heading: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" };
const muted: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 };

const VERDICT_KEY: Record<VerifyVerdict, string> = {
  same: "migrationRun.verifyReport.verdict.same",
  similar: "migrationRun.verifyReport.verdict.similar",
  differs: "migrationRun.verifyReport.verdict.differs",
  unknown: "migrationRun.verifyReport.verdict.unknown",
};
const PAGE_CODE_KEY: Record<string, string> = {
  "same-content": "migrationRun.verifyReport.page.same-content",
  "same-redirect": "migrationRun.verifyReport.page.same-redirect",
  "content-close": "migrationRun.verifyReport.page.content-close",
  "both-failing": "migrationRun.verifyReport.page.both-failing",
  status: "migrationRun.verifyReport.page.status",
  redirect: "migrationRun.verifyReport.page.redirect",
  content: "migrationRun.verifyReport.page.content",
  "source-unreachable": "migrationRun.verifyReport.page.source-unreachable",
  "target-unreachable": "migrationRun.verifyReport.page.target-unreachable",
  "same-host-needs-agent": "migrationRun.verifyReport.page.same-host-needs-agent",
  "no-address": "migrationRun.verifyReport.page.no-address",
};
const VOLUME_CODE_KEY: Record<string, string> = {
  "same-size": "migrationRun.verifyReport.volume.same-size",
  size: "migrationRun.verifyReport.volume.size",
  "not-copied": "migrationRun.verifyReport.volume.not-copied",
  "not-reported": "migrationRun.verifyReport.volume.not-reported",
};

export const verificationKey = (runId: string) => ["migration-run-verification", runId] as const;

/** A short text mark that carries the verdict by words, not by color alone. */
function VerdictMark({ verdict }: { verdict: VerifyVerdict }) {
  const t = useT();
  return <span style={{ fontSize: 12, fontWeight: 700, color: verdictColor[verdict], whiteSpace: "nowrap" }}>{t(VERDICT_KEY[verdict])}</span>;
}

function Side({ label, sample }: { label: string; sample: VerifyPageSample }) {
  const t = useT();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{sample.status === null ? t("migrationRun.verifyReport.noAnswer") : t("migrationRun.verifyReport.status", { status: String(sample.status) })}</div>
      {sample.title && <div style={{ ...muted, overflowWrap: "anywhere" }}>{sample.title}</div>}
    </div>
  );
}

function Row({ verdict, title, children }: { verdict: VerifyVerdict; title: string; children: React.ReactNode }) {
  return (
    <li style={{ listStyle: "none", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }}>{title}</span>
        <VerdictMark verdict={verdict} />
      </div>
      {children}
    </li>
  );
}

const list: React.CSSProperties = { margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 };
const isSame = (v: VerifyVerdict) => v === "same" || v === "similar";

function Headline({ report }: { report: VerificationReport }) {
  const t = useT();
  const { state, counts } = report;
  const Icon = state === "match" ? CheckCircle2 : state === "differences" ? CircleAlert : CircleHelp;
  const color = state === "match" ? "var(--c-g)" : state === "differences" ? "var(--c-r)" : "var(--c-am)";
  const title = state === "match" ? t("migrationRun.verifyReport.matchTitle") : state === "differences" ? t("migrationRun.verifyReport.diffTitle", { count: String(counts.differs) }) : t("migrationRun.verifyReport.incompleteTitle");
  const desc =
    state === "match"
      ? t("migrationRun.verifyReport.matchDesc", { checked: String(counts.checked) })
      : state === "differences"
        ? t("migrationRun.verifyReport.diffDesc", { checked: String(counts.checked) })
        : t("migrationRun.verifyReport.incompleteDesc", { unknown: String(counts.unknown), checked: String(counts.checked) });
  return (
    <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Icon size={22} color={color} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color }}>{title}</div>
        <div style={muted}>{desc}</div>
      </div>
    </div>
  );
}

function Pages({ report }: { report: VerificationReport }) {
  const t = useT();
  if (!report.pages.length) return null;
  const odd = report.pages.filter((p) => !isSame(p.verdict));
  const same = report.pages.filter((p) => isSame(p.verdict));
  const renderRow = (p: VerificationReport["pages"][number]) => (
    <Row key={`${p.host}${p.path}`} verdict={p.verdict} title={`${p.host}${p.path}`}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Side label={t("migrationRun.verifyReport.source")} sample={p.source} />
        <Side label={t("migrationRun.verifyReport.target")} sample={p.target} />
      </div>
      <div style={muted}>{t(PAGE_CODE_KEY[p.code] ?? PAGE_CODE_KEY.content)}</div>
    </Row>
  );
  return (
    <section>
      <h4 style={heading}>{t("migrationRun.verifyReport.pages")}</h4>
      <ul style={list}>{odd.map(renderRow)}</ul>
      {same.length > 0 && (
        <details style={{ marginTop: odd.length ? 8 : 0 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, minHeight: 32 }}>{t("migrationRun.verifyReport.showSame", { count: String(same.length) })}</summary>
          <ul style={{ ...list, marginTop: 8 }}>{same.map(renderRow)}</ul>
        </details>
      )}
    </section>
  );
}

function Databases({ report }: { report: VerificationReport }) {
  const t = useT();
  if (!report.databases.length) return null;
  return (
    <section>
      <h4 style={heading}>{t("migrationRun.verifyReport.databases")}</h4>
      <ul style={list}>
        {report.databases.map((d) => (
          <Row key={d.itemRef} verdict={d.verdict} title={d.name ?? d.itemRef}>
            <div style={muted}>{d.sourceRows === null || d.targetRows === null ? t("migrationRun.verifyReport.db.notMeasured") : t("migrationRun.verifyReport.db.rows", { source: String(d.sourceRows), target: String(d.targetRows) })}</div>
            {d.tables.map((x) => (
              <div key={x.name} style={{ fontSize: 12, overflowWrap: "anywhere" }}>{t("migrationRun.verifyReport.db.tableDiff", { name: x.name, source: String(x.source), target: String(x.target) })}</div>
            ))}
          </Row>
        ))}
      </ul>
    </section>
  );
}

function Volumes({ report }: { report: VerificationReport }) {
  const t = useT();
  if (!report.volumes.length) return null;
  return (
    <section>
      <h4 style={heading}>{t("migrationRun.verifyReport.volumes")}</h4>
      <ul style={list}>
        {report.volumes.map((v) => (
          <Row key={v.itemRef} verdict={v.verdict} title={v.name ?? v.itemRef}>
            <div style={muted}>
              {v.files !== null && `${t("migrationRun.verifyReport.volume.files", { files: String(v.files) })} · `}
              {v.sourceBytes !== null ? t("migrationRun.verifyReport.volume.bytes", { source: formatBytes(v.sourceBytes), target: formatBytes(v.targetBytes ?? 0) }) : t(VOLUME_CODE_KEY[v.code] ?? VOLUME_CODE_KEY["not-reported"])}
            </div>
            {(v.code === "size" || v.code === "not-copied") && <div style={muted}>{t(VOLUME_CODE_KEY[v.code] ?? VOLUME_CODE_KEY["not-reported"])}</div>}
          </Row>
        ))}
      </ul>
    </section>
  );
}

function Env({ report }: { report: VerificationReport }) {
  const t = useT();
  if (!report.env.length) return null;
  return (
    <section>
      <h4 style={heading}>{t("migrationRun.verifyReport.env")}</h4>
      <ul style={list}>
        {report.env.map((e) => (
          <Row key={e.itemRef} verdict={e.verdict} title={e.name ?? e.itemRef}>
            <div style={{ ...muted, overflowWrap: "anywhere" }}>
              {e.missing.length ? t("migrationRun.verifyReport.envMissing", { keys: e.missing.map((m) => m.key).join(", ") }) : e.targetKeys === null ? t("migrationRun.verifyReport.envUnreadable") : t("migrationRun.verifyReport.envSame", { count: String(e.targetKeys) })}
            </div>
          </Row>
        ))}
      </ul>
    </section>
  );
}

/**
 * Source versus target, before the DNS change: the page status and content, the database tables, the volumes and the
 * variables, as one answer ("Source and target match") or a list of differences. Reading the new copy straight from the
 * target server means nothing has to point there yet, and the old site keeps serving meanwhile.
 */
export function VerifyReportCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const qc = useQueryClient();
  const { onError } = useRunPlumbing(run.id);
  const q = useQuery<VerificationView>({ queryKey: verificationKey(run.id), queryFn: () => api.getMigrationRunVerification(run.id), staleTime: 30_000 });
  const run_ = useMutation({
    mutationFn: () => api.runMigrationRunVerification(run.id),
    onSuccess: (v) => qc.setQueryData(verificationKey(run.id), v),
    onError,
  });
  const report = q.data?.report ?? null;
  const links = (q.data?.previews ?? []).filter((p) => p.url);
  return (
    <SectionCard
      title={t("migrationRun.verifyReport.title")}
      desc={t("migrationRun.verifyReport.desc")}
      right={
        <Btn onClick={() => run_.mutate()} disabled={run_.isPending}>
          {run_.isPending ? t("migrationRun.verifyReport.running") : report ? t("migrationRun.verifyReport.rerun") : t("migrationRun.verifyReport.run")}
        </Btn>
      }
      style={{ marginBottom: 0 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {q.isLoading && <Spinner />}
        {run_.isPending && <div role="status" style={muted}>{t("migrationRun.verifyReport.running")}</div>}
        {q.isError && <div role="alert" style={{ fontSize: 13, color: "var(--c-r)" }}>{t("migrationRun.verifyReport.error")}</div>}
        {!q.isLoading && !report && <div style={muted}>{t("migrationRun.verifyReport.never")}</div>}
        {report && (
          <>
            <Headline report={report} />
            <div style={muted}>{t("migrationRun.verifyReport.at", { at: new Date(report.at).toLocaleString() })}</div>
            <Pages report={report} />
            <Databases report={report} />
            <Volumes report={report} />
            <Env report={report} />
          </>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {links.map((p) => (
            <a key={p.host} href={p.url as string} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-ac)", fontSize: 13, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
              {t("migrationRun.verifyReport.preview")}: {p.host}
            </a>
          ))}
          {links.length === 0 && <span style={muted}>{t("migrationRun.verifyReport.previewNone")}</span>}
        </div>
      </div>
    </SectionCard>
  );
}
