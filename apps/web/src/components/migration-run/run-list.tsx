"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { scopeByTeam } from "../../lib/team-scope";
import { useTeamScope } from "../team-scope";
import { relativeTime } from "../../lib/fleet";
import { CAMPAIGN_ROLLUP_LIMIT, NEXT_KIND_KEY, STEP_TITLE_KEY, campaignReportHref, campaignRollup, codeText, runListRefetchInterval, runTitleParts } from "../../lib/migration-run";
import { CAMPAIGN_BUCKETS, campaignBucket, campaignHref, campaignTitle, groupCampaigns, rollupBucket, runBucket, type CampaignFilter } from "../../lib/campaign";
import { CampaignFilterTabs } from "../campaign-filter";
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
            {r.campaign && <Badge tone="gold">{campaignTitle(t, r.campaign, r.createdAt)}</Badge>}
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

/** `/import/runs`: the operator's guided migrations, newest first. Live runs refresh every few seconds. What is going on, or waits for the owner, is shown;
 *  finished and cancelled moves are one tab away (with their count), so a list of old attempts never buries the one that matters. */
export function RunList() {
  const t = useT();
  const router = useRouter();
  const { teamId } = useTeamScope();
  const teamsQ = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), retry: false });
  const teams = teamsQ.data ?? [];
  const [filter, setFilter] = useState<CampaignFilter>("live");
  // every run the page counts and lists comes from one query (the newest CAMPAIGN_ROLLUP_LIMIT): the chips, the counts of the tabs and the rows agree
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["migration-runs", "rollup"],
    queryFn: () => api.listMigrationRuns({ limit: CAMPAIGN_ROLLUP_LIMIT }),
    refetchInterval: (q) => runListRefetchInterval(q.state.data as MigrationRunSummary[] | undefined),
  });
  const scoped = scopeByTeam(data ?? [], teamId);
  const rollup = campaignRollup(scoped);
  const rollupCapped = (data?.length ?? 0) >= CAMPAIGN_ROLLUP_LIMIT;
  // the campaigns themselves (their id is the address of their page); a person who is not an owner or admin of a team reads none, and the chip then falls back to the label
  const eligible = teams.filter((tm) => tm.role === "OWNER" || tm.role === "ADMIN");
  const campaignQs = useQueries({ queries: eligible.map((tm) => ({ queryKey: ["migration-campaigns", tm.id], queryFn: () => api.listCampaigns(tm.id), retry: false, staleTime: 10_000 })) });
  const groups = groupCampaigns(campaignQs.flatMap((q) => q.data ?? []));
  const chips = rollup.map((c) => {
    const g = groups.find((x) => x.label === c.campaign);
    return { ...c, group: g ?? null, bucket: g ? campaignBucket(g.status) : rollupBucket(c) };
  });
  const counts = { all: scoped.length, ...Object.fromEntries(CAMPAIGN_BUCKETS.map((b) => [b, scoped.filter((r) => runBucket(r.status) === b).length])) } as Record<CampaignFilter, number>;
  const shownRuns = scoped.filter((r) => filter === "all" || runBucket(r.status) === filter);
  const shownChips = chips.filter((c) => filter === "all" || c.bucket === filter);
  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle title={t("migrationRun.title")} subtitle={t("migrationRun.subtitle")} actions={<LinkBtn href="/import">{t("migrationRun.new")}</LinkBtn>} />
      {data && <CampaignFilterTabs value={filter} onChange={setFilter} counts={counts} />}
      {shownChips.length > 0 && (
        <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {shownChips.map((c) => (
            <li key={c.campaign} style={{ flex: "1 1 240px", maxWidth: 420, minWidth: 0 }}>
              {/* the whole chip is the link to the campaign's page */}
              <Link
                href={c.group ? campaignHref(c.group.id) : campaignReportHref(c.campaign)}
                className="tg-btn"
                style={{ display: "block", minHeight: 44, padding: "6px 12px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", background: "var(--c-el)", color: "var(--c-tx)", textDecoration: "none", fontSize: 12 }}
              >
                <strong style={{ display: "block", wordBreak: "break-word" }}>{campaignTitle(t, c.campaign, c.group?.createdAt ?? scoped.filter((r) => r.campaign === c.campaign).map((r) => r.createdAt).sort()[0])}</strong>
                <span style={{ color: "var(--c-tx3)" }}>{t(rollupCapped ? "migrationRun.list.campaignRollupCapped" : "migrationRun.list.campaignRollup", { total: c.total, completed: c.completed, live: c.live, failed: c.failed, other: c.other })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {isLoading && <SkeletonTable rows={4} />}
      {isError && !data && <ErrorState onRetry={() => refetch()} />}
      {data && (
        <ListCard>
          {shownRuns.length === 0 ? (
            <EmptyState icon={Route} title={t(scoped.length === 0 ? "migrationRun.list.emptyTitle" : "migrationRun.list.emptyFilterTitle")} action={scoped.length === 0 ? <LinkBtn href="/import">{t("migrationRun.new")}</LinkBtn> : undefined}>
              {t(scoped.length === 0 ? "migrationRun.list.empty" : "migrationRun.list.emptyFilter")}
            </EmptyState>
          ) : (
            shownRuns.map((r, i) => <RunRow key={r.id} r={r} index={i} onOpen={() => router.push(`/import/runs/${r.id}`)} />)
          )}
        </ListCard>
      )}
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "14px 0 0", lineHeight: 1.5 }}>{t("migrationRun.list.hint")}</p>
    </div>
  );
}
