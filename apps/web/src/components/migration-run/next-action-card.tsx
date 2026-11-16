"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Hourglass } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { ActivitySpinner, Btn, SectionCard } from "../ui";
import { formatDuration } from "../../lib/import";
import { NEXT_KIND_KEY, STEP_TITLE_KEY, blockingChecks, codeText, secondsUntil } from "../../lib/migration-run";
import type { MigrationRunStepView, MigrationRunView } from "../../lib/types";
import { relativeTime } from "../../lib/fleet";
import { ApprovalForm } from "./approval-form";
import { GateChecks } from "./gate-checks";
import { OperatorTools } from "./operator-tools";
import { SourceSessionForm } from "./source-session-card";
import { useRunPlumbing } from "./use-run-actions";

/** Re-render once a second while a countdown is shown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "What I am waiting for": exactly one card, naming what is needed, since when, and the controls to provide it. */
export function NextActionCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const na = run.nextAction;
  const { adopt, onError } = useRunPlumbing(run.id);
  const step: MigrationRunStepView | undefined = na.stepKey ? run.steps.find((s) => s.key === na.stepKey) : undefined;
  const now = useNow(na.kind === "timer");
  const resume = useMutation({ mutationFn: () => api.resumeMigrationRun(run.id), onSuccess: adopt, onError });
  const retry = useMutation({ mutationFn: () => api.retryMigrationRunStep(run.id, step!.key), onSuccess: adopt, onError });
  const stepName = step ? t(STEP_TITLE_KEY[step.key]) : null;
  const left = na.kind === "timer" ? secondsUntil(na.notBefore ?? step?.notBefore ?? null, now) : null;

  return (
    <SectionCard
      title={t("migrationRun.next.title")}
      right={na.kind !== "none" && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.next.since", { when: relativeTime(na.since) })}</span>}
      style={{ marginBottom: 0 }}
    >
      <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          {na.kind === "engine" ? <ActivitySpinner size={14} /> : <Hourglass size={16} aria-hidden color="var(--c-tx3)" style={{ flexShrink: 0, marginTop: 2 }} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {t(NEXT_KIND_KEY[na.kind])}
              {stepName && <> · {stepName}</>}
            </div>
            <div style={{ fontSize: 14, marginTop: 2, wordBreak: "break-word", lineHeight: 1.5 }}>{codeText(t, na.code, na.params)}</div>
          </div>
        </div>

        {na.kind === "timer" && left !== null && (
          <div role="timer" style={{ fontSize: 13, color: "var(--c-tx2)" }}>
            {left > 0 ? t("migrationRun.next.timerLeft", { time: formatDuration(left) ?? "0 s" }) : t("migrationRun.next.timerDue")}
          </div>
        )}

        {na.kind === "operator" && step && <OperatorTools runId={run.id} step={step} attest={na.attest} offersCommand={na.offersCommand} />}

        {na.kind === "approval" && step && na.approval && <ApprovalForm key={step.key} run={run} stepKey={step.key} binding={na.approval} gate={step.gate} />}

        {na.kind === "gate" && step && (
          <>
            <GateChecks checks={blockingChecks(step.gate)} />
            {step.allowed.retry && (
              <div>
                <Btn variant="ghost" onClick={() => retry.mutate()} loading={retry.isPending}>{t("migrationRun.next.recheck")}</Btn>
              </div>
            )}
          </>
        )}

        {na.kind === "session" && <SourceSessionForm runId={run.id} />}

        {na.kind === "paused" && run.allowed.resume && (
          <div>
            <Btn onClick={() => resume.mutate()} loading={resume.isPending}>{t("migrationRun.actions.resume")}</Btn>
          </div>
        )}

        {na.kind === "failed" && (
          <>
            {step?.lastError && <div style={{ fontSize: 13, color: "var(--c-r)", wordBreak: "break-word" }}>{codeText(t, step.lastError)}</div>}
            {step?.gate && blockingChecks(step.gate).length > 0 && <GateChecks checks={blockingChecks(step.gate)} />}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {step?.allowed.retry && <Btn onClick={() => retry.mutate()} loading={retry.isPending}>{t("migrationRun.next.retry")}</Btn>}
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.next.failedHint")}</p>
          </>
        )}
      </div>
    </SectionCard>
  );
}
