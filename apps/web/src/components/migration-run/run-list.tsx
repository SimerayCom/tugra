"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { scopeByTeam } from "../../lib/team-scope";
import { useTeamScope } from "../team-scope";
import { relativeTime } from "../../lib/fleet";
import { NEXT_KIND_KEY, STEP_TITLE_KEY, codeText, runListRefetchInterval, runTitleParts } from "../../lib/migration-run";
import { Checkbox } from "../form";
import { EmptyState, LinkBtn } from "../ui";
import { ErrorState } from "../error-state";
import { ListCard, ListRow } from "../list";
import { PageTitle } from "../page-header";
import { MeterBar } from "../meter-bar";
import { SkeletonTable } from "../skeleton";
import type { MigrationRunSummary } from "../../lib/types";
import { ModeBadges, RunStatusPill } from "./badges";

function RunRow({ r, index, onOpen }: { r: MigrationRunSummary; index: number; onOpen: () => void }) {
  const t = useT();
  const { source, target } = runTitleParts(r);
  const pct = r.stepsTotal > 0 ? Math.round((r.stepsPassed / r.stepsTotal) * 100) : 0;
  return (
    <ListRow index={index} onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px 14px", flexWrap: "wrap", width: "100%" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{source} → {target}</div>
          <div style={{ marginTop: 4 }}>
            <ModeBadges mode={r.mode} topology={r.topology} dryRun={r.dryRun} />
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
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["migration-runs", activeOnly],
    queryFn: () => api.listMigrationRuns({ ...(activeOnly ? { active: true } : {}), limit: 100 }),
    refetchInterval: (q) => runListRefetchInterval(q.state.data as MigrationRunSummary[] | undefined),
  });
  const scoped = scopeByTeam(data ?? [], teamId);
  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle title={t("migrationRun.title")} subtitle={t("migrationRun.subtitle")} actions={<LinkBtn href="/import">{t("migrationRun.new")}</LinkBtn>} />
      <div style={{ marginBottom: 12 }}>
        <Checkbox checked={activeOnly} onChange={setActiveOnly} label={t("migrationRun.list.activeOnly")} />
      </div>
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
