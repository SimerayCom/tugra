"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/fleet";
import { bannerWorthy, codeText, detailVars, isTerminalPhase, moveSteps, pollInterval, volumeProgress } from "../lib/app-move";
import type { AppMove, AppMovePhase } from "../lib/types";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { useOptionalConfirm } from "./confirm";
import { Btn, Card } from "./ui";

const barTrack = { height: 6, borderRadius: 3, background: "var(--c-el)", overflow: "hidden", flex: 1, minWidth: 80 } as const;

/**
 * The live face of a move on the app page. While a move is active it polls GET /apps/:id/moves?active=true every 2 s
 * (React Query pauses it while the tab is hidden, backs off exponentially after consecutive errors, and stops once the move
 * is terminal). On a terminal transition it toasts once and refreshes the page data. After the move it stays as the archive
 * card (COMPLETED, with "Remove old copy now"), the rolled-back notice, or the needs-attention card (FAILED) until handled.
 */
export function AppMoveBanner({ appId, teamId, move, canWrite }: { appId: string; teamId: string; move: { id: string; phase: AppMovePhase } | null | undefined; canWrite: boolean }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useOptionalConfirm();
  const active = !!move;
  const [dismissed, setDismissed] = useState<string | null>(null);

  const activeQ = useQuery({
    queryKey: ["app-moves", appId, "active"],
    queryFn: () => api.getAppMoves(appId, { active: true }),
    enabled: active,
    retry: false,
    refetchInterval: (q) => {
      const m = q.state.data?.[0];
      if (q.state.data && (!m || isTerminalPhase(m.phase))) return false; // finished: stop polling
      return pollInterval(q.state.fetchFailureCount);
    },
  });
  const latestQ = useQuery({ queryKey: ["app-moves", appId, "latest"], queryFn: () => api.getAppMoves(appId, { limit: 1 }), retry: false });
  const { data: servers = [] } = useQuery({ queryKey: ["servers", teamId], queryFn: () => api.listServers({ teamId }), enabled: active || !!latestQ.data?.[0] });

  const current: AppMove | undefined = activeQ.data?.[0] ?? latestQ.data?.[0];
  const phase = current?.phase ?? move?.phase;

  // The active poll came back empty: the move ended — fetch its terminal state once.
  useEffect(() => {
    if (active && activeQ.data && activeQ.data.length === 0) void latestQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeQ.data]);

  // Terminal transition: one toast + refresh the page's data (the app moved, its status and deployments changed).
  const seenActive = useRef(false);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (active) seenActive.current = true;
  }, [active]);
  useEffect(() => {
    if (!current || !seenActive.current || !isTerminalPhase(current.phase) || announced.current === current.id) return;
    announced.current = current.id;
    seenActive.current = false;
    const kind = current.phase === "COMPLETED" ? "success" : current.phase === "ROLLED_BACK" ? "info" : "error";
    toast(current.phase === "COMPLETED" ? t("apps.moveCompleted") : current.phase === "ROLLED_BACK" ? t("apps.moveRolledBack") : t("apps.moveFailedNeedsAttention"), kind);
    void qc.invalidateQueries({ queryKey: ["app", appId] });
    void qc.invalidateQueries({ queryKey: ["apps"] });
    void qc.invalidateQueries({ queryKey: ["deployments", appId] });
    router.refresh();
  }, [current, toast, t, qc, appId, router]);

  const cancel = useMutation({
    mutationFn: () => api.cancelAppMove(appId, current!.id),
    onSuccess: () => void activeQ.refetch(),
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.actionFailed"), "error"),
  });
  const purge = useMutation({
    mutationFn: () => api.purgeMoveSource(appId, current!.id),
    onSuccess: () => {
      toast(t("apps.movePurged"), "success");
      void latestQ.refetch();
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.actionFailed"), "error"),
  });

  if (!current || !phase || dismissed === current.id) return null;
  if (!active && !bannerWorthy(current)) return null;

  const name = (id: string): string => servers.find((s) => s.id === id)?.name ?? id;
  const terminal = isTerminalPhase(current.phase);
  const accent = current.phase === "COMPLETED" ? "var(--c-g)" : current.phase === "FAILED" ? "var(--c-r)" : "var(--c-am)";
  const reason = current.failureReason ? codeText(t, "Err", current.failureReason) : "";
  const steps = moveSteps(current.phase, current.failurePhase);
  const date = current.archiveUntil ? new Date(current.archiveUntil).toLocaleDateString() : "";
  const showArchive = current.phase === "COMPLETED" && !!current.archiveUntil && !current.sourcePurgedAt;

  const onCancel = async (): Promise<void> => {
    if (confirm && !(await confirm({ body: t("apps.moveCancelConfirm"), danger: true }))) return;
    cancel.mutate();
  };
  const onPurge = async (): Promise<void> => {
    if (confirm && !(await confirm({ body: t("apps.movePurgeConfirm"), danger: true }))) return;
    purge.mutate();
  };

  return (
    <Card style={{ margin: "14px 0", padding: "12px 14px", borderLeft: `3px solid ${accent}` }}>
      <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {!terminal && <Loader2 size={15} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            {current.phase === "COMPLETED"
              ? t("apps.moveCompleted")
              : current.phase === "ROLLED_BACK"
                ? t("apps.moveRolledBack")
                : current.phase === "FAILED"
                  ? t("apps.moveFailedNeedsAttention")
                  : t("apps.moveBannerRunning", { target: name(current.targetServerId) })}
          </div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 2 }}>
            {terminal ? (
              current.phase === "COMPLETED" ? (
                showArchive ? t("apps.moveCompletedBody", { date }) : t("apps.moveCompletedNoArchive")
              ) : current.phase === "ROLLED_BACK" ? (
                t("apps.moveRolledBackBody", { reason })
              ) : (
                t("apps.moveFailedBody", { reason })
              )
            ) : (
              t(`apps.movePhase_${current.phase}`)
            )}
          </div>
        </div>
        {!terminal && canWrite && current.canCancel && (
          <Btn variant="ghost" onClick={() => void onCancel()} loading={cancel.isPending}>{t("apps.moveCancelMove")}</Btn>
        )}
        {showArchive && canWrite && <Btn variant="ghost" onClick={() => void onPurge()} loading={purge.isPending}>{t("apps.movePurgeSource")}</Btn>}
        {current.phase === "FAILED" && canWrite && <Btn variant="ghost" onClick={() => void onPurge()} loading={purge.isPending}>{t("apps.moveFailedClear")}</Btn>}
        {terminal && current.phase !== "FAILED" && <Btn variant="ghost" onClick={() => setDismissed(current.id)}>{t("apps.moveDismiss")}</Btn>}
      </div>

      {!terminal && (
        <>
          <ol aria-label={t("apps.moveStep_progress")} style={{ display: "flex", gap: 14, listStyle: "none", padding: 0, margin: "10px 0 0", flexWrap: "wrap" }}>
            {steps.map((s) => (
              <li key={s.key} data-state={s.state} style={{ fontSize: 12, fontWeight: s.state === "active" ? 700 : 500, color: s.state === "done" ? "var(--c-g)" : s.state === "active" ? "var(--c-tx)" : s.state === "failed" ? "var(--c-r)" : "var(--c-tx3)" }}>
                {s.state === "done" ? "✓ " : ""}
                {t(`apps.movePhase_${s.key}`)}
              </li>
            ))}
          </ol>
          {current.phase === "TRANSFERRING" && current.volumes.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {current.volumes.filter((v) => v.state !== "SKIPPED").map((v) => (
                <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
                  <span className="mono" style={{ minWidth: 90 }}>{v.name}</span>
                  <div style={barTrack} role="progressbar" aria-label={v.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(volumeProgress(v) * 100)}>
                    <div style={{ width: `${Math.round(volumeProgress(v) * 100)}%`, height: "100%", background: "var(--c-lapis)", transition: "width .3s" }} />
                  </div>
                  <span style={{ color: "var(--c-tx3)" }}>{v.parts > 0 ? t("apps.moveBannerParts", { done: v.partsDone, total: v.parts }) : "…"}</span>
                </div>
              ))}
              {current.progress.bytesTotal > 0 && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("apps.moveBannerBytes", { done: fmtBytes(current.progress.bytesDone), total: fmtBytes(current.progress.bytesTotal) })}</span>}
            </div>
          )}
        </>
      )}

      {current.warnings.length > 0 && terminal && (
        <details style={{ marginTop: 8, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--c-tx2)" }}>{t("apps.moveWarningsHeading")} ({current.warnings.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--c-tx3)", lineHeight: 1.5 }}>
            {current.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{codeText(t, "Warn", w.code, "", detailVars(w.details))}</li>
            ))}
          </ul>
        </details>
      )}
      {terminal && current.logTail && (current.phase === "FAILED" || current.phase === "ROLLED_BACK") && (
        <details style={{ marginTop: 8, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--c-tx2)" }}>{t("apps.moveLog")}</summary>
          <pre className="mono" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--c-tx3)", maxHeight: 200, overflow: "auto" }}>{current.logTail}</pre>
        </details>
      )}
    </Card>
  );
}
