"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useT } from "../../i18n/provider";
import { Badge, Card, SectionCard } from "../ui";
import { formatDuration } from "../../lib/import";
import { MODE_HINT_KEY, TOPOLOGY_HINT_KEY, UNKNOWN_SOURCE_HOST, VERSION_VERDICT_HINT_KEY, VERSION_VERDICT_KEY, sourceHostLabel, sourceHostNames, stepsSummary, versionVerdictColor } from "../../lib/migration-run";
import { relativeTime } from "../../lib/fleet";
import type { MigrationRunView } from "../../lib/types";
import { MeterBar } from "../meter-bar";

/** The banner under the title: where the run stands relative to the point of no return and what mode it is in. A dry-run is
 *  stated plainly as having changed nothing; what it found is the decision screen's job. */
export function RunBanners({ run }: { run: MigrationRunView }) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
      {run.dryRun && (
        <div role="status" style={{ border: "1px solid var(--c-lapis)", borderRadius: "var(--r1)", padding: "10px 12px", fontSize: 13, lineHeight: 1.5, background: "color-mix(in srgb, var(--c-lapis) 8%, transparent)" }}>
          <strong>{t("migrationRun.banner.dryRun")}</strong> {t("migrationRun.banner.dryRunBody")}
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

const RUNNER_KEY = {
  operator: "migrationRun.runnerName.operator",
  agent: "migrationRun.runnerName.agent",
  "coolify-host-loop": "migrationRun.runnerName.coolify-host-loop",
} as const;

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
        <Fact label={t("migrationRun.facts.version")}>
          {run.sourceVersion ? <span className="mono">{run.sourceVersion}</span> : t("migrationRun.facts.versionNone")}
          <div title={t(VERSION_VERDICT_HINT_KEY[run.sourceVersionVerdict])} style={{ fontSize: 11, marginTop: 2, lineHeight: 1.4, color: versionVerdictColor(run.sourceVersionVerdict), fontWeight: 600 }}>
            {t(VERSION_VERDICT_KEY[run.sourceVersionVerdict])}
          </div>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 2, lineHeight: 1.4 }}>{t(VERSION_VERDICT_HINT_KEY[run.sourceVersionVerdict])}</div>
        </Fact>
        <Fact label={run.targetServers.length > 1 ? t("migrationRun.facts.servers") : t("migrationRun.facts.target")}>
          {run.targetServers.length > 1 ? (
            <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {run.targetServers.map((s) => (
                <span key={s.serverId} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <span className="mono">{s.serverName ?? s.serverId}</span>
                  {s.primary && <Badge tone="muted">{t("migrationRun.facts.serverDefault")}</Badge>}
                </span>
              ))}
            </span>
          ) : (
            <span className="mono">{run.targetServerName ?? run.targetServerId}</span>
          )}
        </Fact>
        {run.campaign && <Fact label={t("migrationRun.facts.campaign")}><span className="mono">{run.campaign}</span></Fact>}
        <Fact label={t("migrationRun.facts.runner")}>{t(RUNNER_KEY[run.options.sourceRunner])}</Fact>
        <Fact label={t("migrationRun.facts.baseline")}>
          {run.baselineAt ? t("migrationRun.facts.baselineAt", { when: relativeTime(run.baselineAt) }) : <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.4 }}>{t("migrationRun.facts.baselineNone")}</span>}
        </Fact>
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

/** The multi-host placement of the run: which Tugra server each source host lands on (shown only for a run with a map). */
export function PlacementCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const entries = Object.entries(run.serverMap ?? {});
  if (entries.length === 0) return null;
  const nameOf = (id: string) => run.targetServers.find((s) => s.serverId === id)?.serverName ?? id;
  const hostNames = sourceHostNames(run);
  return (
    <SectionCard title={t("migrationRun.placement.title")} desc={t("migrationRun.placement.desc")} style={{ marginBottom: 0 }}>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, id]) => (
          <li key={ref} style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline", fontSize: 13, minWidth: 0 }}>
            <span style={{ fontSize: 11, color: "var(--c-tx3)", minWidth: 90 }}>{ref === UNKNOWN_SOURCE_HOST ? t("migrationRun.placement.unknownHost") : t("migrationRun.placement.host")}</span>
            {ref !== UNKNOWN_SOURCE_HOST && (
              // the source's own name for the host; its uuid only when the source gave none (and as the tooltip otherwise)
              <span className="mono" title={t("migrationRun.placement.idTitle", { ref })} style={{ wordBreak: "break-all", flex: "1 1 160px", minWidth: 0 }}>{sourceHostLabel(hostNames, ref)}</span>
            )}
            <span aria-hidden>→</span>
            <span className="mono" style={{ wordBreak: "break-word", flex: "1 1 120px", minWidth: 0 }}>{nameOf(id)}</span>
          </li>
        ))}
      </ul>
      <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.placement.defaultNote", { name: run.targetServerName ?? run.targetServerId })}</p>
    </SectionCard>
  );
}
