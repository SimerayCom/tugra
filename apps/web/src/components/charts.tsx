"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useT } from "../i18n/provider";

/** Compact trend line for table rows. `fixedMax` pins the top of the scale (e.g. 100 for a percent series)
 *  so a quiet host reads as a low flat line instead of being stretched to fill the cell. */
export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = "var(--c-a)",
  fixedMax,
  label,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fixedMax?: number;
  label?: string;
}) {
  const clean = data.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <span style={{ color: "var(--c-tx3)" }}>—</span>;
  const max = fixedMax ?? Math.max(...clean, 1);
  const min = fixedMax !== undefined ? 0 : Math.min(...clean, 0);
  const span = max - min || 1;
  const pts = clean
    .map((v, i) => {
      const x = (i / (clean.length - 1)) * width;
      const y = height - (Math.min(Math.max(v, min), max) - min) / span * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}


// ── pure helpers (exported for tests) ──────────────────────────────────────────────────────────────

/** A "nice" axis ceiling >= `max` (1 / 2 / 2.5 / 5 / 10 × 10^k) so an auto-scaled axis ends on a round
 *  number instead of an arbitrary window max. Non-positive / non-finite input → 1. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const f = max / base;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * base;
}

/** Axis number without a unit (the unit lives in the header) — compact so it fits the narrow Y gutter. */
export function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return Number(v.toFixed(1)).toString();
  return Number(v.toFixed(2)).toString();
}

/** Tick label for the X axis. Short windows show a clock time; medium windows (where several ticks fall on the
 *  same day and clock-only labels would collide, e.g. 24h → "14:05 … 14:05") add the day so each tick is unique;
 *  long windows show a short date. */
export function formatTick(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 12 * 3600_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 3 * 86400_000) return d.toLocaleString([], { day: "numeric", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Full timestamp for the tooltip (seconds only when the window is short enough for them to matter). */
export function formatStamp(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 2 * 3600_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Horizontal position (0..width) of each point: time-proportional when valid ascending timestamps are
 *  supplied (so gaps in the series show as gaps), else evenly spaced. A single point sits in the middle. */
export function pointXs(n: number, times: number[] | undefined, width: number): number[] {
  if (n === 0) return [];
  if (n === 1) return [width / 2];
  if (times && times.length === n && times.every((t) => Number.isFinite(t))) {
    const t0 = times[0];
    const span = times[n - 1] - t0;
    if (span > 0) return times.map((t) => Math.min(Math.max(((t - t0) / span) * width, 0), width));
  }
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * width);
}

/** `count` evenly spaced X-axis ticks across the series' time span: {frac 0..1 along the axis, ts}.
 *  Empty when timestamps are missing/invalid; a single point yields one centred tick. */
export function pickTimeTicks(times: number[] | undefined, count = 4): { frac: number; ts: number }[] {
  if (!times || times.length === 0 || !times.every((t) => Number.isFinite(t))) return [];
  const t0 = times[0];
  const t1 = times[times.length - 1];
  if (times.length === 1 || t1 <= t0) return [{ frac: 0.5, ts: t0 }];
  return Array.from({ length: count }, (_, i) => {
    const frac = i / (count - 1);
    return { frac, ts: t0 + frac * (t1 - t0) };
  });
}

/** Index of the point whose X is closest to `x`. */
export function nearestIndex(xs: number[], x: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Min / average / max of a series (null when empty). */
export function seriesStats(values: number[]): { min: number; avg: number; max: number } | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, avg: sum / values.length, max };
}


// ── v2 series model helpers (exported for tests) ───────────────────────────────────────────────────

/** How a series is drawn: a bare line, a line over a soft fill, or a segment of a stack. */
export type ChartSeriesKind = "line" | "area" | "stacked";

export interface ChartSeries {
  /** Stable identity (colour follows the key's slot, never the rank after empty series are dropped). */
  key: string;
  label: string;
  /** Overrides the categorical slot colour. */
  color?: string;
  /** One value per point (same length as the chart's time axis). NaN/undefined = no data at that point. */
  values: number[];
  /** Default: `area` for a lone series, `line` when several are overlaid. `stacked` series stack in order. */
  kind?: ChartSeriesKind;
  /** Overrides the chart's unit for this series' tooltip/table value. */
  unit?: string;
}

/** Number of categorical slots (`--chart-1..--chart-5`). Past the last slot a series falls back to a neutral
 *  grey ("Other") — hues are never cycled or generated. */
export const CHART_SLOTS = 5;

/** CSS colour for a 0-based categorical slot. */
export function seriesColor(slot: number): string {
  return slot >= 0 && slot < CHART_SLOTS ? `var(--chart-${slot + 1})` : "var(--c-tx3)";
}

/** True when at least one value is a finite number (the per-series hide-when-empty guard). */
export function seriesHasData(values: readonly number[] | undefined): boolean {
  return !!values && values.some((v) => Number.isFinite(v));
}

/** A step must exceed this many nominal intervals to count as a collection gap. The hub LTTB-downsamples long
 *  ranges to ~1000 points, whose spacing legitimately varies from ~0 to ~2x the bucket — 3x keeps that
 *  jitter from ever reading as a gap while a genuinely missing stretch (>= 3 buckets) still breaks the line. */
const GAP_FACTOR = 3;

/** `breakBefore[i]` is true when point i sits more than 3x the nominal sampling `interval` after point i-1.
 *  Gap detection is strictly OPT-IN: without an explicit positive `interval` nothing is inferred (a median-step
 *  guess false-flags every irregularly spaced, LTTB-downsampled series), so every index is `false`. */
export function detectGaps(times: number[] | undefined, interval?: number): boolean[] {
  if (!times) return [];
  const n = times.length;
  const out = new Array<boolean>(n).fill(false);
  if (!interval || !(interval > 0)) return out;
  for (let i = 1; i < n; i++) if (times[i] - times[i - 1] > interval * GAP_FACTOR) out[i] = true;
  return out;
}

/** Contiguous [start, end] (inclusive) index runs that are drawable: split wherever `ok(i)` is false or a
 *  gap breaks before i. */
export function buildRuns(n: number, breakBefore: boolean[], ok?: (i: number) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (ok && !ok(i)) {
      if (start >= 0) runs.push([start, i - 1]);
      start = -1;
    } else if (start >= 0 && breakBefore[i]) {
      runs.push([start, i - 1]);
      start = i;
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) runs.push([start, n - 1]);
  return runs;
}

/** A non-colour secondary encoding per categorical slot (SVG stroke-dasharray; slot 1 solid), so overlaid
 *  series stay distinguishable without colour in BOTH themes (WCAG 1.4.1). Past the last slot ("Other") gets
 *  its own sparse dotted pattern. */
const SERIES_DASH: (string | undefined)[] = [undefined, "8 4", "2 3", "10 3 2 3", "5 3 1 3 1 3"];
export function seriesDash(slot: number): string | undefined {
  return slot >= 0 && slot < SERIES_DASH.length ? SERIES_DASH[slot] : "1 4";
}

/** SVG path data for a line: one `M … L …` subpath per run (runs of a single point are skipped — drawn as dots). */
export function linePath(xs: number[], ys: number[], runs: [number, number][]): string {
  const parts: string[] = [];
  for (const [a, b] of runs) {
    if (b <= a) continue;
    let d = "";
    for (let i = a; i <= b; i++) d += `${i === a ? "M" : " L"} ${xs[i].toFixed(1)},${ys[i].toFixed(1)}`;
    parts.push(d);
  }
  return parts.join(" ");
}

/** A closed fill between an `upper` and a `lower` edge, one subpath per run. */
function bandPath(xs: number[], upper: number[], lower: number[], runs: [number, number][]): string {
  const parts: string[] = [];
  for (const [a, b] of runs) {
    if (b <= a) continue;
    const up: string[] = [];
    const lo: string[] = [];
    for (let i = a; i <= b; i++) {
      up.push(`${xs[i].toFixed(1)},${upper[i].toFixed(1)}`);
      lo.push(`${xs[i].toFixed(1)},${lower[i].toFixed(1)}`);
    }
    parts.push(`M ${up.join(" L ")} L ${lo.reverse().join(" L ")} Z`);
  }
  return parts.join(" ");
}

const Y_GUTTER = 34; // px reserved left of the plot for the Y-axis numbers
const PAD = 8; // px of vertical breathing room inside the plot
const FALLBACK_W = 600; // SSR / first-paint plot width until the real pixel width is measured

/** Measure an element's real pixel width (ResizeObserver) so the SVG is drawn at true pixels — strokes, dots
 *  and text stay undistorted. Falls back to `fallback` on the server, before the first measure, and where
 *  ResizeObserver/layout is unavailable (jsdom). */
/** useLayoutEffect on the client (so the real width lands before first paint — no distorted first frame),
 *  useEffect on the server where useLayoutEffect would warn. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function useElementWidth(fallback: number) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useIsoLayoutEffect(() => {
    if (!el) return;
    const apply = (px: number) => {
      if (px > 0) setWidth((cur) => (Math.abs(cur - px) < 0.5 ? cur : Math.round(px)));
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) apply(last.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

const CARD_STYLE = {
  background: "var(--c-sb)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r2)",
  padding: 16,
  minWidth: 0,
} as const;

/** Stable metric-card grid: cards never narrower than 420px (so ~2 per row on a desktop content area, 3 only on very
 *  wide screens, 1 on tablet/phone) with a fixed plot height so cards read wide-and-short, never square. */
export const METRIC_GRID_STYLE = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
} as const;
export const METRIC_CHART_HEIGHT = 160;

const finite = (v: number) => Number.isFinite(v);

type Item = { key: string; label: string; color: string; kind: ChartSeriesKind; unit: string; vals: number[]; dash?: string };

/** True when at least one stacked series has a finite value at i (else the stack has "no data" there). */
const stackPresentAt = (its: Item[], i: number) => its.some((it) => it.kind === "stacked" && finite(it.vals[i]));

function ToggleButton({ pressed, onClick, children, label }: { pressed: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      style={{
        font: "inherit",
        fontSize: 10.5,
        lineHeight: "14px",
        padding: "2px 8px",
        minHeight: 22,
        cursor: "pointer",
        border: "1px solid var(--c-bd)",
        borderRadius: 6,
        background: pressed ? "var(--c-ad)" : "transparent",
        color: pressed ? "var(--c-tx)" : "var(--c-tx2)",
        fontWeight: pressed ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

/** Uniform card shell for a chart: title + optional one-line plain-language description + body + an optional
 *  corner controls slot. Host a `<MetricChart bare …>` inside so every chart reads as one system. */
export function ChartCard({
  title,
  description,
  controls,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const uid = useId().replace(/:/g, "");
  return (
    <section aria-labelledby={`cc${uid}`} style={CARD_STYLE}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div id={`cc${uid}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>
            {title}
          </div>
          {description && <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--c-tx3)", marginTop: 2 }}>{description}</div>}
        </div>
        {controls && <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>{controls}</div>}
      </div>
      {children}
    </section>
  );
}

export function MetricChart({
  data,
  series: seriesProp,
  label,
  unit = "%",
  color = "var(--c-a)",
  height = 140,
  decimals = 0,
  times,
  peaks,
  interval,
  peakToggle = false,
  tableToggle = false,
  bare = false,
  interactive = true,
  hideHeader = false,
}: {
  /** Legacy single series. Ignored when a non-empty `series` is given. */
  data?: number[];
  /** v2: one or more series (overlay line/area and/or stacked). Entirely-empty series are dropped. */
  series?: ChartSeries[];
  label: string;
  unit?: string;
  /** The colour of a single-series chart. Multi-series charts take `--chart-N` slot colours. */
  color?: string;
  height?: number;
  decimals?: number;
  /** Unix-ms timestamp per point (same length as the series) → enables the time X-axis + timestamped tooltip. */
  times?: number[];
  /** Optional per-point PEAK (same length as a SINGLE series, e.g. the stored per-minute max CPU of a 7d/30d
   *  rollup read) → drawn as a faint band above the average line. */
  peaks?: number[];
  /** Nominal sampling interval in ms. OPT-IN gap-as-break: only when given, a step > 3x this breaks the line and
   *  shades the gap. Never inferred — without it no time gap is drawn (LTTB-downsampled reads are irregular).
   *  A NaN/missing point inside a v2 `series` breaks the line regardless. */
  interval?: number;
  /** Show an Avg | Peak control when `peaks` are present (default Avg). */
  peakToggle?: boolean;
  /** Show a "View as table" toggle (off by default) — an accessible table of the values. */
  tableToggle?: boolean;
  /** Drop the outer card chrome (border/padding) so the chart can live inside a `ChartCard`. */
  bare?: boolean;
  /** Default true. When false the plot is a static drawing: no `role="slider"`, no tab stop, no keyboard/pointer
   *  hover handlers (for dense small-multiple grids where each chart would otherwise add a same-named tab stop). */
  interactive?: boolean;
  /** Default false. When true the chart's own header row (label, axis-max tag, latest value, controls) is not
   *  drawn — only the plot + axes — for callers that already show the value elsewhere. */
  hideHeader?: boolean;
}) {
  const t = useT();
  const [setPlotEl, width] = useElementWidth(FALLBACK_W);
  const uid = useId().replace(/:/g, ""); // colons in useId break an SVG url(#…) reference
  const [active, setActive] = useState<number | null>(null);
  const [mode, setMode] = useState<"avg" | "peak">("avg");
  const [tableView, setTableView] = useState(false);

  // ── Normalise BOTH the legacy `data` path and the v2 `series` path into one series model ───────────
  // Legacy: a series may carry undefined/NaN (e.g. an older agent that omits a newer metric field, whose live
  // SSE sample reaches the chart unmapped). Coerce to 0 so `.toFixed()` and the SVG path never see a
  // non-finite value and crash the whole tab. v2 keeps NaN as "no data" (the line breaks there).
  const { items, n } = useMemo((): { items: Item[]; n: number } => {
    if (seriesProp && seriesProp.length > 0) {
      const kept: { s: ChartSeries; slot: number }[] = [];
      seriesProp.forEach((s, slot) => {
        if (seriesHasData(s.values)) kept.push({ s, slot });
      });
      const len = kept.reduce((m, k) => Math.max(m, k.s.values.length), 0);
      const lone = seriesProp.length === 1;
      return {
        n: len,
        items: kept.map(({ s, slot }) => ({
          key: s.key,
          label: s.label,
          color: s.color ?? (lone ? color : seriesColor(slot)),
          kind: s.kind ?? (kept.length === 1 ? "area" : "line"),
          unit: s.unit ?? unit,
          dash: lone ? undefined : seriesDash(slot),
          vals: Array.from({ length: len }, (_, i) => (finite(s.values[i]) ? s.values[i] : NaN)),
        })),
      };
    }
    const clean = (data ?? []).map((v) => (finite(v) ? v : 0));
    return { n: clean.length, items: [{ key: "value", label, color, kind: "area", unit, vals: clean }] };
  }, [seriesProp, data, label, color, unit]);

  const lone = items.length <= 1;
  const cleanPeaks = useMemo(() => {
    if (!peaks || peaks.length !== n || items.length !== 1) return undefined;
    const base = items[0].vals;
    return peaks.map((v, i) => (finite(base[i]) ? (finite(v) ? Math.max(v, base[i]) : base[i]) : NaN));
  }, [peaks, items, n]);
  const showPeak = peakToggle && !!cleanPeaks && mode === "peak";
  const plotItems = useMemo(() => (showPeak && cleanPeaks ? [{ ...items[0], vals: cleanPeaks }] : items), [showPeak, cleanPeaks, items]);

  const validTimes = times && times.length === n && times.every((x) => Number.isFinite(x)) ? times : undefined;
  const spanMs = validTimes && n > 1 ? validTimes[n - 1] - validTimes[0] : 0;
  const timeBreak = useMemo(() => detectGaps(validTimes, interval), [validTimes, interval]);
  const xs = useMemo(() => pointXs(n, validTimes, width), [n, validTimes, width]);

  // Y scale: percent metrics are ALWAYS 0–100 so an idle series sits LOW with the frame visible (the Beszel
  // look); every other unit (rates, bytes) auto-scales to a round ceiling over the window's max (stack totals
  // and peaks included). Container CPU is a per-core docker stat that exceeds 100% on multi-core hosts, so a
  // percent series ABOVE 100 auto-extends to a round ceiling instead of clipping.
  const geo = useMemo(() => {
    const plotH = height - PAD * 2;
    const baseY = PAD + plotH;
    const isPct = unit === "%";
    const stackedIdx: number[] = [];
    plotItems.forEach((it, k) => {
      if (it.kind === "stacked") stackedIdx.push(k);
    });
    // cumulative edges of the stack, in series order (bottom first)
    const lowerOf: Record<number, number[]> = {};
    const upperOf: Record<number, number[]> = {};
    let acc: number[] = new Array<number>(n).fill(0);
    for (const k of stackedIdx) {
      const vals = plotItems[k].vals;
      lowerOf[k] = acc;
      acc = acc.map((a, i) => a + (finite(vals[i]) ? vals[i] : 0));
      upperOf[k] = acc;
    }
    let dataMax = 0;
    for (const it of plotItems) if (it.kind !== "stacked") for (const v of it.vals) if (finite(v) && v > dataMax) dataMax = v;
    for (const v of acc) if (stackedIdx.length && v > dataMax) dataMax = v;
    if (cleanPeaks && !showPeak) for (const v of cleanPeaks) if (finite(v) && v > dataMax) dataMax = v;
    const axisMax = isPct ? (dataMax > 100 ? niceMax(dataMax) : 100) : niceMax(dataMax);
    const yOf = (v: number) => PAD + (1 - Math.min(Math.max(v, 0), axisMax) / axisMax) * plotH;

    const entries = plotItems.map((it, k) => {
      const stacked = it.kind === "stacked";
      // A stack breaks where EVERY stacked series is missing (never drawn as a real-looking zero).
      const runs = stacked ? buildRuns(n, timeBreak, (i) => stackPresentAt(plotItems, i)) : buildRuns(n, timeBreak, (i) => finite(it.vals[i]));
      const top = n && xs.length === n ? (stacked ? upperOf[k] : it.vals).map((v) => (finite(v) ? yOf(v) : NaN)) : [];
      const dots = runs.filter(([a, b]) => a === b).map(([a]) => a);
      let lineD = "";
      let areaD = "";
      let bandD = "";
      if (top.length === n && n > 0) {
        if (stacked) {
          const lo = lowerOf[k].map((v) => yOf(v));
          areaD = bandPath(xs, top, lo, runs);
        } else {
          lineD = linePath(xs, top, runs);
          if (it.kind === "area") {
            areaD = runs
              .filter(([a, b]) => b > a)
              .map(([a, b]) => {
                const pts: string[] = [];
                for (let i = a; i <= b; i++) pts.push(`L ${xs[i].toFixed(1)},${top[i].toFixed(1)}`);
                return `M ${xs[a].toFixed(1)},${baseY} ${pts.join(" ")} L ${xs[b].toFixed(1)},${baseY} Z`;
              })
              .join(" ");
          }
          if (cleanPeaks && !showPeak && plotItems.length === 1) {
            const up = cleanPeaks.map((v) => (finite(v) ? yOf(v) : NaN));
            bandD = bandPath(xs, up, top, runs);
          }
        }
      }
      return { item: it, stacked, runs, top, dots, lineD, areaD, bandD };
    });
    const gaps: [number, number][] = [];
    for (let i = 1; i < n; i++) if (timeBreak[i] && xs[i] !== undefined) gaps.push([xs[i - 1], xs[i]]);
    return { plotH, baseY, axisMax, entries, gaps, hasStack: stackedIdx.length > 0 };
  }, [plotItems, n, height, unit, cleanPeaks, showPeak, timeBreak, xs]);
  const { plotH, baseY, axisMax, entries, gaps, hasStack } = geo;

  const gridFracs = [0, 0.25, 0.5, 0.75, 1];
  const stats = useMemo(() => {
    if (!lone) return null;
    const vals = items[0] ? items[0].vals.filter(finite) : [];
    return seriesStats(vals);
  }, [lone, items]);
  const ticks = useMemo(() => pickTimeTicks(validTimes), [validTimes]);
  const fmt = (v: number) => `${v.toFixed(decimals)}${unit}`;
  const fmtItem = (it: Item, v: number) => (finite(v) ? `${v.toFixed(decimals)}${it.unit}` : "—");

  const idx = active !== null && active < n ? active : null;
  const hoverFrac = idx !== null && xs[idx] !== undefined ? xs[idx] / width : 0;
  const stamp = (i: number) => (validTimes ? formatStamp(validTimes[i], spanMs) : "");
  const stackHas = (i: number) => stackPresentAt(plotItems, i);
  const totalAt = (i: number) => plotItems.reduce((s, it) => s + (it.kind === "stacked" && finite(it.vals[i]) ? it.vals[i] : 0), 0);
  /** Per-series values at point i, largest first (the multi-series tooltip order). */
  const rowsAt = (i: number) =>
    plotItems
      .map((it) => ({ it, v: it.vals[i] }))
      .filter((r) => finite(r.v))
      .sort((a, b) => b.v - a.v);
  const lastOf = (vals: number[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (finite(vals[i])) return vals[i];
    return 0;
  };
  const valueText = (i: number) => {
    if (!lone) {
      const parts = rowsAt(i).map((r) => `${r.it.label} ${fmtItem(r.it, r.v)}`);
      if (hasStack && stackHas(i)) parts.push(`${t("charts.total")} ${fmt(totalAt(i))}`);
      if (parts.length === 0) parts.push(t("charts.noPoint"));
      if (validTimes) parts.push(stamp(i));
      return parts.join(" · ");
    }
    const v = plotItems[0].vals[i];
    const base = finite(v) ? fmtItem(plotItems[0], v) : t("charts.noPoint");
    const peak = cleanPeaks && !showPeak && cleanPeaks[i] > items[0].vals[i] ? ` · ${t("charts.peak")} ${fmt(cleanPeaks[i])}` : "";
    return validTimes ? `${base}${peak} · ${stamp(i)}` : `${base}${peak}`;
  };

  const moveToClientX = (e: PointerEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    setActive(nearestIndex(xs, frac * width));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const step = e.shiftKey ? 10 : 1;
    const cur = idx ?? n - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(cur - step, 0);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(cur + step, n - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const hasPeakToggle = peakToggle && !!cleanPeaks;
  const controls =
    hasPeakToggle || tableToggle ? (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {hasPeakToggle && (
          <div role="group" aria-label={t("charts.valueMode")} style={{ display: "flex", gap: 2 }}>
            <ToggleButton pressed={mode === "avg"} onClick={() => setMode("avg")}>
              {t("charts.avg")}
            </ToggleButton>
            <ToggleButton pressed={mode === "peak"} onClick={() => setMode("peak")}>
              {t("charts.peak")}
            </ToggleButton>
          </div>
        )}
        {tableToggle && (
          <ToggleButton pressed={tableView} onClick={() => setTableView((v) => !v)} label={t("charts.viewAsTable")}>
            {t("charts.table")}
          </ToggleButton>
        )}
      </div>
    ) : null;

  // Header value: a lone series shows its latest value in its colour (as before); a stack shows its total;
  // overlaid series carry their values in the legend/tooltip instead.
  const headerValue = lone ? (
    <span style={{ fontSize: 18, fontWeight: 700, color: plotItems[0]?.color ?? color, whiteSpace: "nowrap" }} className="mono">
      {!plotItems[0]
        ? (0).toFixed(decimals)
        : plotItems[0].vals.length > 0 && !finite(plotItems[0].vals[plotItems[0].vals.length - 1])
          ? "—"
          : lastOf(plotItems[0].vals).toFixed(decimals)}
      {unit}
    </span>
  ) : hasStack ? (
    <span data-testid="chart-total" style={{ fontSize: 18, fontWeight: 700, color: "var(--c-tx)", whiteSpace: "nowrap" }} className="mono">
      {stackHas(n - 1) ? fmt(totalAt(n - 1)) : "—"}
    </span>
  ) : null;

  const noData = n === 0;
  // A lone series with no controls keeps the original non-wrapping header (the 260-280px caller cards).
  const legacyHeader = lone && !controls;

  return (
    <div style={bare ? { minWidth: 0 } : CARD_STYLE}>
      {!hideHeader && (
        <div
          style={
            legacyHeader
              ? { display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 8 }
              : { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", marginBottom: 8, gap: 8 }
          }
        >
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{label}</span>
            <span style={{ fontSize: 10, color: "var(--c-tx3)" }} className="mono">
              {axisMax.toFixed(decimals)}
              {unit}
            </span>
          </span>
          {legacyHeader ? (
            headerValue
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {controls}
              {headerValue}
            </span>
          )}
        </div>
      )}
      {!lone && (
        <ul
          data-testid="chart-legend"
          aria-label={t("charts.legend")}
          style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", margin: "0 0 8px", padding: 0, listStyle: "none", fontSize: 11, color: "var(--c-tx2)" }}
        >
          {items.map((it) => (
            <li key={it.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {it.kind === "stacked" ? (
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: it.color, flexShrink: 0 }} />
              ) : (
                <svg aria-hidden="true" data-testid="chart-legend-swatch" data-dash={it.dash ?? "solid"} width={20} height={10} style={{ flexShrink: 0 }}>
                  <line x1={0} x2={20} y1={5} y2={5} stroke={it.color} strokeWidth={2} strokeDasharray={it.dash} />
                </svg>
              )}
              <span>{it.label}</span>
              <span className="mono" data-testid="chart-legend-value" style={{ color: "var(--c-tx)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {fmtItem(it, it.vals[idx ?? n - 1])}
              </span>
            </li>
          ))}
        </ul>
      )}
      {tableView ? (
        <div
          role="region"
          aria-label={label}
          tabIndex={0}
          style={{ maxHeight: Math.max(height, 180), overflow: "auto", border: "1px solid var(--c-bd)", borderRadius: 6 }}
        >
          <table data-testid="chart-table" aria-label={`${label} — ${t("charts.table")}`} style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                {[validTimes ? t("charts.time") : t("charts.point"), ...items.map((it) => it.label), ...(cleanPeaks ? [t("charts.peak")] : [])].map((h, i) => (
                  <th
                    key={i}
                    scope="col"
                    style={{ position: "sticky", top: 0, background: "var(--c-sb)", textAlign: i === 0 ? "left" : "right", padding: "4px 8px", fontWeight: 600, color: "var(--c-tx2)", borderBottom: "1px solid var(--c-bd)", whiteSpace: "nowrap" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: n }, (_, i) => (
                <Fragment key={i}>
                  {timeBreak[i] && (
                    <tr data-testid="chart-table-gap">
                      <td colSpan={1 + items.length + (cleanPeaks ? 1 : 0)} style={{ padding: "2px 8px", fontSize: 10, color: "var(--c-tx3)", fontStyle: "italic" }}>
                        {t("charts.gap")}
                      </td>
                    </tr>
                  )}
                <tr>
                  <th scope="row" style={{ textAlign: "left", padding: "3px 8px", fontWeight: 400, color: "var(--c-tx3)", whiteSpace: "nowrap" }}>
                    {validTimes ? stamp(i) : i + 1}
                  </th>
                  {items.map((it) => (
                    <td key={it.key} className="mono" style={{ textAlign: "right", padding: "3px 8px", color: "var(--c-tx)", fontVariantNumeric: "tabular-nums" }}>
                      {fmtItem(it, it.vals[i])}
                    </td>
                  ))}
                  {cleanPeaks && (
                    <td className="mono" style={{ textAlign: "right", padding: "3px 8px", color: "var(--c-tx)", fontVariantNumeric: "tabular-nums" }}>
                      {finite(cleanPeaks[i]) ? fmt(cleanPeaks[i]) : "—"}
                    </td>
                  )}
                </tr>
                </Fragment>
              ))}
              {noData && (
                <tr>
                  <td colSpan={items.length + 2} style={{ padding: 8, color: "var(--c-tx3)" }}>
                    {t("charts.noData")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6 }}>
            <div aria-hidden="true" style={{ position: "relative", width: Y_GUTTER, height, flexShrink: 0 }}>
              {[0, 0.5, 1].map((f) => (
                <span
                  key={f}
                  className="mono"
                  style={{ position: "absolute", right: 0, top: PAD + f * plotH - 6, fontSize: 9.5, lineHeight: "12px", color: "var(--c-tx3)" }}
                >
                  {fmtAxis(axisMax * (1 - f))}
                </span>
              ))}
            </div>
            <div
              ref={setPlotEl}
              {...(interactive
                ? {
                    role: "slider",
                    tabIndex: 0,
                    "aria-label": label,
                    "aria-orientation": "horizontal" as const,
                    "aria-valuemin": 0,
                    "aria-valuemax": Math.max(n - 1, 0),
                    "aria-valuenow": idx ?? Math.max(n - 1, 0),
                    "aria-valuetext": n === 0 ? t("charts.noData") : valueText(idx ?? n - 1),
                    onPointerMove: moveToClientX,
                    onPointerDown: moveToClientX,
                    onPointerLeave: (e: PointerEvent<HTMLDivElement>) => {
                      if (e.pointerType === "mouse") setActive(null);
                    },
                    onFocus: () => setActive((a) => a ?? (n ? n - 1 : null)),
                    onBlur: () => setActive(null),
                    onKeyDown,
                  }
                : {})}
              style={{ position: "relative", flex: 1, minWidth: 0, height, touchAction: "pan-y", cursor: interactive && n ? "crosshair" : "default", borderRadius: 4 }}
            >
              {/* True-pixel drawing: the viewBox is the MEASURED pixel width, so 1 user unit = 1 CSS px — strokes,
                  dots and the hover marker are never stretched. */}
              <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: "block", height, overflow: "visible" }} aria-hidden="true">
                <defs>
                  {entries.map((e, k) =>
                    e.item.kind === "area" ? (
                      <linearGradient key={k} id={`g${uid}${k}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={e.item.color} stopOpacity={entries.length > 1 ? 0.2 : 0.35} />
                        <stop offset="100%" stopColor={e.item.color} stopOpacity={0.02} />
                      </linearGradient>
                    ) : null,
                  )}
                </defs>
                <rect x={0} y={0} width={width} height={height} fill="color-mix(in srgb, var(--c-bd) 18%, transparent)" />
                {gridFracs.map((f) => {
                  const gy = PAD + f * plotH;
                  return <line key={f} x1={0} x2={width} y1={gy} y2={gy} stroke="var(--c-bd)" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />;
                })}
                {gaps.map(([x0, x1], i) => (
                  <rect
                    key={i}
                    data-testid="chart-gap"
                    aria-hidden="true"
                    x={x0}
                    y={PAD}
                    width={Math.max(x1 - x0, 0)}
                    height={plotH}
                    fill="color-mix(in srgb, var(--c-tx3) 12%, transparent)"
                  />
                ))}
                {entries.map((e, k) => (
                  <g key={e.item.key + k}>
                    {e.bandD && <path data-testid="chart-peak-band" d={e.bandD} fill={e.item.color} fillOpacity={0.14} stroke="none" />}
                    {e.areaD && e.stacked && (
                      <path data-testid={`chart-stack-${e.item.key}`} d={e.areaD} fill={e.item.color} fillOpacity={0.9} stroke="var(--c-sb)" strokeWidth={1.5} strokeLinejoin="round" />
                    )}
                    {e.areaD && !e.stacked && <path d={e.areaD} fill={`url(#g${uid}${k})`} stroke="none" />}
                    {e.lineD && (
                      <path data-testid={`chart-line-${e.item.key}`} d={e.lineD} fill="none" stroke={e.item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap={e.item.dash ? "butt" : "round"} strokeDasharray={e.item.dash} />
                    )}
                    {!e.stacked && e.dots.map((i) => <circle key={i} cx={xs[i]} cy={e.top[i]} r={4} fill={e.item.color} />)}
                  </g>
                ))}
                {idx !== null && xs[idx] !== undefined && (
                  <>
                    <line data-testid="chart-crosshair" x1={xs[idx]} x2={xs[idx]} y1={PAD} y2={baseY} stroke="var(--c-tx3)" strokeWidth={1} />
                    {entries.map((e, k) =>
                      finite(e.top[idx]) ? (
                        <circle key={k} data-testid="chart-hover-dot" cx={xs[idx]} cy={e.top[idx]} r={4} fill={e.item.color} stroke="var(--c-sb)" strokeWidth={2} />
                      ) : null,
                    )}
                  </>
                )}
              </svg>
              {n === 0 && (
                <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--c-tx3)" }}>
                  {t("charts.noData")}
                </span>
              )}
              {idx !== null && (
                <div
                  data-testid="chart-tooltip"
                  style={{
                    position: "absolute",
                    left: `${hoverFrac * 100}%`,
                    top: 0,
                    transform: `translate(${hoverFrac < 0.18 ? "0" : hoverFrac > 0.82 ? "-100%" : "-50%"}, -4px)`,
                    background: "var(--c-el)",
                    border: "1px solid var(--c-bd)",
                    borderRadius: 6,
                    padding: "4px 8px",
                    fontSize: 11,
                    lineHeight: 1.35,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,.25)",
                    zIndex: 2,
                  }}
                >
                  {lone ? (
                    <>
                      <div className="mono" style={{ fontWeight: 700, color: plotItems[0].color, fontVariantNumeric: "tabular-nums" }}>{fmtItem(plotItems[0], plotItems[0].vals[idx])}</div>
                      {cleanPeaks && !showPeak && cleanPeaks[idx] > items[0].vals[idx] && (
                        <div className="mono" style={{ color: "var(--c-tx2)" }}>{`${t("charts.peak")} ${fmt(cleanPeaks[idx])}`}</div>
                      )}
                      {showPeak && cleanPeaks && (
                        <div className="mono" style={{ color: "var(--c-tx2)" }}>{`${t("charts.avg")} ${fmtItem(items[0], items[0].vals[idx])}`}</div>
                      )}
                    </>
                  ) : (
                    <>
                      {rowsAt(idx).map((r) => (
                        <div key={r.it.key} data-testid="chart-tooltip-row" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: r.it.color, flexShrink: 0 }} />
                          <span style={{ color: "var(--c-tx2)", flex: 1 }}>{r.it.label}</span>
                          <span className="mono" style={{ color: "var(--c-tx)", fontWeight: 600, fontVariantNumeric: "tabular-nums", marginLeft: 12 }}>{fmtItem(r.it, r.v)}</span>
                        </div>
                      ))}
                      {rowsAt(idx).length === 0 && (
                        <div data-testid="chart-tooltip-nodata" className="mono" style={{ color: "var(--c-tx2)" }}>{t("charts.noPoint")}</div>
                      )}
                      {hasStack && stackHas(idx) && (
                        <div data-testid="chart-tooltip-total" style={{ display: "flex", gap: 6, marginTop: 2, paddingTop: 2, borderTop: "1px solid var(--c-bd)" }}>
                          <span style={{ color: "var(--c-tx2)", flex: 1, marginLeft: 14 }}>{t("charts.total")}</span>
                          <span className="mono" style={{ color: "var(--c-tx)", fontWeight: 700, fontVariantNumeric: "tabular-nums", marginLeft: 12 }}>{fmt(totalAt(idx))}</span>
                        </div>
                      )}
                    </>
                  )}
                  {validTimes && <div style={{ color: "var(--c-tx3)" }}>{stamp(idx)}</div>}
                </div>
              )}
            </div>
          </div>
          {ticks.length > 0 && (
            <div aria-hidden="true" data-testid="chart-xaxis" style={{ position: "relative", height: 14, marginTop: 4, marginLeft: Y_GUTTER + 6, overflow: "hidden" }}>
              {ticks.map((tk, i) => (
                <span
                  key={i}
                  className="mono"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: `${tk.frac * 100}%`,
                    transform: `translateX(${tk.frac <= 0 ? "0" : tk.frac >= 1 ? "-100%" : "-50%"})`,
                    fontSize: 9.5,
                    lineHeight: "14px",
                    color: "var(--c-tx3)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatTick(tk.ts, spanMs)}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {stats && (
        <div data-testid="chart-stats" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, fontSize: 11, color: "var(--c-tx3)" }} className="mono">
          <span>{`${t("charts.min")} ${fmt(stats.min)}`}</span>
          <span>{`${t("charts.avg")} ${fmt(stats.avg)}`}</span>
          <span>{`${t("charts.max")} ${fmt(cleanPeaks ? Math.max(stats.max, ...cleanPeaks.filter(finite)) : stats.max)}`}</span>
        </div>
      )}
    </div>
  );
}
