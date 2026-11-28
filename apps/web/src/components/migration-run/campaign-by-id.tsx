"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { ErrorState } from "../error-state";
import { SkeletonTable } from "../skeleton";
import { BackLink, EmptyState } from "../ui";
import { PageTitle } from "../page-header";
import { CampaignReport } from "./campaign-report";

/**
 * The campaign page opened by the campaign's id. The id is the identity of the page; the label (free text, any language) is only what the runs
 * and the report are filed under, so it is read from the campaign and handed to the report.
 */
export function CampaignById({ id }: { id: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ["migration-campaign", id], queryFn: () => api.getCampaign(id), retry: false, refetchInterval: 15_000 });
  if (q.data) return <CampaignReport campaign={q.data.label} />;
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 1100, margin: "0 auto" }}>
      <BackLink href="/import/runs" label={t("migrationRun.campaign.back")} />
      <PageTitle title={t("migrationRun.campaign.title")} subtitle={t("migrationRun.campaign.subtitle")} />
      {q.isLoading && <SkeletonTable rows={3} />}
      {q.isError && !q.data && (q.error as { status?: number } | null)?.status === 404 ? <EmptyState title={t("migrationRun.campaign.title")}>{t("migrationRun.campaign.notFound")}</EmptyState> : q.isError && <ErrorState onRetry={() => q.refetch()} />}
    </div>
  );
}
