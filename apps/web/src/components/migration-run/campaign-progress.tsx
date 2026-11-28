"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "../../i18n/provider";
import { formatDuration } from "../../lib/import";
import { Badge, Btn, Card, SectionCard } from "../ui";
import { STEP_TITLE_KEY, blockingChecks, codeText, type CampaignRunRow } from "../../lib/migration-run";
import { STATE_COLOR, STATE_KEY, isSwitching, needsYou, stepperModel } from "../../lib/run-stepper";
import type { MigrationRunView } from "../../lib/types";
import { RunStatusPill } from "./badges";
import { ApprovalForm } from "./approval-form";
import { GateChecks } from "./gate-checks";
import { StateMark, StepperStyles } from "./run-stepper";

const dash = "-";

/** How a run is named on the campaign page: the server it lands on (in place, that is the server itself) or source to targets. */
export function runName(t: ReturnType<typeof useT>, row: Pick<CampaignRunRow, "inPlace" | "sourceHost" | "targetNames">): string {
  return row.inPlace ? row.targetNames.join(", ") : t("migrationRun.campaign.hosts", { source: row.sourceHost ?? dash, targets: row.targetNames.join(", ") });
}

/** A strip of small marks, one per step that applies: where the run is at a glance. The words are in the row below it. */
function MiniSteps({ run, label }: { run: MigrationRunView; label: string }) {
  const t = useT();
  const model = stepperModel(run);
  return (
    <ol aria-label={label} data-testid="mini-steps" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
      {model.rows.map((r) => (
        <li key={r.step.key} data-step={r.step.key} data-state={r.state} title={`${t(STEP_TITLE_KEY[r.step.key])}: ${t(STATE_KEY[r.state])}`} style={{ display: "inline-flex", opacity: r.state === "todo" ? 0.55 : 1 }}>
          <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{`${t(STEP_TITLE_KEY[r.step.key])}: ${t(STATE_KEY[r.state])}`}</span>
          <StateMark state={r.state} size={16} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One server of the campaign: its wave, the strip of its steps, the step it is on in words with the action line, and (when the hub waits for
 * the owner) a short note that sends him to the "Needs you" list above. Collapses to a column on a phone.
 */
export function WaveRow({ row, teamName = null, view, rank, count, wave }: { row: CampaignRunRow; teamName?: string | null; view: MigrationRunView | undefined; rank?: number; count: number; wave: boolean }) {
  const t = useT();
  const name = runName(t, row);
  const model = view ? stepperModel(view) : null;
  const current = model?.rows.find((r) => r.current) ?? model?.rows.find((r) => r.state !== "done" && r.state !== "todo") ?? null;
  const na = view?.nextAction;
  const queued = row.status === "QUEUED";
  const line = current && na && na.stepKey === current.step.key ? codeText(t, na.code, na.params) : null;
  const switched = row.items && row.inPlace ? row.items.moved : 0;
  // "N of M apps switched": M is what this server's move was about. The import also lists every other task of the whole Coolify session as skipped
  // (they are not part of this run), so a same-machine run leaves the skipped ones out instead of reading "2 of 132". This is a stopgap for
  // finding 10 (the importer's skipped list is not scoped to the run); once that is scoped, drop it so a server's own skipped apps count again.
  const itemsTotal = row.items ? row.items.moved + row.items.failed + row.items.notCutOver + row.items.acked + (row.inPlace ? 0 : row.items.skipped) : 0;
  return (
    <li data-testid="wave-row" data-run={row.id}>
      <Card style={{ padding: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", alignItems: "center" }}>
          <span style={{ fontWeight: 600, wordBreak: "break-word", flex: "1 1 200px", minWidth: 0 }}>{name}</span>
          <RunStatusPill status={row.status} />
          <Link href={`/import/runs/${row.id}`} className="tg-link" aria-label={t("migrationRun.campaign.openRun", { id: row.id.slice(0, 8) })} style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontSize: 13, fontWeight: 600 }}>
            {t("migrationRun.campaignRun.open")}
          </Link>
        </div>
        <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12, color: "var(--c-tx3)" }}>
          {teamName && <Badge tone="muted">{teamName}</Badge>}
          {wave && rank !== undefined && <Badge tone="muted">{t("migrationRun.campaignRun.wave", { n: rank, total: count })}</Badge>}
          {row.dryRun && <Badge tone="lapis">{t("migrationRun.dryRun")}</Badge>}
          {row.inPlace && <Badge tone="ok">{t("inPlaceRun.badge")}</Badge>}
        </div>
        {view && model && model.rows.length > 0 && !queued && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <MiniSteps run={view} label={t("migrationRun.campaignRun.stepList", { name })} />
            {current && (
              <div style={{ fontSize: 13, lineHeight: 1.5, wordBreak: "break-word" }}>
                <span style={{ fontWeight: 600 }}>{t(STEP_TITLE_KEY[current.step.key])}</span>
                <span style={{ color: STATE_COLOR[current.state], fontWeight: 600 }}> · {t(STATE_KEY[current.state])}</span>
                {line && <div style={{ color: "var(--c-tx2)" }}>{line}</div>}
              </div>
            )}
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("migrationRun.campaignRun.stepsDone", { done: model.done, total: model.rows.length })}</div>
          </div>
        )}
        {queued && <div style={{ marginTop: 8, fontSize: 13, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.campaignRun.notStarted")}</div>}
        {!queued && !view && row.currentStep && <div style={{ marginTop: 8, fontSize: 13, color: "var(--c-tx2)" }}>{t(STEP_TITLE_KEY[row.currentStep])}</div>}
        {row.inPlace && switched > 0 && <div style={{ marginTop: 6, fontSize: 12, color: "var(--c-tx2)" }}>{t("migrationRun.campaignRun.appsSwitched", { moved: switched, total: itemsTotal })}</div>}
        {!row.inPlace && (
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.6 }}>
            {(row.estimatedSec !== null || row.measuredSec !== null) && <div>{t("migrationRun.campaign.window", { estimated: row.estimatedSec === null ? dash : (formatDuration(row.estimatedSec) ?? dash), measured: row.measuredSec === null ? dash : (formatDuration(row.measuredSec) ?? dash) })}</div>}
            {row.items && <div>{t("migrationRun.campaign.items", row.items)}</div>}
          </div>
        )}
        {row.failure && <div style={{ marginTop: 6, fontSize: 12, color: "var(--c-r)", wordBreak: "break-word" }}>{codeText(t, row.failure.code)}</div>}
      </Card>
    </li>
  );
}

/**
 * "Needs you": every server whose run waits for the owner, with what it waits for. An approval is reviewed and given right here (the same form
 * as on the run page); anything else opens the run. While another server of the campaign is switching, the approval says so and waits its turn.
 */
export function NeedsYouList({ items, views, nameOf }: { items: string[]; views: ReadonlyMap<string, MigrationRunView | undefined>; nameOf: (id: string) => string }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <SectionCard title={t("migrationRun.campaignRun.needsTitle")} style={{ marginBottom: 0 }}>
      <StepperStyles />
      <ul data-testid="needs-you" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((id) => {
          const run = views.get(id);
          if (!run) return null;
          const na = run.nextAction;
          const name = nameOf(id);
          const step = na.stepKey ? run.steps.find((s) => s.key === na.stepKey) : undefined;
          const approvable = na.kind === "approval" && !!step && !!na.approval;
          const waitsForTurn = approvable && [...views.values()].some((o) => o && o.id !== id && isSwitching(o));
          const title = approvable ? t("migrationRun.campaignRun.needsApprove", { name }) : na.kind === "failed" ? t("migrationRun.campaignRun.needsFailed", { name }) : t("migrationRun.campaignRun.needsWaiting", { name });
          const expanded = open === id;
          return (
            <li key={id} data-testid="needs-you-item" data-run={id} style={{ border: "1px solid var(--c-am)", borderRadius: "var(--r1)", padding: 12, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, wordBreak: "break-word" }}>{title}</div>
              <div style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, wordBreak: "break-word" }}>{codeText(t, na.code, na.params)}</div>
              {na.kind === "failed" && step?.lastError && <div style={{ fontSize: 12, color: "var(--c-r)", wordBreak: "break-word" }}>{codeText(t, step.lastError)}</div>}
              {step && na.kind === "gate" && blockingChecks(step.gate).length > 0 && <GateChecks checks={blockingChecks(step.gate)} />}
              {waitsForTurn && <p role="note" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t("migrationRun.campaignRun.swapBusy")}</p>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {approvable && !waitsForTurn && (
                  <Btn onClick={() => setOpen(expanded ? null : id)} aria-expanded={expanded} style={{ minHeight: 44 }}>
                    {expanded ? t("migrationRun.campaignRun.hideReview") : t("migrationRun.campaignRun.review")}
                  </Btn>
                )}
                <Link href={`/import/runs/${id}`} className="tg-link" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontSize: 13, fontWeight: 600 }}>
                  {t("migrationRun.campaignRun.openRun")}
                </Link>
              </div>
              {approvable && !waitsForTurn && expanded && step && na.approval && <ApprovalForm key={step.key} run={run} stepKey={step.key} binding={na.approval} gate={step.gate} />}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
