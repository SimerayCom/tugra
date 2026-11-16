"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { ErrorState } from "../error-state";
import { PageHeader } from "../page-header";
import { SkeletonCard } from "../skeleton";
import { isTerminalRun, runRefetchInterval, runStatusColor } from "../../lib/migration-run";
import { RUN_STATUS_KEY } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";
import { ModeBadges } from "./badges";
import { EventLog } from "./event-log";
import { NextActionCard } from "./next-action-card";
import { OwnerInputsCard } from "./owner-inputs-card";
import { ReportCard } from "./report-card";
import { RecoveryCard, RunHeaderActions } from "./run-actions";
import { RunDrawers } from "./run-drawers";
import { PlacementCard, RunBanners, RunFacts } from "./run-summary";
import { SafetyCard } from "./safety-card";
import { StepTimeline } from "./step-timeline";
import { runQueryKey } from "./use-run-actions";
import { useRunEvents } from "./use-run-events";

/** The guided-migration run page: status header, the single "what I am waiting for" card, the step timeline with
 *  gates and evidence, the downtime window, the owner inputs, recovery actions, events and the final report. The page
 *  polls fast while the hub is moving, slowly while it waits for a person, and stops once the run has settled. */
export function RunDetail({ id }: { id: string }) {
  const t = useT();
  const { data: run, isLoading, isError, refetch } = useQuery<MigrationRunView>({
    queryKey: runQueryKey(id),
    queryFn: () => api.getMigrationRun(id),
    refetchInterval: (q) => runRefetchInterval(q.state.data as MigrationRunView | undefined),
  });
  const { events, error } = useRunEvents(id, run?.eventSeq);

  if (isLoading) return <SkeletonCard />;
  if (isError && !run) return <ErrorState onRetry={() => refetch()} />;
  if (!run) return null;

  const settled = isTerminalRun(run.status);
  const extraTargets = Math.max(0, run.targetServers.length - 1);
  const title = `${run.sourceHost ?? run.sourceKind} → ${run.targetServerName ?? run.targetServerId}${extraTargets > 0 ? ` +${extraTargets}` : ""}`;
  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: t("nav.import"), href: "/import" },
          { label: t("migrationRun.title"), href: "/import/runs" },
          { label: run.id.slice(0, 8) },
        ]}
        title={<span style={{ wordBreak: "break-word" }}>{title}</span>}
        status={{ label: t(RUN_STATUS_KEY[run.status]), color: runStatusColor(run.status) }}
        actions={<RunHeaderActions run={run} />}
      >
        <ModeBadges mode={run.mode} topology={run.topology} dryRun={run.dryRun} />
      </PageHeader>
      <RunBanners run={run} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <NextActionCard run={run} />
        <StepTimeline run={run} />
        <RunFacts run={run} />
        <PlacementCard run={run} />
        <OwnerInputsCard key={JSON.stringify(run.inputs)} run={run} />
        <SafetyCard run={run} />
        <RunDrawers run={run} />
        <RecoveryCard run={run} />
        <EventLog events={events} error={error} />
        <ReportCard runId={run.id} enabled={settled || run.status === "FAILED"} />
      </div>
    </>
  );
}
