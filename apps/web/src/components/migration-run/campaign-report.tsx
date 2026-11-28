"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { formatDuration } from "../../lib/import";
import { CAMPAIGN_REPORT_RUN_CAP, CAMPAIGN_ROLLUP_LIMIT, STEP_TITLE_KEY, buildCampaignReport, codeText, errorText, runListRefetchInterval, runRefetchInterval, validCampaign } from "../../lib/migration-run";
import { campaignCancellable, campaignHeadline, waveRanks } from "../../lib/campaign";
import { needsYou } from "../../lib/run-stepper";
import type { MigrationRunReport, MigrationRunSummary, MigrationRunView } from "../../lib/types";
import { useTeamContext } from "../team-scope";
import { ErrorState } from "../error-state";
import { PageTitle } from "../page-header";
import { SkeletonTable } from "../skeleton";
import { Badge, BackLink, Btn, EmptyState, SectionCard } from "../ui";
import { useToast } from "../toast";
import { NeedsYouList, WaveRow, runName } from "./campaign-progress";
import { TypedConfirmDialog } from "./typed-confirm";
import { runQueryKey } from "./use-run-actions";

const OUTCOME_KEY = { failed: "migrationRun.campaign.outcome.failed", "not-cut-over": "migrationRun.campaign.outcome.not-cut-over" } as const;
const dash = "-";
const HEADLINE_KEY = {
  done: "migrationRun.campaignRun.headline.done",
  cancelled: "migrationRun.campaignRun.headline.cancelled",
  failed: "migrationRun.campaignRun.headline.failed",
  preparing: "migrationRun.campaignRun.headline.preparing",
  needsOne: "migrationRun.campaignRun.headline.needsOne",
  needsMany: "migrationRun.campaignRun.headline.needsMany",
  ready: "migrationRun.campaignRun.headline.ready",
  paused: "migrationRun.campaignRun.headline.paused",
  moving: "migrationRun.campaignRun.headline.moving",
  review: "migrationRun.campaignRun.headline.review",
} as const;
const HEADLINE_SUB_KEY = {
  done: "migrationRun.campaignRun.headline.doneSub",
  cancelled: "migrationRun.campaignRun.headline.cancelledSub",
  failed: "migrationRun.campaignRun.headline.failedSub",
  preparing: "migrationRun.campaignRun.headline.preparingSub",
  needs: "migrationRun.campaignRun.headline.needsSub",
  ready: "migrationRun.campaignRun.headline.readySub",
  paused: "migrationRun.campaignRun.headline.pausedSub",
  moving: "migrationRun.campaignRun.headline.movingSub",
  review: "migrationRun.campaignRun.headline.reviewSub",
} as const;
const secs = (n: number | null): string => (n === null ? dash : (formatDuration(n) ?? dash));

/** The report of one campaign (R15/R69): every run with its state, hosts, window and failures, and the totals over them. Built
 *  from the run list of the label plus each run's own report; the page polls while any run is still live. */
