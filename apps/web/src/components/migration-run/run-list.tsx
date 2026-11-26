"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { scopeByTeam } from "../../lib/team-scope";
import { useTeamScope } from "../team-scope";
import { relativeTime } from "../../lib/fleet";
import { CAMPAIGN_ROLLUP_LIMIT, NEXT_KIND_KEY, STEP_TITLE_KEY, campaignReportHref, campaignRollup, codeText, runListRefetchInterval, runTitleParts, validCampaign } from "../../lib/migration-run";
import { Checkbox, Field, TextInput } from "../form";
import { Badge, EmptyState, LinkBtn } from "../ui";
import { ErrorState } from "../error-state";
import { ListCard, ListRow } from "../list";
import { PageTitle } from "../page-header";
import { MeterBar } from "../meter-bar";
import { SkeletonTable } from "../skeleton";
import type { MigrationRunSummary } from "../../lib/types";
import { ModeBadges, RunStatusPill } from "./badges";

function RunRow({ r, index, onOpen }: { r: MigrationRunSummary; index: number; onOpen: () => void }) {
  const t = useT();
  const { source, target, extraTargets } = runTitleParts(r);
  const pct = r.stepsTotal > 0 ? Math.round((r.stepsPassed / r.stepsTotal) * 100) : 0;
  return (
    <ListRow index={index} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px 14px", flexWrap: "wrap", width: "100%" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{source} → {target}{extraTargets > 0 ? ` +${extraTargets}` : ""}</div>
          <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <ModeBadges mode={r.mode} topology={r.topology} dryRun={r.dryRun} inPlace={r.inPlace} />
            {r.targetServerCount > 1 && <Badge tone="lapis">{t("migrationRun.list.servers", { count: r.targetServerCount })}</Badge>}
            {r.campaign && <Badge tone="gold">{r.campaign}</Badge>}
            {r.sourceVersion && <Badge>{t("migrationRun.list.version", { version: r.sourceVersion })}</Badge>}
          </div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4, wordBreak: "break-word" }}>
            {r.failure ? codeText(t, r.failure.code) : r.currentStep ? `${t(STEP_TITLE_KEY[r.currentStep])} · ${t(NEXT_KIND_KEY[r.nextActionKind])}` : t(NEXT_KIND_KEY[r.nextActionKind])}
          </div>
        </div>
        <MeterBar value={pct} tone={r.status === "FAILED" ? "crit" : "ok"} text={`${r.stepsPassed}/${r.stepsTotal}`} width={110} label={t("migrationRun.facts.progress")} />
        <RunStatusPill status={r.status} />
        <span style={{ fontSize: 12, color: "var(--c-tx3)", minWidth: 70, textAlign: "right" }}>{relativeTime(r.createdAt)}</span>
      </div>
    </ListRow>
  );
}

/** `/import/runs`: the operator's guided migrations, newest first. Live runs refresh every few seconds. */
export function RunList() {
  const t = useT();
  const router = useRouter();
  const { teamId } = useTeamScope();
  const [activeOnly, setActiveOnly] = useState(false);
  const [campaignText, setCampaignText] = useState("");
  // the hub filters by the exact label; an invalid or empty text lists every run
  const campaign = validCampaign(campaignText) ? campaignText.trim() : "";
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["migration-runs", activeOnly, campaign],
    queryFn: () => api.listMigrationRuns({ ...(activeOnly ? { active: true } : {}), ...(campaign ? { campaign } : {}), limit: 100 }),
    refetchInterval: (q) => runListRefetchInterval(q.state.data as MigrationRunSummary[] | undefined),
  });
  const scoped = scopeByTeam(data ?? [], teamId);
  // the chips count every run of a campaign: they come from their own query, not from the page above, which is cut by
  // "Active only", by the campaign filter and by its own limit
  const all = useQuery({
    queryKey: ["migration-runs", "rollup"],
    queryFn: () => api.listMigrationRuns({ limit: CAMPAIGN_ROLLUP_LIMIT }),
    refetchInterval: (q) => runListRefetchInterval(q.state.data as MigrationRunSummary[] | undefined),
  });
  const rollupRuns = scopeByTeam(all.data ?? [], teamId);
  const rollup = campaignRollup(rollupRuns);
  const rollupCapped = (all.data?.length ?? 0) >= CAMPAIGN_ROLLUP_LIMIT;
  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle title={t("migrationRun.title")} subtitle={t("migrationRun.subtitle")} actions={<LinkBtn href="/import">{t("migrationRun.new")}</LinkBtn>} />
      <div style={{ marginBottom: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Checkbox checked={activeOnly} onChange={setActiveOnly} label={t("migrationRun.list.activeOnly")} />
        <Field label={t("migrationRun.list.campaign")} style={{ flex: "1 1 220px", maxWidth: 320 }}>
          <TextInput value={campaignText} onChange={(e) => setCampaignText(e.target.value)} placeholder={t("migrationRun.list.campaignAll")} maxLength={80} autoComplete="off" style={{ minHeight: 44 }} />
        </Field>
      </div>
      {rollup.length > 0 && (
        <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {rollup.map((c) => (
            <li key={c.campaign} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button
                type="button"
                className="tg-btn"
                onClick={() => setCampaignText(c.campaign)}
                aria-label={t("migrationRun.list.campaignFilter", { campaign: c.campaign })}
                style={{ minHeight: 44, padding: "6px 12px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", background: "var(--c-el)", color: "var(--c-tx)", textAlign: "left", cursor: "pointer", fontSize: 12 }}
              >
                <strong style={{ display: "block", wordBreak: "break-word" }}>{c.campaign}</strong>
                <span style={{ color: "var(--c-tx3)" }}>{t(rollupCapped ? "migrationRun.list.campaignRollupCapped" : "migrationRun.list.campaignRollup", { total: c.total, completed: c.completed, live: c.live, failed: c.failed, other: c.other })}</span>
              </button>
              <Link href={campaignReportHref(c.campaign)} className="tg-link" style={{ fontSize: 12, minHeight: 28, display: "inline-flex", alignItems: "center", padding: "0 4px" }}>
                {t("migrationRun.campaign.open")}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {isLoading && <SkeletonTable rows={4} />}
      {isError && !data && <ErrorState onRetry={() => refetch()} />}
      {data && (
        <ListCard>
          {scoped.length === 0 ? (
            <EmptyState icon={Route} title={t("migrationRun.list.emptyTitle")} action={<LinkBtn href="/import">{t("migrationRun.new")}</LinkBtn>}>
              {t("migrationRun.list.empty")}
            </EmptyState>
          ) : (
            scoped.map((r, i) => <RunRow key={r.id} r={r} index={i} onOpen={() => router.push(`/import/runs/${r.id}`)} />)
          )}
        </ListCard>
      )}
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "14px 0 0", lineHeight: 1.5 }}>{t("migrationRun.list.hint")}</p>
    </div>
  );
}
