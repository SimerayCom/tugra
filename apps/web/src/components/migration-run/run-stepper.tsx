"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Clock, Loader2, PauseCircle, ShieldCheck, Undo2, XCircle } from "lucide-react";
import { useT } from "../../i18n/provider";
import { SectionCard } from "../ui";
import { MeterBar } from "../meter-bar";
import { formatDuration } from "../../lib/import";
import { codeText, isTerminalRun, progressPct, progressText } from "../../lib/migration-run";
import { stageLine, stepNoteKey, stepTitleKey } from "../../lib/inplace-run";
import { STATE_COLOR, STATE_KEY, stepElapsedSec, stepperModel, type StepperRow, type StepperState } from "../../lib/run-stepper";
import type { MigrationRunView } from "../../lib/types";
import { useRunInPlace } from "./in-place-card";

/** Re-render once a second while something is moving, so the elapsed times count. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The mark of a state: icon plus a word next to it somewhere in the row, never colour alone. */
export function StateMark({ state, size = 18 }: { state: StepperState; size?: number }) {
  const common = { size, "aria-hidden": true as const, style: { flexShrink: 0, color: STATE_COLOR[state] } };
  switch (state) {
    case "done":
      return <CheckCircle2 {...common} />;
    case "failed":
      return <XCircle {...common} />;
    case "working":
      return <Loader2 {...common} className="tg-run-spin" />;
    case "waiting":
      return <Clock {...common} />;
    case "needs-you":
      return <ShieldCheck {...common} />;
    case "paused":
      return <PauseCircle {...common} />;
    case "undone":
      return <Undo2 {...common} />;
    case "todo":
      return <Circle {...common} />;
  }
}

/** Keyframes shared by the stepper and the campaign rows (once per page is enough; a repeat is harmless). */
export function StepperStyles() {
  return (
    <style>{`
      @keyframes tg-run-slide { 0% { left: -40%; } 100% { left: 100%; } }
      .tg-run-spin { animation: spin 0.9s linear infinite; }
      .tg-run-bar > span { animation: tg-run-slide 1.4s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) { .tg-run-spin, .tg-run-bar > span { animation-duration: 4s; } }
    `}</style>
  );
}

