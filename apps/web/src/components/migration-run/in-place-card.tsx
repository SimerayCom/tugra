"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, CircleSlash, Loader } from "lucide-react";
import type { RunInPlaceView } from "@tugra/shared";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Badge, SectionCard } from "../ui";
import { OUTCOME_KEY, inPlaceBusy, outcomeCounts, outcomeOf, outcomeTone, rowsOf, stagesOf, type StageState } from "../../lib/inplace-run";
import type { MigrationRunView } from "../../lib/types";

const POLL_MS = 5000;

/**
 * The takeover an in-place run carries. Asked for only when the run is in place; null until the run planned one. It keeps asking while the
 * takeover moves on its own (the test, the switch, the new certificates) and rests once it settles.
 */
export function useRunInPlace(run: Pick<MigrationRunView, "id" | "inPlace">) {
  return useQuery<RunInPlaceView | null>({
    queryKey: ["run-inplace", run.id],
    queryFn: () => api.getRunInPlace(run.id),
    enabled: run.inPlace,
    retry: false,
    refetchInterval: (q) => (inPlaceBusy((q.state.data as RunInPlaceView | null | undefined)?.status) ? POLL_MS : false),
  });
}

const STAGE_COLOR: Record<StageState, string> = { done: "var(--c-g)", current: "var(--c-a)", todo: "var(--c-tx3)", stopped: "var(--c-r)" };

function StageMark({ state }: { state: StageState }) {
  const common = { size: 16, color: STAGE_COLOR[state], "aria-hidden": true as const, style: { flexShrink: 0 } };
  if (state === "done") return <CheckCircle2 {...common} />;
  if (state === "current") return <Loader {...common} />;
  if (state === "stopped") return <CircleSlash {...common} />;
  return <CircleDashed {...common} />;
}

/**
 * In-place run: where the takeover stands (planned, tested beside Coolify, ports handed over, new certificates) and, for every app, whether
 * Coolify's image was reused or the app was rebuilt with Tugra and verified. Words next to every mark, never colour alone.
 */
export function InPlaceCard({ run, state }: { run: MigrationRunView; state: ReturnType<typeof useRunInPlace> }) {
  const t = useT();
  if (!run.inPlace) return null;
  const view = state.data ?? null;
  const counts = view ? outcomeCounts(view.items) : null;
  return (
    <SectionCard title={t("inPlaceRun.title")} desc={t("inPlaceRun.subtitle")} style={{ marginBottom: 0 }}>
      {state.isLoading && <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("inPlaceRun.loading")}</p>}
      {state.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)" }}>{t("inPlaceRun.unreadable")}</p>}
      {!state.isLoading && !state.isError && !view && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("inPlaceRun.none")}</p>}
      {view && counts && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone={view.status === "FAILED" ? "danger" : view.status === "VERIFIED" ? "ok" : view.status === "GIVEN_BACK" || view.status === "GIVING_BACK" ? "warn" : "lapis"}>{t(`coolifyInPlace.status.${view.status}`)}</Badge>
            <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5, flex: "1 1 220px", minWidth: 0 }}>{t(`coolifyInPlace.hint.${view.status}`)}</span>
          </div>
          {view.failureCode && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)", lineHeight: 1.5 }}>{t(`coolifyInPlace.failure.${view.failureCode}`)}</p>}
          <ol data-testid="in-place-stages" aria-label={t("inPlaceRun.title")} style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
            {stagesOf(view.status, view.verified).map((s) => (
              <li key={s.stage} data-state={s.state} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, minHeight: 28 }}>
                <StageMark state={s.state} />
                <span style={{ overflowWrap: "anywhere" }}>
                  {t(`inPlaceRun.stage.${s.stage}`)} <span style={{ color: "var(--c-tx3)" }}>({t(`inPlaceRun.stageState.${s.state}`)})</span>
                </span>
              </li>
            ))}
          </ol>
          <p data-testid="in-place-rollup" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
            {t("inPlaceRun.rollup", { apps: counts.apps, reused: counts.reused, rebuilt: counts.rebuiltVerified, rebuilding: counts.rebuilding, problems: counts.problems, declined: counts.declined, skipped: counts.skipped })}
            {counts.databases > 0 && <> {t("inPlaceRun.databases", { count: counts.databases })}</>}
          </p>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{t("inPlaceRun.appsTitle")}</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
              {rowsOf(view).map(({ item, outcome }) => {
                const ok = item.domains.filter((d) => d.tempCheck === "ok").length;
                return (
                  <li key={item.itemRef} data-testid="in-place-app" data-outcome={outcome} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13, overflowWrap: "anywhere", flex: "1 1 140px", minWidth: 0 }}>{item.name}</strong>
                      <Badge tone={outcomeTone(outcome)}>{t(OUTCOME_KEY[outcome])}</Badge>
                    </div>
                    {item.issues?.map((c) => (
                      <p key={c} role="note" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t(`coolifyInPlace.issue.${c}`)}</p>
                    ))}
                    {outcomeOf(item) !== "skipped" && item.kind !== "database" && item.domains.length > 0 && (
                      <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("inPlaceRun.domains", { ok, total: item.domains.length })}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
