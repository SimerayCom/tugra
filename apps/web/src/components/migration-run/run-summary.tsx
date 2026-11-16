"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useT } from "../../i18n/provider";
import { Card, SectionCard } from "../ui";
import { formatDuration } from "../../lib/import";
import { MODE_HINT_KEY, TOPOLOGY_HINT_KEY, dryRunVerdict, stepsSummary } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";
import { MeterBar } from "../meter-bar";

/** The banner under the title: where the run stands relative to the point of no return, what mode it is in, and what
 *  a dry-run found. A dry-run is stated plainly as having changed nothing. */
export function RunBanners({ run }: { run: MigrationRunView }) {
  const t = useT();
  const v = dryRunVerdict(run);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
      {run.dryRun && (
        <div role="status" style={{ border: "1px solid var(--c-lapis)", borderRadius: "var(--r1)", padding: "10px 12px", fontSize: 13, lineHeight: 1.5, background: "color-mix(in srgb, var(--c-lapis) 8%, transparent)" }}>
          <strong>{t("migrationRun.banner.dryRun")}</strong> {t("migrationRun.banner.dryRunBody")}
          {run.status === "DRY_RUN_DONE" && (
            <div style={{ marginTop: 4, color: v.blocks > 0 || v.unknown > 0 ? "var(--c-r)" : "var(--c-g)" }}>
              {v.blocks > 0 || v.unknown > 0 ? t("migrationRun.banner.dryRunBlocked", { blocks: v.blocks, unknown: v.unknown }) : t("migrationRun.banner.dryRunClean", { warns: v.warns })}
            </div>
          )}
        </div>
      )}
      {run.ponrAt ? (
        <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start", border: "1px solid var(--c-r)", borderRadius: "var(--r1)", padding: "10px 12px", background: "color-mix(in srgb, var(--c-r) 8%, transparent)" }}>
          <ShieldAlert size={18} color="var(--c-r)" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <strong style={{ color: "var(--c-r)" }}>{t("migrationRun.banner.ponrPast", { when: new Date(run.ponrAt).toLocaleString() })}</strong> {t("migrationRun.banner.ponrPastBody")}
          </div>
        </div>
      ) : (
        !run.dryRun &&
        run.allowed.abort && (
          <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px" }}>
            <ShieldCheck size={18} color="var(--c-g)" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--c-tx2)" }}>{t("migrationRun.banner.ponrBefore")}</div>
          </div>
        )
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 3, wordBreak: "break-word" }}>{children}</div>
    </div>
  );
}

/** Source, target, mode, progress and the downtime window: estimate versus measured. */
export function RunFacts({ run }: { run: MigrationRunView }) {
  const t = useT();
  const sum = stepsSummary(run);
  const pct = sum.total > 0 ? Math.round((sum.passed / sum.total) * 100) : 0;
  const est = run.windowEstimate?.freezeToFlipSec ?? null;
  const measured = run.measuredDowntimeSec;
  return (
    <SectionCard title={t("migrationRun.facts.title")} style={{ marginBottom: 0 }}>
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
        <Fact label={t("migrationRun.facts.source")}><span className="mono">{run.sourceHost ?? run.sourceKind}</span></Fact>
        <Fact label={t("migrationRun.facts.target")}><span className="mono">{run.targetServerName ?? run.targetServerId}</span></Fact>
        <Fact label={t("migrationRun.facts.mode")}>
          {t(run.mode === "takeover" ? "migrationRun.mode.takeover" : "migrationRun.mode.copy")}
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 2, lineHeight: 1.4 }}>{t(MODE_HINT_KEY[run.mode])}</div>
        </Fact>
        <Fact label={t("migrationRun.facts.topology")}>
          {t(run.topology === "swap-proxy" ? "migrationRun.topology.swap-proxy" : "migrationRun.topology.two-box")}
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 2, lineHeight: 1.4 }}>{t(TOPOLOGY_HINT_KEY[run.topology])}</div>
        </Fact>
        <Fact label={t("migrationRun.facts.progress")}>
          <MeterBar value={pct} text={`${sum.passed}/${sum.total}`} grow label={t("migrationRun.facts.progress")} />
        </Fact>
      </div>
      <Card style={{ padding: 12, marginTop: 14, background: "var(--c-el)" }}>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
          <Fact label={t("migrationRun.window.estimate")}>{est === null ? t("migrationRun.window.none") : formatDuration(est)}</Fact>
          <Fact label={t("migrationRun.window.measured")}>{measured === null ? (run.freezeStartedAt ? t("migrationRun.window.open") : t("migrationRun.window.none")) : formatDuration(measured)}</Fact>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.window.note")}</p>
      </Card>
    </SectionCard>
  );
}
