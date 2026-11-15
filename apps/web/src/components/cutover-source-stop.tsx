"use client";

import { useT } from "../i18n/provider";

export interface SourceStopItem { appName: string; sourceName: string | null; hostnames: string[] }

/** The printed "stop the source" steps. Tugra never stops the source (its token is read-only), so after a flip the
 *  owner does it by hand; until then clients still holding the old DNS answer keep reaching the source app. */
export function CutoverSourceStop({ items, stateful = false }: { items: SourceStopItem[]; stateful?: boolean }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div role="note" style={{ border: "1px solid var(--c-am)", borderRadius: "var(--r1)", padding: 12, background: "color-mix(in srgb, var(--c-am) 8%, transparent)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-am)", marginBottom: 6 }}>{t("cutover.sourceStop.title")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("cutover.sourceStop.body")}</p>
      <ol style={{ margin: "0 0 8px", paddingLeft: 20, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.6 }}>
        {items.map((it) => (
          <li key={`${it.appName}-${it.hostnames.join(",")}`} style={{ wordBreak: "break-word" }}>
            {t("cutover.sourceStop.step", { source: it.sourceName ?? it.appName, hostnames: it.hostnames.join(", ") })}
          </li>
        ))}
      </ol>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.5 }}>{t("cutover.sourceStop.staleDns")}</p>
      {stateful && <p style={{ fontSize: 12, color: "var(--c-r)", margin: "6px 0 0", lineHeight: 1.5 }}>{t("cutover.sourceStop.splitBrain")}</p>}
    </div>
  );
}
