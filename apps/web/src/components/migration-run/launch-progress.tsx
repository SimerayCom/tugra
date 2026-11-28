"use client";

import { useT } from "../../i18n/provider";

export type LaunchStepState = "done" | "working" | "waiting";

const STATE_KEY: Record<LaunchStepState, string> = {
  done: "migrationRun.launch.progress.state.done",
  working: "migrationRun.launch.progress.state.working",
  waiting: "migrationRun.launch.progress.state.waiting",
};

/** What the launch is doing, run by run: the hub makes the runs one after the other, so the owner sees which one is being made now
 *  instead of a spinning button. `phase` "starting" is the last part: the first wave is started once every run exists. */
export function LaunchProgress({ names, done, phase }: { names: string[]; done: number; phase: "creating" | "starting" }) {
  const t = useT();
  const total = Math.max(names.length, 1);
  const made = phase === "starting" ? total : Math.min(done, total);
  const current = Math.min(made + 1, total);
  const pct = Math.round((made / total) * 100);
  const stateOf = (i: number): LaunchStepState => (i < made ? "done" : i === made && phase === "creating" ? "working" : "waiting");
  return (
    <section data-testid="launch-progress" aria-label={t("migrationRun.launch.progress.title")} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{t("migrationRun.launch.progress.title")}</h2>
      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        {phase === "starting" ? t("migrationRun.launch.progress.starting") : names.length === 0 ? t("migrationRun.launch.progress.creatingOne") : t("migrationRun.launch.progress.creating", { current, total: names.length, name: names[current - 1] ?? "" })}
      </p>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("migrationRun.launch.progress.title")} style={{ height: 6, borderRadius: 3, background: "var(--c-el)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--c-a)", transition: "width 0.4s" }} />
      </div>
      {names.length > 0 && (
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {names.map((n, i) => {
            const st = stateOf(i);
            return (
              <li key={`${i}:${n}`} data-state={st} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 13, color: st === "waiting" ? "var(--c-tx3)" : "var(--c-tx)" }}>
                <span style={{ minWidth: 72, fontWeight: 600, fontSize: 12, color: st === "done" ? "var(--c-g)" : st === "working" ? "var(--c-a)" : "var(--c-tx3)" }}>{t(STATE_KEY[st])}</span>
                <span style={{ overflowWrap: "anywhere" }}>{n}</span>
              </li>
            );
          })}
        </ol>
      )}
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.launch.progress.note")}</p>
    </section>
  );
}
