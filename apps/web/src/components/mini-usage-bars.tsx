"use client";

import { latestTrendPoint, metricTone } from "../lib/fleet-view";
import type { FleetTrendRow } from "../lib/types";
import { MeterBar } from "./meter-bar";

const pctText = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

/**
 * Two short bars (CPU, RAM) for the newest sample of a server's last 30 minutes. This is the Servers list's
 * compact take on the Fleet numbers: bars only, the full tables and charts stay in Fleet. No recent sample renders
 * "—" for both. Each bar is a labelled progressbar, so the values are exposed as text, not just colour.
 */
export function MiniUsageBars({ row, cpuLabel, memLabel, cpuShort, memShort, noDataLabel }: { row: FleetTrendRow | undefined; cpuLabel: string; memLabel: string; cpuShort: string; memShort: string; noDataLabel: string }) {
  const p = latestTrendPoint(row);
  if (!p) return <span style={{ color: "var(--c-tx3)" }} title={noDataLabel} aria-label={noDataLabel}>—</span>;
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 120 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden="true" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--c-tx3)", width: 26 }}>{cpuShort}</span>
        <MeterBar value={p.cpu} tone={metricTone(p.cpu)} text={pctText(p.cpu)} label={cpuLabel} width={52} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden="true" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--c-tx3)", width: 26 }}>{memShort}</span>
        <MeterBar value={p.mem} tone={metricTone(p.mem)} text={pctText(p.mem)} label={memLabel} width={52} />
      </div>
    </div>
  );
}
