"use client";

import { useT } from "../../i18n/provider";
import { heldWorkersOf } from "../../lib/migration-run";
import type { MigrationRunView } from "../../lib/types";
import { Badge, SectionCard } from "../ui";

const POLICY_KEY = {
  "hold-dark": "migrationRun.heldWorkers.holdDark",
  exclude: "migrationRun.heldWorkers.exclude",
  "start-dark": "migrationRun.heldWorkers.startDark",
} as const;
const POLICY_TONE = { "hold-dark": "ok", exclude: "muted", "start-dark": "warn" } as const;

/** The workers PREFLIGHT found (apps with no domain, or marked job runners) and what the run does with them: kept stopped until
 *  after the cutover, left out, or started next to the source. The whole list, one name per line. Shown only for a run that has one. */
export function HeldWorkersCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const w = heldWorkersOf(run);
  if (!w) return null;
  return (
    <SectionCard title={t("migrationRun.heldWorkers.title")} right={<Badge tone={POLICY_TONE[w.policy]}>{w.count}</Badge>} style={{ marginBottom: 0 }}>
      <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.5 }}>{t(POLICY_KEY[w.policy], { count: w.count })}</p>
      <ul aria-label={t("migrationRun.heldWorkers.listLabel")} style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "6px 14px", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))" }}>
        {w.names.map((n, i) => (
          <li key={`${n}:${i}`} className="mono" style={{ fontSize: 12, wordBreak: "break-all", minWidth: 0 }}>{n}</li>
        ))}
      </ul>
      <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.heldWorkers.hint")}</p>
    </SectionCard>
  );
}
