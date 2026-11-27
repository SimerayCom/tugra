"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { formatDuration } from "../../lib/import";
import { relativeTime } from "../../lib/fleet";
import { CAMPAIGN_REPORT_RUN_CAP, CAMPAIGN_ROLLUP_LIMIT, NEXT_KIND_KEY, STEP_TITLE_KEY, buildCampaignReport, codeText, errorText, runListRefetchInterval, validCampaign, type CampaignRunRow } from "../../lib/migration-run";
import { campaignCancellable, campaignGuide } from "../../lib/campaign";
import type { MigrationRunReport, MigrationRunSummary } from "../../lib/types";
import { useTeamContext } from "../team-scope";
import { ErrorState } from "../error-state";
import { PageTitle } from "../page-header";
import { SkeletonTable } from "../skeleton";
import { Badge, BackLink, Btn, Card, EmptyState, SectionCard } from "../ui";
import { useToast } from "../toast";
import { ModeBadges, RunStatusPill } from "./badges";
import { TypedConfirmDialog } from "./typed-confirm";

const OUTCOME_KEY = { failed: "migrationRun.campaign.outcome.failed", "not-cut-over": "migrationRun.campaign.outcome.not-cut-over" } as const;
const dash = "-";
const secs = (n: number | null): string => (n === null ? dash : (formatDuration(n) ?? dash));

function RunCard({ row, teamName, wave, next }: { row: CampaignRunRow; teamName: string | null; wave?: number; next: boolean }) {
  const t = useT();
  const hosts = t("migrationRun.campaign.hosts", { source: row.sourceHost ?? dash, targets: row.targetNames.join(", ") });
  return (
    <li>
      <Card style={{ padding: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", alignItems: "center" }}>
          <Link href={`/import/runs/${row.id}`} className="tg-link" aria-label={t("migrationRun.campaign.openRun", { id: row.id.slice(0, 8) })} style={{ fontWeight: 600, wordBreak: "break-word", flex: "1 1 220px", minWidth: 0 }}>
            {hosts}
          </Link>
          <RunStatusPill status={row.status} />
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {teamName && <Badge tone="muted">{teamName}</Badge>}
          {wave !== undefined && <Badge tone="muted">{t("migrationRun.campaign.wave", { n: wave + 1 })}</Badge>}
          {next && <Badge tone="lapis">{t("migrationRun.campaign.startNext")}</Badge>}
          <ModeBadges mode={row.mode} topology={row.topology} dryRun={row.dryRun} inPlace={row.inPlace} />
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{row.currentStep ? t(STEP_TITLE_KEY[row.currentStep]) : t(NEXT_KIND_KEY.none)} · {relativeTime(row.createdAt)}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.6 }}>
          <div>{t("migrationRun.campaign.window", { estimated: secs(row.estimatedSec), measured: secs(row.measuredSec) })}</div>
          <div>{row.items ? t("migrationRun.campaign.items", row.items) : t("migrationRun.campaign.itemsNone")}</div>
          {row.failure && <div style={{ color: "var(--c-r)", wordBreak: "break-word" }}>{codeText(t, row.failure.code)}</div>}
        </div>
      </Card>
    </li>
  );
}

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
  const guide = useMemo(() => campaignGuide(views, runs), [views, runs]);
  const cancellable = views.filter(campaignCancellable);
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
              {data.pendingReports > 0 && <div role="status" style={{ color: "var(--c-tx3)" }}>{t("migrationRun.campaign.pending", { count: data.pendingReports })}</div>}
              {capped && <div role="note" style={{ color: "var(--c-am)" }}>{t("migrationRun.campaign.capped", { max: CAMPAIGN_REPORT_RUN_CAP })}</div>}
            </div>
          </SectionCard>

          <SectionCard
            title={t("migrationRun.campaign.runsTitle")}
            right={cancellable.length > 0 ? <Btn variant="dangerGhost" onClick={() => setCancelling(true)} disabled={cancel.isPending} style={{ minHeight: 44 }}>{cancel.isPending ? t("migrationRun.campaign.cancelling") : t("migrationRun.campaign.cancelButton")}</Btn> : undefined}
            style={{ marginBottom: 0 }}
          >
            {guide.next.size > 0 && <p role="note" style={{ margin: "0 0 10px", fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("migrationRun.campaign.waveHint")}</p>}
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}>
              {data.runs.map((r) => (
                <RunCard key={r.id} row={r} teamName={showTeams ? teamNameOf(r.teamId) : null} wave={guide.waveOf.get(r.id)} next={guide.next.has(r.id)} />
              ))}
            </ul>
          </SectionCard>

          <SectionCard title={t("migrationRun.campaign.failuresTitle")} style={{ marginBottom: 0 }}>
            {data.runs.every((r) => !r.failure && r.problemItems.length === 0) ? (
              <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.campaign.failuresNone")}</div>
            ) : (
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
