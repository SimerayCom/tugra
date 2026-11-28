"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { ActivitySpinner, Btn, LinkBtn, SectionCard } from "../ui";
import { formatDuration } from "../../lib/import";
import { blockingChecks, campaignReportHref, codeText, secondsUntil } from "../../lib/migration-run";
import { nextHeadingKey, siteCounts } from "../../lib/inplace-run";
import type { MigrationRunStepView, MigrationRunView } from "../../lib/types";
import { AgentSessionReconnect } from "./agent-session-reconnect";
import { GateChecks } from "./gate-checks";
import { GiveBackButton } from "./give-back";
import { InPlaceApproval } from "./in-place-approval";
import { useRunInPlace } from "./in-place-card";
import { OperatorTools } from "./operator-tools";
import { SourceSessionForm } from "./source-session-card";
import { useRunPlumbing } from "./use-run-actions";
import { useStartRun } from "./run-actions";

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

/** The finished move: what was moved, in one sentence, and the one thing to do next (bring the next server). */
function DoneBody({ run }: { run: MigrationRunView }) {
  const t = useT();
  const takeover = useRunInPlace(run);
  const sites = takeover.data ? siteCounts(takeover.data.items).certified : 0;
  return (
    <div data-testid="in-place-done" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{sites > 0 ? t("inPlaceRun.done.body", { sites }) : t("inPlaceRun.done.bodyNoSites")}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <LinkBtn href="/import/move-off-coolify">{t("inPlaceRun.done.another")}</LinkBtn>
        {run.campaign && (
          <LinkBtn href={campaignReportHref(run.campaign)} variant="ghost">
            {t("inPlaceRun.done.campaign")}
          </LinkBtn>
        )}
      </div>
    </div>
  );
}

/**
 * The one card of an in-place run page: what is happening now or what is needed from the owner, in one heading, one sentence and at most
 * one primary button (Try again, Take over, Resume). Giving Coolify back is always the quiet second button. The technical kind label
 * and "since" are not drawn: the step list above already says where the run is.
 */
export function InPlaceNextCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const na = run.nextAction;
  const { adopt, onError } = useRunPlumbing(run.id);
  const takeover = useRunInPlace(run);
  const step: MigrationRunStepView | undefined = na.stepKey ? run.steps.find((s) => s.key === na.stepKey) : undefined;
  const now = useNow(na.kind === "timer");
  const resume = useMutation({ mutationFn: () => api.resumeMigrationRun(run.id), onSuccess: adopt, onError });
  const retry = useMutation({ mutationFn: () => api.retryMigrationRunStep(run.id, step!.key), onSuccess: adopt, onError });
  const left = na.kind === "timer" ? secondsUntil(na.notBefore ?? step?.notBefore ?? null, now) : null;
  const done = run.status === "COMPLETED";
  const ended = ["ABORTED", "ROLLED_BACK", "REVERSED"].includes(run.status);
  const switched = takeover.data?.status === "SWAPPING" || takeover.data?.status === "SWAPPED" || takeover.data?.status === "VERIFIED";
  const heading = t(nextHeadingKey(na.kind, na.stepKey, run.status));
  const queued = run.status === "QUEUED";
  const busy = !queued && (na.kind === "engine" || (na.kind === "none" && run.status === "RUNNING"));
  const { onStart, pending: starting } = useStartRun(run);
  const serverHref = `/servers/${run.targetServerId}`;

  return (
    <SectionCard style={{ marginBottom: 0 }}>
      <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {busy ? <ActivitySpinner size={14} /> : done ? <CheckCircle2 size={18} color="var(--c-g)" aria-hidden style={{ flexShrink: 0 }} /> : null}
          <h2 data-testid="in-place-next-heading" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{heading}</h2>
        </div>

        {done && <DoneBody run={run} />}

        {!done && !ended && (
          <>
            {queued && (
              <>
                <p data-testid="in-place-ready" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{t("inPlaceRun.next.readyBody")}</p>
                {run.allowed.start && (
                  <div>
                    <Btn onClick={onStart} loading={starting}>{t("inPlaceRun.next.start")}</Btn>
                  </div>
                )}
              </>
            )}

            {!queued && (na.kind === "engine" || na.kind === "none") && (
              <>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>{codeText(t, na.code, na.params)}</p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("inPlaceRun.next.waitNote")}</p>
              </>
            )}

            {na.kind === "timer" && (
              <>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{t("inPlaceRun.next.timerNote")}</p>
                {left !== null && (
                  <div role="timer" style={{ fontSize: 13, color: "var(--c-tx2)" }}>
                    {left > 0 ? t("migrationRun.next.timerLeft", { time: formatDuration(left) ?? "0 s" }) : t("migrationRun.next.timerDue")}
                  </div>
                )}
              </>
            )}

            {na.kind === "operator" && step && <OperatorTools runId={run.id} step={step} attest={na.attest} offersCommand={na.offersCommand} runnerIsHostLoop={run.options.sourceRunner === "coolify-host-loop"} />}

            {na.kind === "approval" && step && na.approval && <InPlaceApproval key={step.key} run={run} stepKey={step.key} binding={na.approval} gate={step.gate} />}

            {na.kind === "gate" && step && (
              <>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>{codeText(t, na.code, na.params)}</p>
                <GateChecks checks={blockingChecks(step.gate)} hideInputLinks inPlaceServerHref={serverHref} />
                {step.allowed.retry && (
                  <div>
                    <Btn onClick={() => retry.mutate()} loading={retry.isPending}>{t("migrationRun.next.recheck")}</Btn>
                  </div>
                )}
              </>
            )}

            {run.allowed.sourceSession && (na.kind === "session" || (run.sourceSession != null && run.sourceSession.state !== "active")) && (run.sourceSession?.viaAgent === true && !run.dryRun ? <AgentSessionReconnect runId={run.id} /> : <SourceSessionForm runId={run.id} />)}

            {na.kind === "paused" && run.allowed.resume && (
              <div>
                <Btn onClick={() => resume.mutate()} loading={resume.isPending}>{t("migrationRun.actions.resume")}</Btn>
              </div>
            )}

            {na.kind === "failed" && (
              <>
                {step?.lastError && <p role="alert" style={{ margin: 0, fontSize: 14, color: "var(--c-r)", lineHeight: 1.5, wordBreak: "break-word" }}>{codeText(t, step.lastError, step.lastErrorParams)}</p>}
                {step?.gate && blockingChecks(step.gate).length > 0 && <GateChecks checks={blockingChecks(step.gate)} hideInputLinks inPlaceServerHref={serverHref} />}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {step?.allowed.retry && <Btn onClick={() => retry.mutate()} loading={retry.isPending}>{t(step.key === "DEPLOY_DARK" ? "inPlaceRun.next.testAgain" : "inPlaceRun.next.retry")}</Btn>}
                  <GiveBackButton run={run} />
                </div>
                {takeover.data && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t(switched ? "inPlaceRun.next.failedHintSwitched" : "inPlaceRun.next.failedHintSafe")}</p>}
              </>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