export function CampaignReport({ campaign }: { campaign: string }) {
  const t = useT();
  const { teams } = useTeamContext();
  const valid = validCampaign(campaign);
  const list = useQuery<MigrationRunSummary[]>({
    queryKey: ["migration-runs", "campaign", campaign],
    queryFn: () => api.listMigrationRuns({ campaign, limit: CAMPAIGN_ROLLUP_LIMIT }),
    enabled: valid,
    refetchInterval: (q) => runListRefetchInterval(q.state.data as MigrationRunSummary[] | undefined),
  });
  // The label is the choice: a move onto servers of several teams is one campaign per team under one label, so the report does not narrow to the team in view.
  const runs = useMemo(() => (list.data ?? []).filter((r) => r.campaign === campaign), [list.data, campaign]);
  const capped = runs.length > CAMPAIGN_REPORT_RUN_CAP;
  const read = runs.slice(0, CAMPAIGN_REPORT_RUN_CAP);
  const reports = useQueries({
    queries: read.map((r) => ({
      queryKey: ["migration-run-report", r.id, r.status],
      queryFn: () => api.getMigrationRunReport(r.id),
      staleTime: 15_000,
    })),
  });
  const byId = new Map<string, MigrationRunReport | null | undefined>(read.map((r, i) => [r.id, reports[i].isError ? null : reports[i].data]));
  const data = buildCampaignReport(campaign, read, byId);
  const showTeams = data.teamIds.length > 1;
  const teamNameOf = (id: string): string => teams.find((x) => x.id === id)?.name ?? id;

  // The campaigns of this label (one per team): their plan says the waves, their status says whether there is anything left to cancel. A team the
  // viewer is no owner or admin of answers nothing; the report then simply has no wave guide.
  const campaignQs = useQueries({
    queries: data.teamIds.map((teamId) => ({ queryKey: ["migration-campaigns", teamId], queryFn: () => api.listCampaigns(teamId), retry: false, staleTime: 10_000 })),
  });
  const views = useMemo(() => campaignQs.flatMap((q) => q.data ?? []).filter((v) => v.label === campaign), [campaignQs, campaign]);
  const ranks = useMemo(() => waveRanks(views, runs), [views, runs]);
  const cancellable = views.filter(campaignCancellable);
  // The live view of every run (steps, next action): the same cache entry as the run page, so an approval given here shows there and the other way round.
  const runQs = useQueries({
    queries: read.map((r) => ({
      queryKey: runQueryKey(r.id),
      queryFn: () => api.getMigrationRun(r.id),
      refetchInterval: (q: { state: { data: MigrationRunView | undefined } }) => runRefetchInterval(q.state.data),
    })),
  });
  const viewOf = new Map<string, MigrationRunView | undefined>(read.map((r, i) => [r.id, runQs[i].data]));
  const needsIds = read.filter((r) => { const v = viewOf.get(r.id); return !!v && needsYou(v) && v.nextAction.kind !== "failed"; }).map((r) => r.id);
  const headline = campaignHeadline(views, runs, needsIds);
  const rowOf = new Map(data.runs.map((r) => [r.id, r]));
  const nameOf = (id: string): string => { const row = rowOf.get(id); return row ? runName(t, row) : id.slice(0, 8); };
  const allInPlace = data.runs.length > 0 && data.runs.every((r) => r.inPlace);
  const [cancelling, setCancelling] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const cancel = useMutation({
    mutationFn: async () => {
      for (const v of cancellable) await api.cancelCampaign(v.id);
      return cancellable.length;
    },
    onSuccess: (n) => {
      toast(t("migrationRun.campaign.cancelled", { count: n }), "success");
      setCancelling(false);
      void qc.invalidateQueries({ queryKey: ["migration-campaigns"] });
      void qc.invalidateQueries({ queryKey: ["migration-runs"] });
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });
  // "Start all" hands the campaign to the hub (one call per team's campaign); "Pause" holds back the servers that have not started
  const startable = views.filter((v) => campaignCancellable(v) && v.driving !== true);
  const start = useMutation({
    mutationFn: async () => {
      for (const v of startable) await api.startCampaign(v.id);
    },
    onSuccess: () => {
      toast(t("migrationRun.campaignRun.started"), "success");
      void qc.invalidateQueries({ queryKey: ["migration-campaigns"] });
      void qc.invalidateQueries({ queryKey: ["migration-runs"] });
    },
    onError: (e) => {
      toast(errorText(t, e), "error");
      void qc.invalidateQueries({ queryKey: ["migration-campaigns"] });
    },
  });
  const pause = useMutation({
    mutationFn: async () => {
      for (const v of views.filter((x) => x.driving === true)) await api.pauseCampaign(v.id);
    },
    onSuccess: () => {
      toast(t("migrationRun.campaignRun.pausedToast"), "success");
      void qc.invalidateQueries({ queryKey: ["migration-campaigns"] });
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });
  const rows = [...data.runs].sort((a, b) => (ranks.rankOf.get(a.id) ?? 999) - (ranks.rankOf.get(b.id) ?? 999) || (a.createdAt < b.createdAt ? -1 : 1));
  const h = headline;
  const headParams = { name: h.failedRunId ? nameOf(h.failedRunId) : h.needs[0] ? nameOf(h.needs[0]) : "", count: h.needs.length || h.queued, total: h.total, made: h.made, done: h.completed };
  const headTitle = h.kind === "needs" ? (h.needs.length > 1 ? HEADLINE_KEY.needsMany : HEADLINE_KEY.needsOne) : HEADLINE_KEY[h.kind];
  const headSub = h.kind === "needs" ? HEADLINE_SUB_KEY.needs : HEADLINE_SUB_KEY[h.kind];

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 1100, margin: "0 auto" }}>
      <BackLink href="/import/runs" label={t("migrationRun.campaign.back")} />
      <PageTitle title={`${t("migrationRun.campaign.title")}${valid ? `: ${campaign}` : ""}`} subtitle={t("migrationRun.campaign.subtitle")} />
      {!valid && <EmptyState title={t("migrationRun.campaign.title")}>{t("migrationRun.campaign.noLabel")}</EmptyState>}
      {valid && list.isLoading && <SkeletonTable rows={3} />}
      {valid && list.isError && !list.data && <ErrorState onRetry={() => list.refetch()} />}
      {valid && list.data && runs.length === 0 && <EmptyState title={t("migrationRun.campaign.title")}>{t("migrationRun.campaign.noRuns")}</EmptyState>}
      {valid && runs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SectionCard title={t(headTitle, headParams)} style={{ marginBottom: 0 }}>
            <div data-testid="campaign-headline" data-kind={h.kind} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t(headSub, headParams)}</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {h.action && startable.length > 0 && (
                  <Btn onClick={() => start.mutate()} loading={start.isPending} style={{ minHeight: 44, flex: "1 1 220px" }}>
                    {start.isPending ? t("migrationRun.campaignRun.starting") : h.action === "start" ? t("migrationRun.campaignRun.startAll", { count: h.queued }) : t("migrationRun.campaignRun.continue")}
                  </Btn>
                )}
                {h.kind === "failed" && h.failedRunId && (
                  <Link href={`/import/runs/${h.failedRunId}`} className="tg-link" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontSize: 13, fontWeight: 600 }}>
                    {t("migrationRun.campaignRun.openRun")}
                  </Link>
                )}
                {h.canPause && (
                  <Btn variant="ghost" onClick={() => pause.mutate()} loading={pause.isPending} style={{ minHeight: 44 }}>
                    {pause.isPending ? t("migrationRun.campaignRun.pausing") : t("migrationRun.campaignRun.pause")}
                  </Btn>
                )}
              </div>
              <p role="note" data-testid="campaign-close-note" style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.campaignRun.closeNote")}</p>
              {data.pendingReports > 0 && !allInPlace && <div role="status" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.campaign.pending", { count: data.pendingReports })}</div>}
              {capped && <div role="note" style={{ fontSize: 12, color: "var(--c-am)" }}>{t("migrationRun.campaign.capped", { max: CAMPAIGN_REPORT_RUN_CAP })}</div>}
            </div>
          </SectionCard>

          <NeedsYouList items={needsIds} views={viewOf} nameOf={nameOf} />

          <SectionCard
            title={t("migrationRun.campaignRun.wavesTitle")}
            right={
              cancellable.length > 0 ? (
                <details>
                  <summary style={{ cursor: "pointer", minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 13, color: "var(--c-tx2)" }}>{t("migrationRun.campaignRun.moreActions")}</summary>
                  <div style={{ marginTop: 6 }}>
                    <Btn variant="dangerGhost" onClick={() => setCancelling(true)} disabled={cancel.isPending} style={{ minHeight: 44 }}>{cancel.isPending ? t("migrationRun.campaign.cancelling") : t("migrationRun.campaign.cancelButton")}</Btn>
                  </div>
                </details>
              ) : undefined
            }
            style={{ marginBottom: 0 }}
          >
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}>
              {rows.map((r) => (
                <WaveRow key={r.id} row={r} teamName={showTeams ? teamNameOf(r.teamId) : null} view={viewOf.get(r.id)} rank={ranks.rankOf.get(r.id)} count={ranks.count} wave={ranks.count > 0} />
              ))}
            </ul>
          </SectionCard>

          {!allInPlace && (
            <SectionCard title={t("migrationRun.campaign.summaryTitle")} style={{ marginBottom: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, lineHeight: 1.5 }}>
                <div>{t("migrationRun.campaign.runs", { total: data.rollup.total, completed: data.rollup.completed, live: data.rollup.live, failed: data.rollup.failed, other: data.rollup.other })}</div>
                <div>{data.pendingReports === read.length ? t("migrationRun.campaign.itemsNone") : t("migrationRun.campaign.items", data.totals)}</div>
                <div style={{ wordBreak: "break-word" }}>{t("migrationRun.campaign.sourceHosts", { hosts: data.sourceHosts.join(", ") || dash })}</div>
                <div style={{ wordBreak: "break-word" }}>{t("migrationRun.campaign.targetServers", { servers: data.targetServers.join(", ") || dash })}</div>
                {showTeams && <div style={{ wordBreak: "break-word" }}>{t("migrationRun.campaign.teams", { teams: data.teamIds.map(teamNameOf).join(", ") })}</div>}
                {data.window.measuredTotalSec === null ? (
                  <div style={{ color: "var(--c-tx3)" }}>{t("migrationRun.campaign.windowNone")}</div>
                ) : (
                  <>
                    <div>{t("migrationRun.campaign.windowTotal", { time: secs(data.window.measuredTotalSec) })}</div>
                    <div>{t("migrationRun.campaign.windowLongest", { time: secs(data.window.measuredLongestSec) })}</div>
                  </>
                )}
              </div>
            </SectionCard>
          )}

          {data.runs.some((r) => r.failure || r.problemItems.length > 0) && (
          <SectionCard title={t("migrationRun.campaign.failuresTitle")} style={{ marginBottom: 0 }}>
            {(
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {data.runs.flatMap((r) => [
                  // the run itself failed: its step and code first, then the items that failed or stayed on the source
                  ...(r.failure
                    ? [
                        <li key={`${r.id}:run`} style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "center", fontSize: 13, minWidth: 0 }}>
                          <Badge tone="danger">{t("migrationRun.campaign.outcome.failed")}</Badge>
                          <span style={{ flex: "1 1 160px", minWidth: 0, wordBreak: "break-word" }}>{r.failure.step ? t(STEP_TITLE_KEY[r.failure.step]) : t("migrationRun.campaign.runFailed")}</span>
                          <span style={{ fontSize: 12, color: "var(--c-tx3)", wordBreak: "break-word" }}>{codeText(t, r.failure.code)}</span>
                          <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{r.sourceHost ?? dash}</span>
                        </li>,
                      ]
                    : []),
                  ...r.problemItems.map((p, i) => (
                    <li key={`${r.id}:${p.kind}:${p.name}:${i}`} style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "center", fontSize: 13, minWidth: 0 }}>
                      <Badge tone={p.outcome === "failed" ? "danger" : "warn"}>{t(OUTCOME_KEY[p.outcome])}</Badge>
                      <span className="mono" style={{ wordBreak: "break-all", flex: "1 1 160px", minWidth: 0 }}>{p.name}</span>
                      {p.code && <span style={{ fontSize: 12, color: "var(--c-tx3)", wordBreak: "break-word" }}>{codeText(t, p.code)}</span>}
                      <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{r.sourceHost ?? dash}</span>
                    </li>
                  )),
                ])}
              </ul>
            )}
          </SectionCard>
          )}
        </div>
      )}
      {cancelling && (
        <TypedConfirmDialog
          title={t("migrationRun.campaign.cancelTitle")}
          body={t("migrationRun.campaign.cancelBody")}
          names={[campaign]}
          confirmLabel={t("migrationRun.campaign.cancelButton")}
          busy={cancel.isPending}
          onConfirm={() => cancel.mutate()}
          onClose={() => setCancelling(false)}
        />
      )}
    </div>
  );
}