function Row({ run, row, note, now, index, total }: { run: MigrationRunView; row: StepperRow; note: string | null; now: number; index: number; total: number }) {
  const t = useT();
  const { step, state, current } = row;
  const na = run.nextAction;
  const pct = progressPct(step.progress);
  const elapsed = stepElapsedSec(step, now);
  // the one line that says what is going on: the hub's own words for the step it is on, the in-place note, the failure, or how long it took
  let line: string | null = null;
  if (state === "failed" && step.lastError) line = codeText(t, step.lastError, step.lastErrorParams);
  // an in-place step says what the takeover is doing in its own words before the hub's generic "working on this step"
  else if (note && (state === "working" || state === "waiting")) line = t(note);
  // a step that waits for the owner says what in the "what I am waiting for" card right below; the link takes him there
  else if (na.stepKey === step.key && (state === "working" || state === "waiting" || state === "paused" || state === "failed")) line = codeText(t, na.code, na.params);
  else if (state === "done" && elapsed !== null && elapsed >= 1) line = t("migrationRun.stepper.took", { time: formatDuration(elapsed) ?? "-" });
  return (
    <li data-step={step.key} data-state={state} data-current={current ? "true" : undefined} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderTop: index === 0 ? "none" : "1px solid var(--c-bd)", minWidth: 0 }}>
      <span style={{ paddingTop: 1 }}>
        <StateMark state={state} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "baseline" }}>
          <span style={{ fontSize: 14, fontWeight: current || state === "needs-you" ? 700 : 600, color: state === "todo" ? "var(--c-tx2)" : "var(--c-tx)", flex: "1 1 160px", minWidth: 0, wordBreak: "break-word" }}>
            <span className="mono" style={{ color: "var(--c-tx3)", fontSize: 11, marginRight: 8 }}>{`${index + 1}/${total}`}</span>
            {t(stepTitleKey(run, step.key))}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: STATE_COLOR[state] }}>
            {t(STATE_KEY[state])}
            {(state === "working" || state === "waiting") && elapsed !== null && elapsed >= 1 && <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}> · {formatDuration(elapsed)}</span>}
          </span>
        </div>
        {line && <div style={{ marginTop: 2, fontSize: 13, color: state === "failed" ? "var(--c-r)" : "var(--c-tx2)", lineHeight: 1.5, wordBreak: "break-word" }}>{line}</div>}
        {state === "needs-you" && (
          <a href="#mr-next-action" className="tg-link" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, fontSize: 13, fontWeight: 600 }}>
            {t("migrationRun.stepper.goToAction")}
          </a>
        )}
        {step.progress && step.progress.total > 0 && state === "working" && (
          <div style={{ marginTop: 6 }}>
            <MeterBar value={pct} text={pct === null ? "" : `${pct}%`} grow label={t(stepTitleKey(run, step.key))} />
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>{progressText(t, step.progress)}</div>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The live step list at the top of a run page, like the updater's: the steps that apply, in order, one state word each, the current action in
 * plain words, a bar while the hub works, and how long it has been. A step that does not apply (an in-place takeover copies nothing) is counted,
 * not drawn. Says plainly that closing the page stops nothing.
 */
export function RunStepper({ run }: { run: MigrationRunView }) {
  const t = useT();
  const inPlace = useRunInPlace(run);
  const model = stepperModel(run);
  const settled = isTerminalRun(run.status);
  // the hub works on by itself only while the run runs or waits (a failed or paused run waits for the owner, a queued one for its start)
  const moving = run.status === "RUNNING" || run.status === "WAITING";
  const now = useNow(moving || model.rows.some((r) => r.state === "working" || r.state === "waiting"));
  const takeover = inPlace.data?.status ?? null;
  const currentIdx = model.rows.findIndex((r) => r.current);
  const total = model.rows.length;
  const startMs = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  const runSec = startMs !== null ? Math.max(0, Math.round(((endMs ?? now) - startMs) / 1000)) : null;
  const note = run.status === "QUEUED" ? t("migrationRun.stepper.queuedNote") : moving ? t("migrationRun.stepper.closeNote") : null;
  return (
    <SectionCard title={t("migrationRun.stepper.title")} style={{ marginBottom: 0 }}>
      <StepperStyles />
      <div data-testid="run-stepper" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--c-tx2)" }}>
          <span>{currentIdx >= 0 && !settled ? t("migrationRun.stepper.stepOf", { n: currentIdx + 1, total }) : t("migrationRun.stepper.doneOf", { done: model.done, total })}</span>
          {runSec !== null && <span data-testid="run-elapsed">{t("migrationRun.stepper.elapsed", { time: formatDuration(runSec) ?? "0 s" })}</span>}
        </div>
        {model.working && moving && (
          <div className="tg-run-bar" aria-hidden style={{ position: "relative", height: 4, borderRadius: 2, background: "var(--c-bd)", overflow: "hidden" }}>
            <span style={{ position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: 2, background: "var(--c-a)" }} />
          </div>
        )}
        {run.inPlace && inPlace.data && (
          <p data-testid="run-stepper-stage" style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
            {t(inPlace.data.status === "FAILED" || inPlace.data.status === "GIVEN_BACK" || inPlace.data.status === "GIVING_BACK" ? `coolifyInPlace.status.${inPlace.data.status}` : "inPlaceRun.stageLine", {
              stage: t(`inPlaceRun.stage.${stageLine(inPlace.data.status, inPlace.data.verified).stage}`),
              n: stageLine(inPlace.data.status, inPlace.data.verified).n,
            })}
          </p>
        )}
        {note && (
          <p role="note" data-testid="run-stepper-note" style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{note}</p>
        )}
        <ol aria-label={t("migrationRun.stepper.title")} aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {model.rows.map((r, i) => (
            <Row key={r.step.key} run={run} row={r} note={run.inPlace ? stepNoteKey(r.step.key, takeover) : null} now={now} index={i} total={total} />
          ))}
        </ol>
        {model.hidden > 0 && !run.inPlace && (
          <p data-testid="run-stepper-hidden" style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
            {t("migrationRun.stepper.hidden", { count: model.hidden })}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
