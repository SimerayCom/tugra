"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { canCancel, canHalt, canResume, canRollback, rolloutRefetchInterval, rolloutStatusColor, targetStatusColor, targetsByWave } from "../../../../lib/rollouts";
import type { Rollout, RolloutTarget } from "../../../../lib/types";
import { BackLink, Btn, Card, SectionCard, StatusPill } from "../../../../components/ui";
import { ErrorState } from "../../../../components/error-state";
import { PageTitle } from "../../../../components/page-header";
import { SkeletonCard } from "../../../../components/skeleton";
import { useConfirm } from "../../../../components/confirm";
import { useToast } from "../../../../components/toast";

export default function RolloutDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: r, isLoading, isError, refetch } = useQuery({
    queryKey: ["rollout", id],
    queryFn: () => api.getRollout(id),
    refetchInterval: (q) => rolloutRefetchInterval(q.state.data),
  });
  const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : t("rollouts.actionFailed"));
  // Identical hooks, always called in the same order (a named custom hook keeps the rules-of-hooks intent explicit).
  const useRolloutAction = (fn: () => Promise<Rollout>, done: string) =>
    useMutation({
      mutationFn: fn,
      onSuccess: (next) => {
        qc.setQueryData(["rollout", id], next);
        qc.invalidateQueries({ queryKey: ["rollouts"] });
        toast(t(done), "success");
      },
      onError: (e) => toast(errMsg(e), "error"),
    });
  const halt = useRolloutAction(() => api.haltRollout(id), "rollouts.halted");
  const resume = useRolloutAction(() => api.resumeRollout(id), "rollouts.resumed");
  const cancel = useRolloutAction(() => api.cancelRollout(id), "rollouts.cancelled");
  const rollback = useRolloutAction(() => api.rollbackRollout(id), "rollouts.rolledBack");
  const busy = halt.isPending || resume.isPending || cancel.isPending || rollback.isPending;

  const ask = async (key: string, danger: boolean, run: () => void) => {
    if (await confirm({ body: t(key), danger })) run();
  };

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <BackLink href="/rollouts" label={t("rollouts.back")} />
      {isLoading && <SkeletonCard />}
      {isError && !r && <ErrorState onRetry={() => refetch()} />}
      {r && (
        <>
          <PageTitle
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                {r.name ?? t("rollouts.unnamed", { id: r.id.slice(0, 6) })}
                <StatusPill label={t(`rollouts.status_${r.status}`)} color={rolloutStatusColor(r.status)} />
              </span>
            }
            subtitle={`${t("rollouts.waveOf", { n: Math.min(r.currentWave + 1, r.waveCount), total: r.waveCount })} · ${t("rollouts.targetsSummary", { ok: r.summary.succeeded, failed: r.summary.failed, pending: r.summary.pending + r.summary.deploying })}`}
            actions={
              <>
                {canHalt(r.status) && (
                  <Btn variant="ghost" onClick={() => ask("rollouts.haltConfirm", false, () => halt.mutate())} loading={halt.isPending} disabled={busy}>
                    {t("rollouts.halt")}
                  </Btn>
                )}
                {canResume(r.status) && (
                  <Btn onClick={() => ask("rollouts.resumeConfirm", false, () => resume.mutate())} loading={resume.isPending} disabled={busy}>
                    {t("rollouts.resume")}
                  </Btn>
                )}
                {canRollback(r) && (
                  <Btn variant="dangerGhost" onClick={() => ask("rollouts.rollbackConfirm", true, () => rollback.mutate())} loading={rollback.isPending} disabled={busy}>
                    {t("rollouts.rollback")}
                  </Btn>
                )}
                {canCancel(r.status) && (
                  <Btn variant="dangerGhost" onClick={() => ask("rollouts.cancelConfirm", true, () => cancel.mutate())} loading={cancel.isPending} disabled={busy}>
                    {t("rollouts.cancel")}
                  </Btn>
                )}
              </>
            }
          />
          {r.status === "HALTED" && r.haltReason && (
            <Card style={{ padding: 14, marginBottom: 16, borderColor: "var(--c-am)" }}>
              <div role="status" style={{ color: "var(--c-am)", fontSize: 13 }}>{t(`rollouts.halt_${r.haltReason}`)}</div>
            </Card>
          )}
          {r.status === "ROLLING_BACK" && <div role="status" style={{ color: "var(--c-tx3)", fontSize: 12, marginBottom: 12 }}>{t("rollouts.rollingBack")}</div>}
          {r.status === "RUNNING" && r.bakeUntil && (
            <div role="status" style={{ color: "var(--c-tx3)", fontSize: 12, marginBottom: 12 }}>{t("rollouts.baking", { time: new Date(r.bakeUntil).toLocaleTimeString() })}</div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
            {targetsByWave(r.targets, r.waveCount).map((wave, i) => (
              <WaveCard key={i} r={r} index={i} targets={wave} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function WaveCard({ r, index, targets }: { r: Rollout; index: number; targets: RolloutTarget[] }) {
  const t = useT();
  const isCanary = index === 0 && r.config.canary > 0 && r.waveCount > 1 && targets.length <= r.config.canary;
  const current = r.currentWave === index && (r.status === "RUNNING" || r.status === "HALTED");
  return (
    <SectionCard
      title={isCanary ? t("rollouts.canaryWave") : t("rollouts.wave", { n: index + 1 })}
      desc={`${targets.length}`}
      style={{ marginBottom: 0, outline: current ? "2px solid var(--c-a)" : undefined }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        {targets.map((tg) => (
          <div key={tg.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Link href={`/apps/${tg.appId}`} className="tg-link" style={{ fontWeight: 600 }}>
                {tg.label}
              </Link>
              <StatusPill label={t(`rollouts.target_${tg.status}`)} color={targetStatusColor(tg.status)} />
              {tg.attempt > 1 && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("rollouts.attempt", { n: tg.attempt })}</span>}
              {tg.deploymentId && (
                <Link href={`/apps/${tg.appId}/deployments/${tg.deploymentId}`} className="tg-link" style={{ fontSize: 11 }}>
                  {t("rollouts.openDeploy")}
                </Link>
              )}
              {tg.rollbackDeploymentId && (
                <Link href={`/apps/${tg.appId}/deployments/${tg.rollbackDeploymentId}`} className="tg-link" style={{ fontSize: 11 }}>
                  {t("rollouts.openRollback")}
                </Link>
              )}
            </div>
            {tg.outcome && tg.status !== "SUCCEEDED" && (
              <div style={{ fontSize: 12, color: tg.status === "FAILED" || tg.status === "ROLLBACK_FAILED" ? "var(--c-r)" : "var(--c-tx3)" }} title={tg.detail ?? undefined}>
                {t(`rollouts.outcome_${tg.outcome}`)}
              </div>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
