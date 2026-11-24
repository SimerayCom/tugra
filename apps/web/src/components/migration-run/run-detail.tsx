"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { ErrorState } from "../error-state";
import { PageHeader } from "../page-header";
import { SkeletonCard } from "../skeleton";
import { isTerminalRun, runRefetchInterval, runStatusColor } from "../../lib/migration-run";
import { RUN_STATUS_KEY } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";
import { ModeBadges } from "./badges";
import { DryRunDecision } from "./dry-run-decision";
import { EventLog } from "./event-log";
import { HeldWorkersCard } from "./held-workers-card";
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
  const [showDetails, setShowDetails] = useState(false);
  // bumped by a warning fix that lives in Details (the image pin): opens them and the safety card
  const [safetyFocus, setSafetyFocus] = useState(0);

  if (isLoading) return <SkeletonCard />;
  if (isError && !run) return <ErrorState onRetry={() => refetch()} />;
  if (!run) return null;

  const settled = isTerminalRun(run.status);
  // a finished dry run answers with a decision screen; the technical steps and events sit behind "Details"
  const decided = run.dryRun && run.status === "DRY_RUN_DONE";
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
        {decided ? (
          <>
            <DryRunDecision
              run={run}
              onOpenSafety={() => {
                setShowDetails(true);
                setSafetyFocus((n) => n + 1);
              }}
            />
            {run.allowed.sourceSession && <NextActionCard run={run} />}
            <DetailsToggle open={showDetails} onToggle={() => setShowDetails((v) => !v)} />
            {showDetails && <RunBody run={run} events={events} error={error} settled={settled} safetyFocus={safetyFocus} />}
          </>
        ) : (
          <>
            <NextActionCard run={run} />
            <RunBody run={run} events={events} error={error} settled={settled} />
          </>
        )}
      </div>
    </>
  );
}

/** The technical view of a run: steps, facts, placement, inputs, safety, recovery, events and the report. */
function RunBody({ run, events, error, settled, safetyFocus }: { run: MigrationRunView; events: ReturnType<typeof useRunEvents>["events"]; error: ReturnType<typeof useRunEvents>["error"]; settled: boolean; safetyFocus?: number }) {
  return (
    <div id="mr-run-details" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <StepTimeline run={run} />
      <RunFacts run={run} />
      <PlacementCard run={run} />
      <HeldWorkersCard run={run} />
      <OwnerInputsCard key={JSON.stringify(run.inputs)} run={run} />
      <SafetyCard run={run} focusToken={safetyFocus} />
      <RunDrawers run={run} />
      <RecoveryCard run={run} />
      <EventLog events={events} error={error} />
      <ReportCard runId={run.id} enabled={settled || run.status === "FAILED"} />
    </div>
  );
}

/** "Details": opens the technical view of a finished dry run. */
function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="mr-run-details"
      onClick={onToggle}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: 44, padding: "0 4px", background: "transparent", border: "none", color: "var(--c-tx2)", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
    >
      <Chevron size={15} aria-hidden />
      {t(open ? "migrationRun.decision.detailsHide" : "migrationRun.decision.details")}
    </button>
  );
}
