"use client";

import { useState } from "react";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { STEP_TITLE_KEY, codeText } from "../../lib/migration-run";
import type { MigrationRunEvent } from "../../lib/types";

const LEVEL_COLOR = { info: "var(--c-tx3)", warn: "var(--c-am)", error: "var(--c-r)" } as const;
const LEVEL_KEY = { info: "migrationRun.events.level.info", warn: "migrationRun.events.level.warn", error: "migrationRun.events.level.error" } as const;
const SHOWN = 30;

/** The run's event log, newest first. Each line is a localized code with its params; the level is a word, not just a colour. */
export function EventLog({ events, error }: { events: MigrationRunEvent[]; error: boolean }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const newest = [...events].reverse();
  const shown = all ? newest : newest.slice(0, SHOWN);
  return (
    <SectionCard title={t("migrationRun.events.title")} desc={t("migrationRun.events.desc")} style={{ marginBottom: 0 }}>
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--c-am)", marginBottom: 8 }}>{t("migrationRun.events.error")}</div>}
      {events.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("migrationRun.events.empty")}</div>
      ) : (
        <ol aria-label={t("migrationRun.events.title")} style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {shown.map((e) => (
            <li key={e.seq} style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 13, minWidth: 0 }}>
              <time dateTime={e.at} className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", flexShrink: 0 }}>{new Date(e.at).toLocaleTimeString()}</time>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: LEVEL_COLOR[e.level], flexShrink: 0 }}>{t(LEVEL_KEY[e.level])}</span>
              {e.stepKey && <span style={{ fontSize: 11, color: "var(--c-tx3)", flexShrink: 0 }}>{t(STEP_TITLE_KEY[e.stepKey])}</span>}
              <span style={{ flex: "1 1 220px", minWidth: 0, wordBreak: "break-word" }}>{codeText(t, e.code, e.params)}</span>
            </li>
          ))}
        </ol>
      )}
      {!all && newest.length > SHOWN && (
        <div style={{ marginTop: 10 }}>
          <Btn variant="ghost" onClick={() => setAll(true)}>{t("migrationRun.events.showAll", { n: newest.length })}</Btn>
        </div>
      )}
    </SectionCard>
  );
}
