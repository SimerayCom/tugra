"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes } from "../lib/fleet";
import { metricTone, type FleetRow } from "../lib/fleet-view";
import { wallSeries, wallValue, type WallMetric } from "../lib/fleet-wall";
import type { FleetTrendRow } from "../lib/types";
import { useT } from "../i18n/provider";
import { Card, EmptyState, StatusDot } from "./ui";
import { MetricChart } from "./charts";
import { MeterBar } from "./meter-bar";

const enc = encodeURIComponent;
const TONE_COLOR: Record<string, string> = { ok: "var(--c-tx)", warn: "var(--c-am)", crit: "var(--c-r)" };
const CHART_H = 72;
const POLL_INTERVAL_MS = 60_000; // trend points are per-minute → a wider gap is drawn as a break

const METRIC_LABEL_KEY: Record<WallMetric, string> = { cpu: "fleet.colCpu", mem: "fleet.colMem", disk: "fleet.colDisk", net: "fleet.colNet" };
const METRIC_COLOR: Record<WallMetric, string> = { cpu: "var(--c-a)", mem: "var(--c-lapis)", disk: "var(--c-a)", net: "var(--c-a)" };

/** Flip true once the element has scrolled near the viewport and keep it true (charts mount lazily so a
 *  200-server wall doesn't build 200 SVGs up front). No IntersectionObserver (tests/old browsers) → always on. */
function useSeen<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

const valueText = (metric: WallMetric, v: number | null) => (v === null ? "—" : metric === "net" ? `${fmtBytes(v)}/s` : `${v.toFixed(0)}%`);

/** Fleet metrics wall: small multiples, ONE compact card per server, all plotting the same metric so the
 *  fleet's shape reads at a glance. Built purely from the already-fetched rows + batch trend (no per-server
 *  requests). Each card's name is a stretched link (keyboard + mouse) to the server. */
export function FleetWall({
  rows,
  metric,
  trends,
}: {
  rows: FleetRow[];
  metric: WallMetric;
  trends?: Map<string, FleetTrendRow>;
}) {
  const t = useT();
  if (rows.length === 0) {
    return (
      <Card style={{ padding: 24 }}>
        <div role="status">
          <EmptyState>{t("fleet.noMatch")}</EmptyState>
        </div>
      </Card>
    );
  }
  const staleLabel = t("fleet.stale");
  return (
    <ul className="fleet-wall" aria-label={t("fleet.wall")}>
      {rows.map((r) => (
        <WallCard key={r.server.id} row={r} metric={metric} trend={trends?.get(r.server.id)} staleLabel={staleLabel} />
      ))}
    </ul>
  );
}

const WallCard = memo(
  function WallCard({ row, metric, trend, staleLabel }: { row: FleetRow; metric: WallMetric; trend?: FleetTrendRow; staleLabel: string }) {
    const t = useT();
    const s = row.server;
    const [ref, seen] = useSeen<HTMLLIElement>();
    const value = wallValue(row, metric);
    const series = useMemo(() => wallSeries(trend, metric), [trend, metric]); // grouping is per-server + memoized
    const label = t(METRIC_LABEL_KEY[metric]);
    const isPct = metric !== "net";
    const color = row.stale || value === null ? "var(--c-tx3)" : isPct ? TONE_COLOR[metricTone(value)] : "var(--c-tx)";

    return (
      <li ref={ref} className="fleet-wall-card" data-testid="fleet-wall-card" data-server-id={s.id} style={{ position: "relative", listStyle: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginBottom: 8 }}>
          <StatusDot status={s.status} />
          <Link
            href={`/servers/${enc(s.id)}`}
            className="fleet-namelink"
            style={{ color: "var(--c-tx)", textDecoration: "none", fontWeight: 600, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {s.name}
            {row.stale && <span className="sr-only"> — {staleLabel}</span>}
          </Link>
          <span className="mono" data-testid="fleet-wall-value" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color, whiteSpace: "nowrap" }}>
            <span className="sr-only">{label} </span>
            {valueText(metric, value)}
          </span>
        </div>
        <div style={{ minHeight: CHART_H + 26 }}>
          {series ? (
            seen ? (
              <MetricChart bare hideHeader interactive={false} data={series.values} times={series.times} label={label} color={METRIC_COLOR[metric]} height={CHART_H} interval={POLL_INTERVAL_MS} />
            ) : null
          ) : metric === "disk" ? (
            <div style={{ paddingTop: 6 }}>
              <MeterBar value={row.diskPct} tone={metricTone(row.diskPct)} text={valueText("disk", row.diskPct)} stale={row.stale} label={label} width="100%" grow />
              <Placeholder>{t("fleet.noTrendMetric")}</Placeholder>
            </div>
          ) : (
            <Placeholder>{metric === "net" ? t("fleet.noTrendMetric") : t("fleet.noRecent")}</Placeholder>
          )}
        </div>
      </li>
    );
  },
  (a, b) =>
    a.metric === b.metric &&
    a.staleLabel === b.staleLabel &&
    a.trend === b.trend &&
    a.row.server === b.row.server &&
    a.row.stale === b.row.stale &&
    a.row.cpu === b.row.cpu &&
    a.row.memPct === b.row.memPct &&
    a.row.diskPct === b.row.diskPct &&
    a.row.net === b.row.net,
);

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="fleet-wall-empty" style={{ marginTop: 8, fontSize: 11.5, color: "var(--c-tx3)" }}>
      {children}
    </div>
  );
}
