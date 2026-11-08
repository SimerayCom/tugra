"use client";

import Link from "next/link";
import { useGuardedPush } from "../hooks/useUnsavedChanges";
import { memo, useMemo, useState } from "react";
import type { FleetRow } from "../lib/fleet-view";
import type { FleetTrendRow } from "../lib/types";
import type { WallMetric } from "../lib/fleet-wall";
import { buildHeatmap, heatHasTrend, heatStep, HEAT_PAGE, HEAT_STEPS, type HeatRow } from "../lib/fleet-heatmap";
import { useT } from "../i18n/provider";
import { Card, EmptyState, StatusDot } from "./ui";
import { Skeleton } from "./skeleton";
import { formatStamp, formatTick, pickTimeTicks } from "./charts";

const enc = encodeURIComponent;
const METRIC_LABEL_KEY: Record<WallMetric, string> = { cpu: "fleet.colCpu", mem: "fleet.colMem", disk: "fleet.colDisk", net: "fleet.colNet" };
const pctText = (v: number) => `${v.toFixed(0)}%`;

const sameCells = (a: (number | null)[], b: (number | null)[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameStamps = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** One heatmap row. Memoised on what it actually draws (server identity/status, cells, stamps, label) so the
 *  page's 5s poll - which rebuilds the matrix with new object identities but usually identical data - does not
 *  rebuild ~30 cell divs and their t() interpolations per row. `t`/router are read inside, so a locale change
 *  still repaints (label/noData/stamps change with it). */
const HeatRowView = memo(
  function HeatRowView({ hr, stamps, label, noData }: { hr: HeatRow; stamps: string[]; label: string; noData: string }) {
    const t = useT();
    const push = useGuardedPush();
    const s = hr.row.server;
    const go = () => push(`/servers/${enc(s.id)}`);
    return (
      <div
        role="row"
        className="fleet-heat-row"
        data-testid="fleet-heat-row"
        data-server-id={s.id}
        aria-label={t("fleet.heatRow", {
          server: s.name,
          latest: hr.latest === null ? noData : pctText(hr.latest),
          peak: hr.peak === null ? noData : pctText(hr.peak),
        })}
      >
        <div role="rowheader" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <StatusDot status={s.status} />
          <Link
            href={`/servers/${enc(s.id)}`}
            className="fleet-heat-name"
            style={{ textDecoration: "none", fontWeight: 600, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {s.name}
          </Link>
        </div>
        <div className="fleet-heat-strip" onClick={go}>
          {hr.cells.map((v, i) => {
            const text =
              v === null
                ? t("fleet.heatCellEmpty", { server: s.name, time: stamps[i] })
                : t("fleet.heatCell", { server: s.name, time: stamps[i], metric: label, value: pctText(v) });
            return v === null ? (
              <div key={i} role="cell" className="fleet-heat-cell fleet-heat-empty" data-testid="fleet-heat-cell" data-empty="true" title={text} aria-label={text} />
            ) : (
              <div
                key={i}
                role="cell"
                className="fleet-heat-cell"
                data-testid="fleet-heat-cell"
                data-step={heatStep(v)}
                data-value={v}
                title={text}
                aria-label={text}
                style={{ background: `var(--heat-${heatStep(v)})` }}
              />
            );
          })}
        </div>
      </div>
    );
  },
  (a, b) =>
    a.label === b.label &&
    a.noData === b.noData &&
    a.hr.latest === b.hr.latest &&
    a.hr.peak === b.hr.peak &&
    a.hr.row.server.id === b.hr.row.server.id &&
    a.hr.row.server.name === b.hr.row.server.name &&
    a.hr.row.server.status === b.hr.row.server.status &&
    sameCells(a.hr.cells, b.hr.cells) &&
    sameStamps(a.stamps, b.stamps),
);

/** Fleet heatmap: one ROW per server, one COLUMN per minute of the batch trend, each cell coloured by the
 *  metric on a fixed 0-100 single-hue sequential ramp -> "which server was hot, and when" and fleet-wide
 *  correlated spikes at a glance. Built from the already-fetched trend (no per-server requests); the matrix is
 *  memoised and the cells are plain divs (no component per cell). Colour is never the only channel: every cell
 *  carries a title + aria-label with server, time and exact value, and "no data" is a hatched cell. */
export function FleetHeatmap({
  rows,
  metric,
  trends,
  loading = false,
}: {
  rows: FleetRow[];
  metric: WallMetric;
  trends?: Map<string, FleetTrendRow>;
  /** The trend query's first fetch is in flight: show a skeleton, not "No recent data". */
  loading?: boolean;
}) {
  const t = useT();
  const [limit, setLimit] = useState(HEAT_PAGE);
  const heat = useMemo(() => buildHeatmap(rows, trends, metric), [rows, trends, metric]);

  if (rows.length === 0) {
    return (
      <Card style={{ padding: 24 }}>
        <div role="status">
          <EmptyState>{t("fleet.noMatch")}</EmptyState>
        </div>
      </Card>
    );
  }
  if (!heatHasTrend(metric)) {
    return (
      <Card style={{ padding: 24 }}>
        <div role="status" data-testid="fleet-heat-notrend">
          <EmptyState>{t("fleet.noTrendMetric")}</EmptyState>
        </div>
      </Card>
    );
  }
  if (heat.times.length === 0 && loading) {
    return (
      <Card style={{ padding: 24 }}>
        <div role="status" aria-busy="true" aria-label={t("fleet.heatLoading")} data-testid="fleet-heat-loading" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {Array.from({ length: Math.min(Math.max(rows.length, 3), 8) }, (_, i) => (
            <Skeleton key={i} height={22} />
          ))}
        </div>
      </Card>
    );
  }
  if (heat.times.length === 0) {
    return (
      <Card style={{ padding: 24 }}>
        <div role="status" data-testid="fleet-heat-notrend">
          <EmptyState>{t("fleet.noRecent")}</EmptyState>
        </div>
      </Card>
    );
  }

  const label = t(METRIC_LABEL_KEY[metric]);
  const spanMs = heat.times[heat.times.length - 1] - heat.times[0];
  const n = heat.times.length;
  // Cells are centred at (i + 0.5) / n of the strip, so snap each tick to its column index and centre on that.
  const ticks = pickTimeTicks(heat.times, Math.min(4, n)).map((tk) => {
    const idx = Math.min(n - 1, Math.max(0, Math.round(tk.frac * (n - 1))));
    return { ts: heat.times[idx], left: (idx + 0.5) / n };
  });
  const shown = heat.rows.slice(0, limit);
  const noData = t("fleet.heatNoData");
  const stamps = heat.times.map((ts) => formatStamp(ts, spanMs));

  return (
    <div>
      <div className="fleet-heat-legend" role="img" aria-label={`${t("fleet.heatLegend")}: ${label} 0% – 100%; ${noData}`}>
        <span aria-hidden="true">0%</span>
        {Array.from({ length: HEAT_STEPS }, (_, i) => (
          <span key={i} aria-hidden="true" className="fleet-heat-swatch" style={{ background: `var(--heat-${i})`, marginLeft: i === 0 ? 0 : -5 }} />
        ))}
        <span aria-hidden="true">100%</span>
        <span aria-hidden="true" className="fleet-heat-swatch fleet-heat-empty" style={{ marginLeft: 14 }} />
        <span aria-hidden="true">{noData}</span>
      </div>
      <div className="fleet-heat" role="table" aria-label={`${t("fleet.heatmap")} — ${label}`}>
        <div className="fleet-heat-inner" style={{ ["--heat-cols" as string]: heat.times.length } as React.CSSProperties}>
          <div className="fleet-heat-row" aria-hidden="true" style={{ contentVisibility: "visible" }}>
            <span />
            <div className="fleet-heat-axis">
              {ticks.map((tk, i) => (
                <span
                  key={i}
                  style={{
                    left: `${tk.left * 100}%`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {formatTick(tk.ts, spanMs)}
                </span>
              ))}
            </div>
          </div>
          <div role="rowgroup">
            {shown.map((hr) => (
              <HeatRowView key={hr.row.server.id} hr={hr} stamps={stamps} label={label} noData={noData} />
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontSize: 12.5, color: "var(--c-tx3)" }}>
        <span role="status" data-testid="fleet-heat-count">{t("fleet.heatShowing", { shown: shown.length, total: heat.rows.length })}</span>
        {shown.length < heat.rows.length && (
          <button
            type="button"
            className="fleet-chip"
            onClick={() => setLimit((l) => l + HEAT_PAGE)}
            style={{ all: "unset", cursor: "pointer", padding: "5px 11px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 12 }}
          >
            {t("fleet.heatShowMore")}
          </button>
        )}
      </div>
    </div>
  );
}
