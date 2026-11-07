"use client";

import { Sparkline } from "./charts";
import { trendSeries } from "../lib/fleet-view";
import type { FleetTrendRow } from "../lib/types";

/** Two compact sparklines (CPU, RAM — both pinned to 0–100%) for one server's last 30 minutes. Renders "—"
 *  placeholders when the server has no recent series. `cpuLabel`/`memLabel` are the translated accessible
 *  names; the lines carry no numbers, so they're exposed as images with those labels. */
export function TrendCell({ row, cpuLabel, memLabel, width = 56, height = 22 }: { row: FleetTrendRow | undefined; cpuLabel: string; memLabel: string; width?: number; height?: number }) {
  const s = trendSeries(row);
  // Each line carries a short, colour-matched text key ("CPU"/"RAM") and a hover title, so the two series are
  // told apart by text + position, not colour alone (WCAG 1.4.1).
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span title={cpuLabel} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        <span aria-hidden="true" style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.2, color: "var(--c-a)" }}>CPU</span>
        <Sparkline data={s.cpu} width={width} height={height} color="var(--c-a)" fixedMax={100} label={cpuLabel} />
      </span>
      <span title={memLabel} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        <span aria-hidden="true" style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.2, color: "var(--c-lapis)" }}>RAM</span>
        <Sparkline data={s.mem} width={width} height={height} color="var(--c-lapis)" fixedMax={100} label={memLabel} />
      </span>
    </div>
  );
}
